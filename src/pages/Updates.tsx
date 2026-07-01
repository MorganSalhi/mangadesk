import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '../store/settingsStore'

// ============================================================================
// Page Mises à jour — chapitres récemment récupérés (in_library), groupés par
// date (Aujourd'hui / Hier / Cette semaine / Plus ancien). Marque les mises à
// jour comme « vues » au montage (réinitialise le badge sidebar).
// ============================================================================

interface RecentUpdate {
  id: string
  mangaId: string
  number: number
  title: string | null
  isRead: number
  dateFetch: number | null
  mangaTitle: string
  coverUrl: string | null
  sourceId: string
}

type Bucket = 'today' | 'yesterday' | 'thisWeek' | 'older'

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function bucketOf(dateFetch: number | null, now: number): Bucket {
  if (!dateFetch) return 'older'
  const today = startOfDay(now)
  const yesterday = today - 86_400_000
  // Début de semaine (lundi).
  const day = new Date(now).getDay() // 0 = dimanche
  const offset = (day + 6) % 7
  const weekStart = today - offset * 86_400_000
  if (dateFetch >= today) return 'today'
  if (dateFetch >= yesterday) return 'yesterday'
  if (dateFetch >= weekStart) return 'thisWeek'
  return 'older'
}

const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'thisWeek', 'older']

export default function Updates() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const markUpdatesSeen = useSettingsStore((s) => s.markUpdatesSeen)
  const [updates, setUpdates] = useState<RecentUpdate[]>([])

  useEffect(() => {
    void (async () => {
      try {
        const rows = await invoke<RecentUpdate[]>('get_recent_updates', { limit: 200 })
        setUpdates(rows)
      } catch {
        /* backend absent */
      }
    })()
    // Ouvrir la page = avoir vu les mises à jour → reset du badge.
    markUpdatesSeen()
  }, [markUpdatesSeen])

  const grouped = useMemo(() => {
    const now = Date.now()
    const map: Record<Bucket, RecentUpdate[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      older: [],
    }
    for (const u of updates) map[bucketOf(u.dateFetch, now)].push(u)
    return map
  }, [updates])

  return (
    <div className="flex h-full flex-col">
      <header className="px-6 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight text-content">
          {t('updates.title')}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {updates.length === 0 ? (
          <p className="mt-10 text-center text-sm text-content-4">{t('updates.empty')}</p>
        ) : (
          BUCKET_ORDER.filter((b) => grouped[b].length > 0).map((bucket) => (
            <section key={bucket} className="mb-6">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
                {t(`updates.${bucket}`)}
              </h2>
              <div className="flex flex-col divide-y divide-line/5">
                {grouped[bucket].map((u) => (
                  <div key={u.id} className="flex items-center gap-3 py-2">
                    <CoverThumb url={u.coverUrl} alt={u.mangaTitle} />
                    <div className="min-w-0 flex-1">
                      <div
                        className={[
                          'truncate text-sm',
                          u.isRead ? 'text-content-4' : 'text-content',
                        ].join(' ')}
                      >
                        {u.mangaTitle}
                      </div>
                      <div className="truncate text-xs text-content-4">
                        {t('updates.chapter', { number: u.number })}
                        {u.title ? ` · ${u.title}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/reader/${u.mangaId}/${u.id}/${u.sourceId}`)
                      }
                      className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
                    >
                      {t('common.read')}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function CoverThumb({ url, alt }: { url: string | null; alt: string }) {
  const [src, setSrc] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    void (async () => {
      try {
        const data = await invoke<string>('fetch_image_as_base64', { url, headers: {} })
        if (!cancelled) setSrc(data)
      } catch {
        if (!cancelled) setSrc(url)
      }
    })()
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
