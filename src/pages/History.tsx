import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { useSettingsStore } from '../store/settingsStore'
import Modal from '../components/ui/Modal'
import CoverThumb from '../components/ui/CoverThumb'

// ============================================================================
// Page Historique — refondue session 5A (bug 5).
// Une entrée par manga, agrégeant le dernier chapitre lu, le temps cumulé et
// la date de dernière lecture. Bouton de réinitialisation par manga (avec
// confirmation : remet les chapitres non-lus et purge stats/history).
// Le manga reste dans la bibliothèque, seules les traces de lecture partent.
// ============================================================================

interface MangaHistoryEntry {
  mangaId: string
  mangaTitle: string
  coverUrl: string | null
  sourceId: string
  lastRead: number
  lastChapterNumber: number | null
  totalSeconds: number
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function formatRelative(ms: number, now: number): string {
  const diff = Math.max(0, now - ms)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `il y a ${h} h`
  const d = Math.floor(h / 24)
  if (d < 7) return `il y a ${d} j`
  return new Date(ms).toLocaleDateString('fr-FR')
}

export default function History() {
  const navigate = useNavigate()
  const incognitoMode = useSettingsStore((s) => s.incognitoMode)
  const setIncognitoMode = useSettingsStore((s) => s.setIncognitoMode)
  const [entries, setEntries] = useState<MangaHistoryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [confirmReset, setConfirmReset] = useState<MangaHistoryEntry | null>(null)
  const [now, setNow] = useState(Date.now())

  async function loadEntries(): Promise<void> {
    try {
      const rows = await invoke<MangaHistoryEntry[]>('get_history_by_manga', { limit: 500 })
      setEntries(rows)
    } catch {
      /* backend absent */
    } finally {
      setLoaded(true)
    }
  }

  // Le timestamp `now` n'est pas critique mais permet aux libellés relatifs
  // (« il y a 2 min ») de rester précis si l'utilisateur reste sur la page.
  useEffect(() => {
    void loadEntries()
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  async function resetManga(entry: MangaHistoryEntry): Promise<void> {
    try {
      await invoke('reset_manga_reading_data', { mangaId: entry.mangaId })
    } catch (e) {
      console.error('[history] reset_manga_reading_data failed:', e)
    }
    setConfirmReset(null)
    await loadEntries()
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 px-6 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-content">Historique</h1>
        <button
          type="button"
          onClick={() => void setIncognitoMode(!incognitoMode)}
          aria-pressed={incognitoMode}
          title={
            incognitoMode
              ? 'Navigation privée activée — cliquer pour désactiver'
              : 'Activer la navigation privée'
          }
          className={[
            'ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs',
            incognitoMode
              ? 'border-purple-500/40 bg-purple-500/15 text-purple-300'
              : 'border-line/10 bg-fill/5 text-content-3 hover:bg-fill/10',
          ].join(' ')}
        >
          <span aria-hidden>🕶️</span>
          {incognitoMode ? 'Navigation privée — active' : 'Navigation privée'}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loaded && entries.length === 0 ? (
          <p className="mt-10 text-center text-sm text-content-4">
            Aucune lecture enregistrée.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-line/5">
            {entries.map((e) => (
              <div key={e.mangaId} className="flex items-center gap-3 py-2.5">
                <button
                  type="button"
                  onClick={() => navigate(`/manga/${e.sourceId}/${e.mangaId}`)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left hover:bg-fill/5"
                >
                  <CoverThumb url={e.coverUrl} sourceId={e.sourceId} alt={e.mangaTitle} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-content">{e.mangaTitle}</div>
                    <div className="truncate text-xs text-content-4">
                      {e.lastChapterNumber !== null
                        ? `Chapitre ${e.lastChapterNumber}`
                        : '—'}
                      {' · '}
                      {formatDuration(e.totalSeconds)} de lecture
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-content-4">
                    {formatRelative(e.lastRead, now)}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmReset(e)}
                  aria-label={`Réinitialiser les données de lecture de ${e.mangaTitle}`}
                  title="Réinitialiser les données de lecture"
                  className="shrink-0 rounded-lg bg-fill/5 px-2 py-1 text-sm text-content-3 hover:bg-red-500/15 hover:text-red-300"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmReset && (
        <Modal
          title="Réinitialiser les données de lecture"
          onClose={() => setConfirmReset(null)}
        >
          <p className="mb-4 text-sm text-content-2">
            Réinitialiser les données de lecture de « {confirmReset.mangaTitle} » ? Cette
            action remettra tous les chapitres comme non-lus et supprimera le temps de
            lecture. Le manga reste dans votre bibliothèque.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmReset(null)}
              className="rounded-lg bg-fill/5 px-3 py-2 text-sm text-content-2 hover:bg-fill/10"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={() => void resetManga(confirmReset)}
              className="rounded-lg bg-red-500/80 px-3 py-2 text-sm font-medium text-white hover:bg-red-500"
            >
              Réinitialiser
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

