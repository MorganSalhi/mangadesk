import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import {
  useDownloadStore,
  type DownloadStatus,
  type DownloadTask,
} from '../store/downloadStore'

// ============================================================================
// Page Téléchargements — deux sections :
// - « File d'attente » : tâches actives (events Rust temps réel), avec
//   pause / reprise / annulation.
// - « Téléchargés » : chapitres terminés PERSISTÉS (table downloads) — la file
//   Rust ne vit qu'en mémoire, donc après un redémarrage seuls ces enregistrements
//   savent ce qui est sur le disque. Export CBZ depuis cette liste.
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

/** Ligne renvoyée par `get_completed_downloads` (jointure chapters/manga). */
interface CompletedDownload {
  chapterId: string
  mangaId: string
  totalPages: number | null
  updatedAt: number
  number: number | null
  mangaTitle: string | null
  sourceId: string | null
}

async function exportCbz(chapterId: string): Promise<void> {
  try {
    const outputPath = await save({
      defaultPath: `${chapterId}.cbz`,
      filters: [{ name: 'Comic Book ZIP', extensions: ['cbz'] }],
    })
    if (!outputPath) return
    await invoke('export_chapter_cbz', { chapterId, outputPath })
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

  const [completed, setCompleted] = useState<CompletedDownload[]>([])

  useEffect(() => {
    void refreshQueue()
  }, [refreshQueue])

  // Terminés persistés : au montage, puis à chaque complétion en direct
  // (record_download vient d'écrire la ligne côté DB).
  const completedInQueue = queue.filter((t) => t.status === 'completed').length
  useEffect(() => {
    invoke<CompletedDownload[]>('get_completed_downloads')
      .then(setCompleted)
      .catch(() => {
        /* backend absent */
      })
  }, [completedInQueue])

  // File visible = tâches non terminées (les terminées vivent dans la
  // section persistée en dessous — sinon elles seraient affichées en double).
  const active = useMemo(() => queue.filter((t) => t.status !== 'completed'), [queue])

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 pt-6">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight text-content">
          Téléchargements
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
            File d'attente
          </h2>
          {active.length === 0 ? (
            <p className="py-4 text-sm text-content-4">Aucun téléchargement en cours.</p>
          ) : (
            <div className="flex flex-col divide-y divide-line/5">
              {active.map((task) => (
                <ActiveRow
                  key={task.chapterId}
                  task={task}
                  onPause={pauseDownload}
                  onResume={resumeDownload}
                  onCancel={cancelDownload}
                />
              ))}
            </div>
          )}
        </section>

        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
            Téléchargés ({completed.length})
          </h2>
          {completed.length === 0 ? (
            <p className="py-4 text-sm text-content-4">Aucun chapitre téléchargé.</p>
          ) : (
            <div className="flex flex-col divide-y divide-line/5">
              {completed.map((d) => (
                <div key={d.chapterId} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-content">
                      {d.mangaTitle ?? d.mangaId}
                      {d.number != null ? ` · Chapitre ${d.number}` : ''}
                    </div>
                    <div className="truncate text-xs text-content-4">
                      {d.totalPages != null ? `${d.totalPages} pages · ` : ''}
                      {new Date(d.updatedAt).toLocaleDateString('fr-FR')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void exportCbz(d.chapterId)}
                    className="shrink-0 rounded-lg bg-fill/5 px-3 py-1.5 text-xs text-content hover:bg-fill/10"
                  >
                    Export CBZ
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ActiveRow({
  task,
  onPause,
  onResume,
  onCancel,
}: {
  task: DownloadTask
  onPause(chapterId: string): void
  onResume(chapterId: string): void
  onCancel(chapterId: string): void
}) {
  const pct = task.total > 0 ? Math.round((task.progress / task.total) * 100) : 0
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-content">{task.chapterId}</div>
        <div className="mt-1 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fill/10">
            <div
              className="h-full bg-accent transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className={`text-xs ${STATUS_COLOR[task.status]}`}>
            {STATUS_LABEL[task.status]}
            {task.total > 0 ? ` ${task.progress}/${task.total}` : ''}
          </span>
        </div>
        {task.error && (
          <div className="mt-1 truncate text-xs text-red-400">{task.error}</div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {task.status === 'downloading' && (
          <IconBtn label="Pause" onClick={() => onPause(task.chapterId)}>
            ⏸
          </IconBtn>
        )}
        {task.status === 'paused' && (
          <IconBtn label="Reprendre" onClick={() => onResume(task.chapterId)}>
            ▶
          </IconBtn>
        )}
        <IconBtn label="Annuler" onClick={() => onCancel(task.chapterId)}>
          ✕
        </IconBtn>
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
