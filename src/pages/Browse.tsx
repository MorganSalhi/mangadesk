import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import pLimit from 'p-limit'
import { SOURCE_REGISTRY } from '../hooks/useSource'
import { useRemoteImage } from '../lib/remoteImage'
import { useBrowseStore } from '../store/browseStore'
import { useSettingsStore } from '../store/settingsStore'
import SourceFilterPanel, {
  countActiveFilters,
} from '../components/browse/SourceFilterPanel'
import type { FilterValues, MangaPreview, SourceFilterDef } from '../types'

// ============================================================================
// Page Parcourir — sélection de source, recherche, grille de résultats avec
// pagination « charger plus ». Clic → page détail du manga.
//
// Session 4B : ajout d'un mode « Toutes les sources » (sentinelle `*` dans le
// select). Dans ce mode la pagination est désactivée et les résultats sont
// groupés par source — chaque source répond indépendamment via Promise.allSettled
// (une source plantée n'empêche pas les autres d'afficher leurs résultats).
//
// Session 13 : filtres par source (panneau latéral, définitions déclarées par
// la source, cf. SourceFilterPanel) + bouton 🎲 « manga aléatoire ».
// ============================================================================

const ALL_SOURCES = '*'

// getFilters() (chargement async des définitions, ex. tags MangaDex) n'est
// appelé qu'une fois par source et par session.
const filterDefsLoaded = new Set<string>()

// Référence STABLE pour « aucun filtre » : l'effet de recherche dépend de
// filterValues — un `?? {}` inline créerait un nouvel objet à chaque render
// et relancerait la recherche en boucle.
const EMPTY_FILTERS: FilterValues = {}

interface GlobalSearchResult {
  sourceId: string
  sourceName: string
  mangas: MangaPreview[]
}

