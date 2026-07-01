import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'

// ============================================================================
// Page Statistiques — session 4B.
// Classement des mangas par temps de lecture (depuis `reading_stats`) + totaux
// globaux. Le store libraryStore n'est pas utilisé : les commandes Rust
// joignent déjà manga × reading_stats (cover_url incluse).
// ============================================================================

interface MangaReadingStats {
  id: string
  title: string
  coverUrl: string | null
  sourceId: string
  totalSeconds: number
  chaptersRead: number
  lastRead: number | null
}

interface GlobalStats {
  activeMangas: number
  totalChapters: number
  totalSeconds: number
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export default function Stats() {
  const navigate = useNavigate()
  const [stats, setStats] = useState<MangaReadingStats[]>([])
  const [global, setGlobal] = useState<GlobalStats | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Rechargement systématique au montage ET au refocus de la fenêtre — la page
  // Stats peut être consultée juste après une session de lecture (bug 4) : sans
  // refresh on resterait sur les valeurs en cache de l'avant-lecture.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [rows, g] = await Promise.all([
          invoke<MangaReadingStats[]>('get_reading_stats'),
          invoke<GlobalStats>('get_global_stats'),
        ])
        if (cancelled) return
        setStats(rows)
        setGlobal(g)
      } catch {
        /* backend absent : liste vide */
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // Échelle pour la barre relative : le manga le plus lu = 100 %.
  const topSeconds = stats.reduce((m, s) => Math.max(m, s.totalSeconds), 0)

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-content">Statistiques</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {/* Totaux globaux */}
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Mangas actifs" value={global?.activeMangas ?? 0} />
          <Stat label="Chapitres lus" value={global?.totalChapters ?? 0} />
          <Stat label="Temps total" value={formatDuration(global?.totalSeconds ?? 0)} />
        </section>

        {/* Classement */}
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-content-3">
            Mangas les plus lus
          </h2>
          {loaded && stats.length === 0 ? (
            <p className="py-10 text-center text-sm text-content-4">
              Aucune statistique pour le moment.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-line/5">
              {stats.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => navigate(`/manga/${s.sourceId}/${s.id}`)}
                  className="flex items-center gap-3 py-2 text-left hover:bg-fill/5"
                >
                  <Cover url={s.coverUrl} alt={s.title} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-content">{s.title}</div>
                    <div className="mt-1 h-1.5 w-full rounded-full bg-fill/10">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{
                          width: `${topSeconds > 0 ? (s.totalSeconds / topSeconds) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 truncate text-xs text-content-4">
                      {formatDuration(s.totalSeconds)} · {s.chaptersRead} chap.
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-line/5 bg-surface-raised px-5 py-4">
      <div className="text-xs uppercase tracking-wide text-content-3">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-content">{value}</div>
    </div>
  )
}

function Cover({ url, alt }: { url: string | null; alt: string }) {
  const [src, setSrc] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    invoke<string>('fetch_image_as_base64', { url, headers: {} })
      .then((data) => !cancelled && setSrc(data))
      .catch(() => !cancelled && setSrc(url))
    return () => {
      cancelled = true
    }
  }, [url])

  return (
    <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-surface-raised">
      {src ? (
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full animate-pulse bg-fill/10" />
      )}
    </div>
  )
}
