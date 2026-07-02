import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import {
  CALENDAR_IMAGE_HEADERS,
  fetchMonthlyReleases,
  type MangaRelease,
} from '../lib/releaseCalendar'
import {
  fetchChapterForecasts,
  type ChapterForecast,
} from '../lib/chapterSchedule'
import { useBrowseStore } from '../store/browseStore'

// ============================================================================
// Page Calendrier (session 13) — deux onglets :
// - « Chapitres » : sorties de chapitres ESTIMÉES pour les séries de la
//   bibliothèque, d'après leur rythme de parution (cf. lib/chapterSchedule).
// - « Tomes (FR) » : planning mensuel des volumes (données Nautiljon,
//   cf. lib/releaseCalendar), navigation par mois, recherche.
// ============================================================================

const MONTH_NAMES = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
]

const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

const DAY_MS = 86_400_000

function todayIso(): string {
  return toIsoDay(Date.now())
}

function toIsoDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

type Tab = 'chapters' | 'volumes'

export default function Calendar() {
  const [tab, setTab] = useState<Tab>('chapters')

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 px-6 pt-6">
        <h1 className="mr-auto text-2xl font-semibold tracking-tight text-content">
          Calendrier des sorties
        </h1>
        <div className="flex rounded-lg border border-line/10 bg-surface-raised p-0.5">
          {(
            [
              ['chapters', 'Chapitres'],
              ['volumes', 'Tomes (FR)'],
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              aria-pressed={tab === value}
              className={[
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                tab === value
                  ? 'bg-accent text-white'
                  : 'text-content-3 hover:text-content',
              ].join(' ')}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {tab === 'chapters' ? <ChaptersTab /> : <VolumesTab />}
    </div>
  )
}

// ============================================================================
// Onglet Chapitres — sorties estimées de la bibliothèque
// ============================================================================

function ChaptersTab() {
  const [forecasts, setForecasts] = useState<ChapterForecast[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchChapterForecasts()
      .then((list) => {
        if (cancelled) return
        setForecasts(list)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          `Impossible de calculer les sorties : ${err instanceof Error ? err.message : String(err)}`,
        )
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const { overdue, byDay, irregular } = useMemo(() => {
    const now = Date.now()
    const horizon = now + 14 * DAY_MS
    const overdue: ChapterForecast[] = []
    const upcoming: ChapterForecast[] = []
    const irregular: ChapterForecast[] = []
    for (const f of forecasts) {
      if (f.nextDate == null) irregular.push(f)
      else if (f.overdue || f.nextDate <= now) overdue.push(f)
      else if (f.nextDate <= horizon) upcoming.push(f)
      // au-delà de 14 jours : pas affiché (pronostic trop lointain = flou)
    }
    const byDay: { day: string; items: ChapterForecast[] }[] = []
    for (const f of upcoming) {
      const day = toIsoDay(f.nextDate as number)
      const last = byDay[byDay.length - 1]
      if (last && last.day === day) last.items.push(f)
      else byDay.push({ day, items: [f] })
    }
    return { overdue, byDay, irregular }
  }, [forecasts])

  return (
    <div className="flex-1 overflow-y-auto px-6 py-5">
      <p className="mb-5 max-w-2xl text-xs text-content-4">
        Dates <span className="font-medium text-content-3">estimées</span> d’après le
        rythme de parution des séries de votre bibliothèque sur leurs sources.
        Les séries au rythme erratique sont listées sans pronostic.
      </p>

      {loading ? (
        <p className="py-10 text-center text-sm text-content-4">Analyse en cours…</p>
      ) : error ? (
        <p className="mx-auto mt-10 max-w-md text-center text-sm text-content-4">{error}</p>
      ) : forecasts.length === 0 ? (
        <p className="mt-10 text-center text-sm text-content-4">
          Aucune série en cours dans votre bibliothèque — ajoutez-y des mangas pour
          voir leurs prochaines sorties estimées.
        </p>
      ) : (
        <div className="flex flex-col gap-7 pb-6">
          {overdue.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold tracking-wide text-content-3">
                Attendus{' '}
                <span className="font-normal text-content-4">
                  · sortie imminente ou en léger retard
                </span>
              </h2>
              <ForecastGrid items={overdue} />
            </section>
          )}

          {byDay.map((group) => (
            <section key={group.day}>
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold capitalize tracking-wide text-content-3">
                {DAY_FORMAT.format(new Date(`${group.day}T12:00:00`))}
                <span className="font-normal normal-case text-content-4">
                  · {relativeDay(group.day)}
                </span>
              </h2>
              <ForecastGrid items={group.items} />
            </section>
          ))}

          {overdue.length === 0 && byDay.length === 0 && (
            <p className="text-sm text-content-4">
              Rien d’estimé sur les 14 prochains jours.
            </p>
          )}

          {irregular.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold tracking-wide text-content-3">
                Rythme irrégulier{' '}
                <span className="font-normal text-content-4">
                  · pas de pronostic fiable (pauses, historique trop court…)
                </span>
              </h2>
              <ForecastGrid items={irregular} />
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function relativeDay(isoDay: string): string {
  const diff = Math.round(
    (new Date(`${isoDay}T12:00:00`).getTime() -
      new Date(`${todayIso()}T12:00:00`).getTime()) /
      DAY_MS,
  )
  if (diff <= 0) return 'aujourd’hui'
  if (diff === 1) return 'demain'
  return `dans ${diff} jours`
}

function ForecastGrid({ items }: { items: ChapterForecast[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
      {items.map((f) => (
        <ForecastCard key={f.mangaId} forecast={f} />
      ))}
    </div>
  )
}

function ForecastCard({ forecast }: { forecast: ChapterForecast }) {
  const navigate = useNavigate()
  const daysSinceLast = Math.max(0, Math.round((Date.now() - forecast.lastDate) / DAY_MS))

  return (
    <button
      type="button"
      onClick={() => navigate(`/manga/${forecast.sourceId}/${forecast.remoteId}`)}
      title={forecast.title}
      className="group flex items-stretch gap-3 rounded-xl border border-line/5 bg-surface-raised p-2.5 text-left transition-colors hover:border-accent/40"
    >
      <CoverThumb
        coverUrl={forecast.coverUrl}
        sourceId={forecast.sourceId}
        alt={forecast.title}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2 text-sm font-medium text-content">
          {forecast.title}
        </span>
        <span className="mt-0.5 text-xs text-content-3">
          {forecast.nextDate != null
            ? `Ch. ${formatNumber(forecast.lastNumber)} → suivant ${
                forecast.overdue ? 'attendu' : 'estimé'
              }`
            : `Dernier ch. ${formatNumber(forecast.lastNumber)} il y a ${daysSinceLast} j`}
        </span>
        <span className="mt-auto flex items-center gap-2 pt-2 text-xs text-content-4">
          {forecast.cadence ?? 'cadence inconnue'}
          {forecast.overdue && (
            <span className="ml-auto shrink-0 rounded-full bg-accent/15 px-2 py-0.5 font-medium text-accent">
              attendu
            </span>
          )}
        </span>
      </div>
    </button>
  )
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/** Vignette générique (bibliothèque ou Nautiljon) via fetch_image_as_base64. */
function CoverThumb({
  coverUrl,
  sourceId,
  alt,
  headers,
}: {
  coverUrl: string | null
  sourceId?: string
  alt: string
  headers?: Record<string, string>
}) {
  const [cover, setCover] = useState<string | null>(null)
  useEffect(() => {
    if (!coverUrl) return
    let cancelled = false
    invoke<string>('fetch_image_as_base64', {
      url: coverUrl,
      headers: headers ?? {},
      label: sourceId ? `cf-${sourceId}` : null,
    })
      .then((data) => !cancelled && setCover(data))
      .catch(() => !cancelled && setCover(coverUrl))
    return () => {
      cancelled = true
    }
  }, [coverUrl, sourceId, headers])

  return (
    <div className="h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-fill/10">
      {cover ? (
        <img
          src={cover}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-fill/10" />
      )}
    </div>
  )
}

// ============================================================================
// Onglet Tomes (FR) — planning mensuel Nautiljon
// ============================================================================

function VolumesTab() {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1) // 1..12
  const [releases, setReleases] = useState<MangaRelease[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1
  const today = todayIso()
  const todayRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchMonthlyReleases(year, month)
      .then((list) => {
        if (cancelled) return
        setReleases(list)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(`Impossible de charger le planning : ${msg}`)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [year, month])

  // Sur le mois courant, on amène le jour J à l'écran une fois chargé.
  useEffect(() => {
    if (!loading && isCurrentMonth) {
      todayRef.current?.scrollIntoView({ block: 'start' })
    }
  }, [loading, isCurrentMonth, releases])

  function shiftMonth(delta: number) {
    const d = new Date(year, month - 1 + delta, 1)
    setYear(d.getFullYear())
    setMonth(d.getMonth() + 1)
  }

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return releases
    return releases.filter(
      (r) =>
        r.series.toLowerCase().includes(needle) ||
        r.publisher.toLowerCase().includes(needle),
    )
  }, [releases, search])

  // Regroupe par date (les sorties sont déjà triées par date puis série).
  const byDate = useMemo(() => {
    const groups: { date: string; items: MangaRelease[] }[] = []
    for (const r of filtered) {
      const last = groups[groups.length - 1]
      if (last && last.date === r.date) last.items.push(r)
      else groups.push({ date: r.date, items: [r] })
    }
    return groups
  }, [filtered])

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filtrer par titre ou éditeur…"
          className="w-full max-w-md rounded-lg border border-line/10 bg-surface-raised px-3 py-2 text-sm text-content outline-none focus:border-accent"
        />
        <div className="ml-auto flex items-center gap-1">
          {!isCurrentMonth && (
            <button
              type="button"
              onClick={() => {
                setYear(now.getFullYear())
                setMonth(now.getMonth() + 1)
              }}
              className="mr-1 rounded-lg border border-line/10 bg-surface-raised px-3 py-1.5 text-sm text-content hover:bg-fill/10"
            >
              Aujourd’hui
            </button>
          )}
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="Mois précédent"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line/10 bg-surface-raised text-content hover:bg-fill/10"
          >
            ‹
          </button>
          <span className="min-w-40 text-center text-sm font-medium capitalize text-content">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="Mois suivant"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line/10 bg-surface-raised text-content hover:bg-fill/10"
          >
            ›
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <p className="py-10 text-center text-sm text-content-4">
            Chargement du planning…
          </p>
        ) : error ? (
          <p className="mx-auto mt-10 max-w-md text-center text-sm text-content-4">
            {error}
          </p>
        ) : byDate.length === 0 ? (
          <p className="mt-10 text-center text-sm text-content-4">
            {search
              ? 'Aucune sortie ne correspond à ce filtre.'
              : 'Aucune sortie recensée pour ce mois.'}
          </p>
        ) : (
          <div className="flex flex-col gap-7 pb-6">
            {byDate.map((group) => {
              const isToday = group.date === today
              const isPast = group.date < today
              return (
                <section
                  key={group.date}
                  ref={isToday ? todayRef : undefined}
                  className={isPast && isCurrentMonth ? 'opacity-60' : undefined}
                >
                  <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold capitalize tracking-wide text-content-3">
                    {DAY_FORMAT.format(new Date(`${group.date}T12:00:00`))}
                    {isToday && (
                      <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold normal-case text-white">
                        Aujourd’hui
                      </span>
                    )}
                    <span className="font-normal text-content-4">
                      · {group.items.length} sortie{group.items.length > 1 ? 's' : ''}
                    </span>
                  </h2>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
                    {group.items.map((r) => (
                      <ReleaseCard key={r.url} release={r} />
                    ))}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}

function ReleaseCard({ release }: { release: MangaRelease }) {
  const navigate = useNavigate()
  const setQuery = useBrowseStore((s) => s.setQuery)

  function searchInSources() {
    setQuery(release.series)
    navigate('/browse')
  }

  return (
    <button
      type="button"
      onClick={searchInSources}
      title={`Rechercher « ${release.series} » dans les sources`}
      className="group flex items-stretch gap-3 rounded-xl border border-line/5 bg-surface-raised p-2.5 text-left transition-colors hover:border-accent/40"
    >
      <CoverThumb
        coverUrl={release.coverUrl}
        headers={CALENDAR_IMAGE_HEADERS}
        sourceId="nautiljon"
        alt=""
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="line-clamp-2 text-sm font-medium text-content">
          {release.series}
        </span>
        {release.volume && (
          <span className="mt-0.5 text-xs text-content-3">Tome {release.volume}</span>
        )}
        <span className="mt-auto flex items-center gap-2 pt-2 text-xs text-content-4">
          {release.publisher && <span className="truncate">{release.publisher}</span>}
          {release.price && <span className="ml-auto shrink-0">{release.price}</span>}
        </span>
      </div>
    </button>
  )
}