export default function Browse() {
  const navigate = useNavigate()
  const activeSourceId = useBrowseStore((s) => s.activeSourceId)
  const setActiveSourceId = useBrowseStore((s) => s.setActiveSourceId)
  const storedQuery = useBrowseStore((s) => s.query)
  const setStoredQuery = useBrowseStore((s) => s.setQuery)
  const allFilterValues = useBrowseStore((s) => s.filterValues)
  const setFilterValues = useBrowseStore((s) => s.setFilterValues)
  const resetFilterValues = useBrowseStore((s) => s.resetFilterValues)

  const [input, setInput] = useState(storedQuery)
  const [submitted, setSubmitted] = useState(storedQuery)
  const [results, setResults] = useState<MangaPreview[]>([])
  const [globalResults, setGlobalResults] = useState<GlobalSearchResult[]>([])
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Erreur de type Cloudflare → on propose un bouton de relance dédié.
  const [cfBlocked, setCfBlocked] = useState(false)
  // Incrémenté pour reforcer une nouvelle tentative (ré-ouvre le solveur).
  const [retryNonce, setRetryNonce] = useState(0)
  // Panneau de filtres de la source active.
  const [showFilters, setShowFilters] = useState(false)
  const [filterDefs, setFilterDefs] = useState<SourceFilterDef[]>([])
  const [filtersLoading, setFiltersLoading] = useState(false)
  // Bouton 🎲 : chargement + message d'erreur transitoire (bandeau).
  const [randomLoading, setRandomLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)

  // Masque les sources 18+ du sélecteur si le réglage est désactivé (la
  // recherche globale et la source active suivent la même liste).
  const showNsfwSources = useSettingsStore((s) => s.showNsfwSources)
  const sources = useMemo(
    () => Object.values(SOURCE_REGISTRY).filter((s) => showNsfwSources || !s.isNsfw),
    [showNsfwSources],
  )
  const isGlobalMode = activeSourceId === ALL_SOURCES
  const source = !isGlobalMode && activeSourceId ? SOURCE_REGISTRY[activeSourceId] ?? null : null
  const filterValues: FilterValues =
    (activeSourceId ? allFilterValues[activeSourceId] : undefined) ?? EMPTY_FILTERS

  function showNotice(message: string) {
    setNotice(message)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 5000)
  }
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])

  // -- Définitions de filtres de la source active ----------------------------
  useEffect(() => {
    if (!source) {
      setFilterDefs([])
      return
    }
    setFilterDefs(source.filters)
    if (!source.getFilters || filterDefsLoaded.has(source.id)) return
    filterDefsLoaded.add(source.id)
    let cancelled = false
    setFiltersLoading(true)
    source
      .getFilters()
      .then((defs) => {
        if (!cancelled) setFilterDefs(defs)
      })
      .catch((err: unknown) => {
        // On garde les définitions statiques : le panneau reste utilisable.
        console.warn(`[Browse] getFilters(${source.id}) failed:`, err)
        filterDefsLoaded.delete(source.id)
      })
      .finally(() => {
        if (!cancelled) setFiltersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [source])

  // -- Source unique ---------------------------------------------------------
  useEffect(() => {
    if (isGlobalMode) return
    if (!source) {
      console.error(`[Browse] source "${activeSourceId}" introuvable dans SOURCE_REGISTRY`)
      setError(`Source « ${activeSourceId} » introuvable`)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setCfBlocked(false)
    source
      .search(submitted, page, filterValues)
      .then((res) => {
        if (cancelled) return
        setResults((prev) => (page === 1 ? res.mangas : [...prev, ...res.mangas]))
        setHasNext(res.hasNextPage)
        setLoading(false)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.startsWith('CLOUDFLARE_BLOCKED:')) {
          // Message dédié — l'erreur source donne déjà la marche à suivre.
          setError(msg.slice('CLOUDFLARE_BLOCKED:'.length).trim())
          setCfBlocked(true)
        } else {
          setError(`Échec du chargement : ${msg || 'source ou réseau indisponible.'}`)
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // filterValues vient du store : nouvelle référence uniquement sur Appliquer.
  }, [isGlobalMode, source, activeSourceId, submitted, page, retryNonce, filterValues])

  // -- Toutes les sources (parallèle, allSettled) ----------------------------
  useEffect(() => {
    if (!isGlobalMode) return
    if (!submitted) {
      // Pas de recherche encore lancée : on n'agresse pas les N sources avec
      // un getLatest() global (coût × N pour rien).
      setGlobalResults([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      // Concurrence bornée : avec les dépôts d'extensions, « toutes les
      // sources » peut en compter ~100 — les interroger toutes d'un coup
      // saturerait le réseau et le backend (et ferait bannir l'IP).
      const limit = pLimit(6)
      const settled = await Promise.allSettled(
        sources.map((src) =>
          limit(async () => {
            const pageRes = await src.search(submitted, 1, {})
            return {
              sourceId: src.id,
              sourceName: src.name,
              mangas: pageRes.mangas,
            } satisfies GlobalSearchResult
          }),
        ),
      )
      if (cancelled) return
      const ok = settled
        .filter((r): r is PromiseFulfilledResult<GlobalSearchResult> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((r) => r.mangas.length > 0)
      setGlobalResults(ok)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [isGlobalMode, submitted, sources])

  function runSearch() {
    const q = input.trim()
    setStoredQuery(q)
    setSubmitted(q)
    setPage(1)
    setResults([])
    setGlobalResults([])
  }

  function changeSource(id: string) {
    setActiveSourceId(id)
    setPage(1)
    setResults([])
    setGlobalResults([])
  }

  function clearSearch() {
    setInput('')
    setStoredQuery('')
    setSubmitted('')
    setPage(1)
    setResults([])
    setGlobalResults([])
  }

  function applyFilters(values: FilterValues) {
    if (!activeSourceId) return
    setFilterValues(activeSourceId, values)
    setPage(1)
    setResults([])
  }

  function resetFilters() {
    if (!activeSourceId) return
    resetFilterValues(activeSourceId)
    setPage(1)
    setResults([])
  }

  async function openRandom() {
    if (!source?.getRandom || randomLoading) return
    setRandomLoading(true)
    try {
      const manga = await source.getRandom()
      navigate(`/manga/${manga.sourceId}/${manga.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showNotice(`Manga aléatoire indisponible : ${msg || 'erreur inconnue.'}`)
    } finally {
      setRandomLoading(false)
    }
  }

  const activeFilterCount = countActiveFilters(filterDefs, filterValues)

  return (
    <div className="flex h-full">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 px-6 pt-6">
          <h1 className="mr-auto text-2xl font-semibold tracking-tight text-content">
            Parcourir
          </h1>

          {source?.getRandom && (
            <button
              type="button"
              onClick={() => void openRandom()}
              disabled={randomLoading}
              title="Ouvrir un manga aléatoire de la source"
              aria-label="Manga aléatoire"
              className="flex items-center gap-1.5 rounded-lg border border-line/10 bg-surface-raised px-3 py-1.5 text-sm text-content hover:bg-fill/10 disabled:opacity-50"
            >
              <span aria-hidden="true">🎲</span>
              {randomLoading ? 'Recherche…' : 'Aléatoire'}
            </button>
          )}

          {!isGlobalMode && source && (
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              aria-expanded={showFilters}
              className={[
                'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm',
                showFilters || activeFilterCount > 0
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-line/10 bg-surface-raised text-content hover:bg-fill/10',
              ].join(' ')}
            >
              Filtres
              {activeFilterCount > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-white">
                  {activeFilterCount}
                </span>
              )}
            </button>
          )}

          <select
            value={activeSourceId ?? ''}
            onChange={(e) => changeSource(e.target.value)}
            className="rounded-lg border border-line/10 bg-surface-raised px-3 py-1.5 text-sm text-content"
            aria-label="Source"
          >
            <option value={ALL_SOURCES}>Toutes les sources</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </header>

        <div className="flex gap-2 px-6 pt-4">
          <div className="relative min-w-0 flex-1">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder={
                isGlobalMode
                  ? 'Rechercher dans toutes les sources…'
                  : 'Rechercher un manga…'
              }
              className="w-full rounded-lg border border-line/10 bg-surface-raised px-3 py-2 pr-8 text-sm text-content outline-none focus:border-accent"
            />
            {(input || submitted) && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label="Vider la recherche"
                title="Vider la recherche"
                className="absolute right-2 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded-full text-content-4 hover:bg-fill/10 hover:text-content"
              >
                ✕
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={runSearch}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Rechercher
          </button>
        </div>

        <div className="relative flex-1 overflow-y-auto px-6 py-5">
          {error && results.length === 0 && globalResults.length === 0 ? (
            <div className="mt-10 flex flex-col items-center gap-4">
              <p className="max-w-md text-center text-sm text-content-4">{error}</p>
              {cfBlocked && (
                <button
                  type="button"
                  onClick={() => setRetryNonce((n) => n + 1)}
                  className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
                >
                  Résoudre le challenge Cloudflare
                </button>
              )}
            </div>
          ) : isGlobalMode ? (
            <GlobalResults
              loading={loading}
              results={globalResults}
              onSelect={(m) => navigate(`/manga/${m.sourceId}/${m.id}`)}
              submitted={submitted}
            />
          ) : results.length === 0 && !loading ? (
            <p className="mt-10 text-center text-sm text-content-4">Aucun résultat.</p>
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
                {results.map((m) => (
                  <BrowseCard
                    key={m.id}
                    manga={m}
                    onClick={() => navigate(`/manga/${m.sourceId}/${m.id}`)}
                  />
                ))}
              </div>

              {loading && (
                <p className="py-6 text-center text-sm text-content-4">Chargement…</p>
              )}

              {!loading && hasNext && (
                <div className="flex justify-center py-6">
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    className="rounded-lg bg-fill/10 px-4 py-2 text-sm text-content hover:bg-fill/20"
                  >
                    Charger plus
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {notice && (
          <div className="pointer-events-none absolute bottom-6 left-1/2 z-40 -translate-x-1/2">
            <p className="rounded-lg bg-surface-raised px-4 py-2 text-sm text-content shadow-lg ring-1 ring-line/10">
              {notice}
            </p>
          </div>
        )}
      </div>

      {showFilters && !isGlobalMode && source && (
        <SourceFilterPanel
          defs={filterDefs}
          values={filterValues}
          loading={filtersLoading}
          onApply={applyFilters}
          onReset={resetFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
    </div>
  )
}

function GlobalResults({
  loading,
  results,
  onSelect,
  submitted,
}: {
  loading: boolean
  results: GlobalSearchResult[]
  onSelect(manga: MangaPreview): void
  submitted: string
}) {
  if (!submitted) {
    return (
      <p className="mt-10 text-center text-sm text-content-4">
        Saisissez un terme pour rechercher dans toutes les sources.
      </p>
    )
  }
  if (loading) {
    return <p className="py-6 text-center text-sm text-content-4">Chargement…</p>
  }
  if (results.length === 0) {
    return <p className="mt-10 text-center text-sm text-content-4">Aucun résultat.</p>
  }
  return (
    <div className="flex flex-col gap-6">
      {results.map((group) => (
        <section key={group.sourceId}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-content-3">
            {group.sourceName}{' '}
            <span className="text-content-4">({group.mangas.length})</span>
          </h2>
          <div className="flex gap-4 overflow-x-auto pb-2">
            {group.mangas.map((m) => (
              <button
                key={`${m.sourceId}:${m.id}`}
                type="button"
                onClick={() => onSelect(m)}
                className="group flex w-32 shrink-0 flex-col text-left"
              >
                <CoverImage manga={m} />
                <span className="mt-1.5 line-clamp-2 text-xs text-content">{m.title}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function CoverImage({ manga }: { manga: MangaPreview }) {
  const cover = useRemoteImage(manga.coverUrl, { sourceId: manga.sourceId })

  // Scan-Manga : la home « dernières sorties » n'expose que le logo-titre large
  // (URL en `_2_`), pas la couverture portrait. On l'affiche en entier (contain)
  // plutôt que recadré. Les vraies couvertures (recherche/biblio, en `_1_`)
  // restent en `object-cover` (remplies), comme la fiche.
  const isWideLogo =
    manga.sourceId === 'scanmanga' && /_2_\d+\.\w+(\?.*)?$/.test(manga.coverUrl ?? '')
  const fit = isWideLogo ? 'object-contain p-1' : 'object-cover'

  return (
    <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-surface-raised">
      {cover ? (
        <img
          src={cover}
          alt={manga.title}
          loading="lazy"
          className={`h-full w-full ${fit} transition-transform duration-300 group-hover:scale-105`}
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-fill/10" />
      )}
    </div>
  )
}

function BrowseCard({ manga, onClick }: { manga: MangaPreview; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="group flex flex-col text-left">
      <CoverImage manga={manga} />
      <span className="mt-1.5 line-clamp-2 text-sm text-content">{manga.title}</span>
    </button>
  )
}
