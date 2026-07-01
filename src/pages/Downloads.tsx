import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import {
  useDownloadStore,
  type DownloadStatus,
  type DownloadTask,
} from '../store/downloadStore'

// ============================================================================
// Page Téléchargements — file d'attente temps réel (events Rust), avec
// pause / reprise / annulation et export CBZ des chapitres terminés.
// ============================================================================

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: 'En attente',
  downloading: 'Téléchargement',
  paused: 'En pause',
  completed: 'Terminé',
  error: 'Erreur',
}

const STATUS_COLOR: Record<DownloadStatus, string> = {
  queued: 'text-content-3',
  downloading: 'text-accent',
  paused: 'text-amber-400',
  completed: 'text-green-400',
  error: 'text-red-400',
}

async function exportCbz(task: DownloadTask): Promise<void> {
  try {
    const outputPath = await save({
      defaultPath: `${task.chapterId}.cbz`,
      filters: [{ name: 'Comic Book ZIP', extensions: ['cbz'] }],
    })
    if (!outputPath) return
    await invoke('export_chapter_cbz', { chapterId: task.chapterId, outputPath })
  } catch (e) {
    console.error('Export CBZ échoué', e)
  }
}

export default function Downloads() {
  const queue = useDownloadStore((s) => s.queue)
  const refreshQueue = useDownloadStore((s) => s.refreshQueue)
  const pauseDownload = useDownloadStore((s) => s.pauseDownload)
  const resumeDownload = useDownloadStore((s) => s.resumeDownload)
  const cancelDownload = useDownloadStore((s) => s.cancelDownload)
  const clearCompleted = useDownloadStore((s) => s.clearCompleted)

  useEffect(() => {
    void refreshQueue()
  }, [refreshQueue])

  const hasCompleted = queue.some((t) => t.status === 'completed')

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 pt-6">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight text-content">
          Téléchargements
        </h1>
        {hasCompleted && (
          <button
            type="button"
            onClick={clearCompleted}
            className="rounded-lg border border-line/10 bg-surface-raised px-3 py-1.5 text-sm text-content hover:bg-fill/10"
          >
            Effacer les terminés
          </button>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {queue.length === 0 ? (
          <p className="mt-10 text-center text-sm text-content-4">
            Aucun téléchargement en cours.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-line/5">
            {queue.map((task) => {
              const pct =
                task.total > 0 ? Math.round((task.progress / task.total) * 100) : 0
              return (
                <div key={task.chapterId} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-content">
                      {task.chapterId}
                    </div>
                    <div className="mt-1 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill/10">
                        <div
                          className="h-full bg-accent transition-[width] duration-200"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className={`text-xs ${STATUS_COLOR[task.status]}`}>
                        {STATUS_LABEL[task.status]}
                        {task.total > 0 && task.status !== 'completed'
                          ? ` ${task.progress}/${task.total}`
                          : ''}
                      </span>
                    </div>
                    {task.error && (
                      <div className="mt-1 truncate text-xs text-red-400">{task.error}</div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {task.status === 'downloading' && (
                      <IconBtn label="Pause" onClick={() => pauseDownload(task.chapterId)}>
                        ⏸
                      </IconBtn>
                    )}
                    {task.status === 'paused' && (
                      <IconBtn label="Reprendre" onClick={() => resumeDownload(task.chapterId)}>
                        ▶
                      </IconBtn>
                    )}
                    {task.status === 'completed' && (
                      <button
                        type="button"
                        onClick={() => exportCbz(task)}
                        className="rounded-lg bg-fill/5 px-3 py-1.5 text-xs text-content hover:bg-fill/10"
                      >
                        Export CBZ
                      </button>
                    )}
                    {task.status !== 'completed' && (
                      <IconBtn label="Annuler" onClick={() => cancelDownload(task.chapterId)}>
                        ✕
                      </IconBtn>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string
  onClick(): void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg bg-fill/5 text-sm text-content hover:bg-fill/10"
    >
      {children}
    </button>
  )
}
