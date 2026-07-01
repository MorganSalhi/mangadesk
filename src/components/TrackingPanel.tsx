import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// ============================================================================
// TrackingPanel — liaison d'un manga à AniList / MAL.
// Affiche, par provider : statut de liaison, recherche manuelle, lier/délier.
// La connexion OAuth des comptes se fait dans Paramètres → Comptes.
// ============================================================================

const PROVIDERS = [
  { id: 'anilist', label: 'AniList' },
  { id: 'mal', label: 'MyAnimeList' },
] as const

type ProviderId = (typeof PROVIDERS)[number]['id']

interface TrackingEntry {
  mangaId: string
  provider: string
  remoteId: string
  title: string
  status: string | null
  score: number | null
  progress: number | null
  lastSynced: number | null
}

interface SearchResult {
  remoteId: string
  title: string
  coverUrl: string | null
  year: number | null
}

interface Props {
  mangaId: string
  mangaTitle: string
  onClose(): void
}

export default function TrackingPanel({ mangaId, mangaTitle, onClose }: Props) {
  const [tracking, setTracking] = useState<TrackingEntry[]>([])

  const reload = useCallback(async () => {
    try {
      const rows = await invoke<TrackingEntry[]>('get_manga_tracking', { mangaId })
      setTracking(rows)
    } catch {
      setTracking([])
    }
  }, [mangaId])

  useEffect(() => {
    void reload()
  }, [reload])

  // Échap ferme le panneau (sauf si une saisie a le focus → on laisse le champ).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const entryFor = (p: ProviderId) => tracking.find((t) => t.provider === p)

  return (
    <div className="absolute inset-y-0 right-0 z-40 flex w-[340px] flex-col bg-surface-raised shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <h2 className="truncate text-sm font-semibold text-slate-100">Suivi · {mangaTitle}</h2>
        <button type="button" onClick={onClose} aria-label="Fermer" className="text-slate-400">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {PROVIDERS.map((p) => (
          <ProviderBlock
            key={p.id}
            provider={p.id}
            label={p.label}
            mangaId={mangaId}
            defaultQuery={mangaTitle}
            entry={entryFor(p.id)}
            onChanged={reload}
          />
        ))}
      </div>
    </div>
  )
}

function ProviderBlock({
  provider,
  label,
  mangaId,
  defaultQuery,
  entry,
  onChanged,
}: {
  provider: ProviderId
  label: string
  mangaId: string
  defaultQuery: string
  entry: TrackingEntry | undefined
  onChanged(): void
}) {
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState(defaultQuery)
  const [results, setResults] = useState<SearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function runSearch() {
    setError(null)
    setBusy(true)
    try {
      const rows = await invoke<SearchResult[]>('search_tracker', { provider, query })
      setResults(rows)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function link(r: SearchResult) {
    try {
      await invoke('link_tracker', {
        mangaId,
        provider,
        remoteId: r.remoteId,
        title: r.title,
      })
      setSearching(false)
      setResults([])
      onChanged()
    } catch (e) {
      setError(String(e))
    }
  }

  async function unlink() {
    try {
      await invoke('unlink_tracker', { mangaId, provider })
      onChanged()
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <section className="rounded-lg border border-white/5 bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">{label}</h3>
        {entry ? (
          <button
            type="button"
            onClick={unlink}
            className="text-xs text-red-400 hover:text-red-300"
          >
            Délier
          </button>
        ) : null}
      </div>

      {entry ? (
        <div className="text-xs text-slate-300">
          <div className="truncate text-slate-100">Lié à « {entry.title} »</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-400">
            <span>Statut : {entry.status ?? '—'}</span>
            <Stars score={entry.score} />
            <span>Progression : {entry.progress ?? 0}</span>
          </div>
        </div>
      ) : !searching ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Non lié</span>
          <button
            type="button"
            onClick={() => {
              setSearching(true)
              void runSearch()
            }}
            className="ml-auto rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white"
          >
            Rechercher & lier
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-raised px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent"
              placeholder="Titre à rechercher"
            />
            <button
              type="button"
              onClick={runSearch}
              disabled={busy}
              className="rounded-lg bg-white/10 px-2 py-1.5 text-xs text-slate-200 disabled:opacity-50"
            >
              {busy ? '…' : 'OK'}
            </button>
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {results.map((r) => (
              <button
                key={r.remoteId}
                type="button"
                onClick={() => link(r)}
                className="flex w-full items-center gap-2 rounded-lg p-1 text-left hover:bg-white/5"
              >
                <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-surface-raised">
                  {r.coverUrl && (
                    <img src={r.coverUrl} alt="" className="h-full w-full object-cover" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-xs text-slate-100">{r.title}</div>
                  <div className="text-[11px] text-slate-500">{r.year ?? ''}</div>
                </div>
              </button>
            ))}
            {!busy && results.length === 0 && (
              <p className="py-2 text-center text-xs text-slate-500">Aucun résultat.</p>
            )}
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </section>
  )
}

function Stars({ score }: { score: number | null }) {
  if (score == null) return <span>Note : —</span>
  return <span>Note : {score}/10</span>
}
