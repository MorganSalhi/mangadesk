import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { Source } from '../types'

// ============================================================================
// Store Téléchargements (session 3).
//
// Contrat critique : Rust ne peut pas appeler les sources JS. Le backend émet
// `download:fetch-pages` ; ce store résout la source via `getSource(sourceId)`,
// appelle `source.getPageList`, puis renvoie les URLs à Rust via
// `provide_download_pages`. La progression remonte par events.
// ============================================================================

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'error'

export interface DownloadTask {
  chapterId: string
  mangaId: string
  sourceId: string
  status: DownloadStatus
  progress: number
  total: number
  localPath: string | null
  error?: string | null
}

interface DownloadState {
  queue: DownloadTask[]
  listenersReady: boolean
  // Actions
  enqueueDownload(chapterId: string, mangaId: string, sourceId: string): Promise<void>
  pauseDownload(chapterId: string): Promise<void>
  resumeDownload(chapterId: string): Promise<void>
  cancelDownload(chapterId: string): Promise<void>
  clearCompleted(): void
  refreshQueue(): Promise<void>
  // Listeners (appelés une fois au montage de l'app)
  initListeners(getSource: (sourceId: string) => Source | null): void
}

function upsert(queue: DownloadTask[], patch: DownloadTask): DownloadTask[] {
  const idx = queue.findIndex((t) => t.chapterId === patch.chapterId)
  if (idx === -1) return [...queue, patch]
  const next = [...queue]
  next[idx] = { ...next[idx], ...patch }
  return next
}

function patchTask(
  queue: DownloadTask[],
  chapterId: string,
  patch: Partial<DownloadTask>,
): DownloadTask[] {
  return queue.map((t) => (t.chapterId === chapterId ? { ...t, ...patch } : t))
}

export const useDownloadStore = create<DownloadState>((set, get) => ({
  queue: [],
  listenersReady: false,

  enqueueDownload: async (chapterId, mangaId, sourceId) => {
    // Tâche optimiste (la confirmation arrive via `download:queued`).
    set((s) => ({
      queue: upsert(s.queue, {
        chapterId,
        mangaId,
        sourceId,
        status: 'queued',
        progress: 0,
        total: 0,
        localPath: null,
      }),
    }))
    try {
      await invoke('enqueue_download', { chapterId, mangaId, sourceId })
    } catch (e) {
      set((s) => ({
        queue: patchTask(s.queue, chapterId, { status: 'error', error: String(e) }),
      }))
    }
  },

  pauseDownload: async (chapterId) => {
    set((s) => ({ queue: patchTask(s.queue, chapterId, { status: 'paused' }) }))
    await invoke('pause_download', { chapterId }).catch(() => {})
  },

  resumeDownload: async (chapterId) => {
    set((s) => ({ queue: patchTask(s.queue, chapterId, { status: 'downloading' }) }))
    await invoke('resume_download', { chapterId }).catch(() => {})
  },

  cancelDownload: async (chapterId) => {
    set((s) => ({ queue: s.queue.filter((t) => t.chapterId !== chapterId) }))
    await invoke('cancel_download', { chapterId }).catch(() => {})
  },

  clearCompleted: () =>
    set((s) => ({ queue: s.queue.filter((t) => t.status !== 'completed') })),

  refreshQueue: async () => {
    try {
      const tasks = await invoke<DownloadTask[]>('get_download_queue')
      set({ queue: tasks })
    } catch {
      /* backend absent */
    }
  },

  initListeners: (getSource) => {
    if (get().listenersReady) return
    set({ listenersReady: true })

    // Résout les URLs de pages via la source JS et les renvoie à Rust.
    void listen<{ chapterId: string; mangaId: string; sourceId: string }>(
      'download:fetch-pages',
      async (event) => {
        const { chapterId, sourceId } = event.payload
        const source = getSource(sourceId)
        if (!source) {
          set((s) => ({
            queue: patchTask(s.queue, chapterId, {
              status: 'error',
              error: `Source inconnue : ${sourceId}`,
            }),
          }))
          return
        }
        try {
          const pages = await source.getPageList(chapterId)
          await invoke('provide_download_pages', {
            chapterId,
            pages: pages.map((p) => ({
              index: p.index,
              url: p.imageUrl,
              headers: p.headers ?? {},
            })),
          })
        } catch (e) {
          set((s) => ({
            queue: patchTask(s.queue, chapterId, { status: 'error', error: String(e) }),
          }))
        }
      },
    ).catch(() => {})

    void listen<{ chapterId: string }>('download:queued', (event) => {
      set((s) => ({
        queue: patchTask(s.queue, event.payload.chapterId, { status: 'queued' }),
      }))
    }).catch(() => {})

    void listen<{ chapterId: string; progress: number; total: number }>(
      'download:progress',
      (event) => {
        const { chapterId, progress, total } = event.payload
        set((s) => ({
          queue: patchTask(s.queue, chapterId, {
            status: 'downloading',
            progress,
            total,
          }),
        }))
      },
    ).catch(() => {})

    void listen<{ chapterId: string; localPath: string }>(
      'download:completed',
      async (event) => {
        const { chapterId, localPath } = event.payload
        set((s) => ({
          queue: patchTask(s.queue, chapterId, { status: 'completed', localPath }),
        }))
        const task = get().queue.find((t) => t.chapterId === chapterId)
        // Persiste l'état terminé en base (badges bibliothèque, lecteur local).
        await invoke('record_download', {
          chapterId,
          mangaId: task?.mangaId ?? '',
          status: 'completed',
          totalPages: task?.total ?? null,
          localPath,
        }).catch(() => {})
      },
    ).catch(() => {})

    void listen<{ chapterId: string; error: string }>('download:error', (event) => {
      set((s) => ({
        queue: patchTask(s.queue, event.payload.chapterId, {
          status: 'error',
          error: event.payload.error,
        }),
      }))
    }).catch(() => {})
  },
}))
