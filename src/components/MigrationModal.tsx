import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { SOURCE_REGISTRY } from '../hooks/useSource'
import { toMangaRow } from '../lib/dbRows'
import type { Chapter, Manga, MangaPreview, Source } from '../types'

// ============================================================================
// Modal de migration d'un manga vers une autre source (session 4B).
// Trois étapes : (1) choix de la source cible, (2) recherche + sélection
// d'un manga correspondant, (3) confirmation + appel de `migrate_manga` (Rust)
// qui exécute toute la séquence en transaction atomique.
// ============================================================================

interface ChapterRow {
  id: string
  number: number
  is_read: number
  last_page_read: number
}

interface MigrationResult {
  chaptersMigrated: number
  chaptersNotFound: number
  historyEntriesMigrated: number
}

interface MigrationModalProps {
  manga: Manga
  onClose(): void
  onSuccess(targetMangaId: string, targetSourceId: string): void
}

type Step = 'pick-source' | 'pick-match' | 'confirm' | 'running' | 'done' | 'error'

export default function MigrationModal({ manga, onClose, onSuccess }: MigrationModalProps) {
  const [step, setStep] = useState<Step>('pick-source')
  const [targetSource, setTargetSource] = useState<Source | null>(null)
  const [matchQuery, setMatchQuery] = useState(manga.title)
  const [matches, setMatches] = useState<MangaPreview[]>([])
  const [matchesLoading, setMatchesLoading] = useState(false)
  const [matchesError, setMatchesError] = useState<string | null>(null)
  const [selectedMatch, setSelectedMatch] = useState<MangaPreview | null>(null)

  const [targetManga, setTargetManga] = useState<Manga | null>(null)
  const [sourceChapters, setSourceChapters] = useState<ChapterRow[]>([])
  const [targetChapters, setTargetChapters] = useState<Chapter[]>([])
  const [result, setResult] = useState<MigrationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const availableSources = useMemo(
    () => Object.values(SOURCE_REGISTRY).filter((s) => s.id !== manga.sourceId),
    [manga.sourceId],
  )

  // Échap ferme le modal (sauf pendant une saisie).
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

  // Recherche dans la source cible (5 premiers résultats).
  useEffect(() => {
    if (step !== 'pick-match' || !targetSource) return
    let cancelled = false
    setMatchesLoading(true)
    setMatchesError(null)
    targetSource
      .search(matchQuery, 1, {})
      .then((res) => {
        if (cancelled) return
        setMatches(res.mangas.slice(0, 5))
        setMatchesLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setMatchesError('Échec de la recherche dans la source cible.')
        setMatchesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [step, targetSource, matchQuery])

  // Préparation de l'étape confirmation : on récupère détails + chapitres des deux côtés
  // pour calculer le résumé (mappage par numéro de chapitre).
  async function prepareConfirm(match: MangaPreview): Promise<void> {
    if (!targetSource) return
    setSelectedMatch(match)
    setStep('confirm')
    setError(null)
    try {
      const [target, srcRows] = await Promise.all([
        targetSource.getMangaDetails(match.id),
        invoke<ChapterRow[]>('get_chapters', { mangaId: manga.id }).catch(() => []),
      ])
      const tgtChapters = await targetSource.getChapterList(target.id)
      setTargetManga(target)
      setSourceChapters(srcRows)
      setTargetChapters(tgtChapters)
    } catch (e) {
      console.error('[migration] préparation échouée', e)
      setError('Impossible de préparer la migration (source ou réseau).')
      setStep('error')
    }
  }

  // Mappage chapitre source → chapitre cible par `number`.
  const mapping = useMemo(() => {
    const byNumber = new Map<number, Chapter>()
    for (const c of targetChapters) byNumber.set(c.number, c)
    let matched = 0
    let unmatched = 0
    const items = sourceChapters.map((sc) => {
      const t = byNumber.get(sc.number)
      if (t) matched++
      else unmatched++
      return {
        sourceChapterId: sc.id,
        targetChapterId: t?.id ?? null,
        isRead: sc.is_read,
        lastPageRead: sc.last_page_read,
        number: sc.number,
      }
    })
    return { items, matched, unmatched }
  }, [sourceChapters, targetChapters])

  async function runMigration(): Promise<void> {
    if (!targetManga) return
    setStep('running')
    setError(null)
    try {
      const res = await invoke<MigrationResult>('migrate_manga', {
        sourceMangaId: manga.id,
        // La cible entre en bibliothèque quel que soit son flag d'origine.
        targetManga: toMangaRow(targetManga, { inLibrary: true }),
        chapterMapping: mapping.items.map((m) => ({
          sourceChapterId: m.sourceChapterId,
          targetChapterId: m.targetChapterId,
          isRead: m.isRead,
          lastPageRead: m.lastPageRead,
        })),
        readingStats: true,
      })
      setResult(res)
      setStep('done')
    } catch (e) {
      console.error('[migration] migrate_manga a échoué', e)
      setError(typeof e === 'string' ? e : 'Migration échouée.')
      setStep('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-line/10 bg-surface-raised p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Migration de manga"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-content">Migrer le manga</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="text-content-3 hover:text-content"
          >
            ✕
          </button>
        </header>

        {step === 'pick-source' && (
          <div>
            <p className="mb-3 text-sm text-content-2">
              Choisissez la source vers laquelle migrer « {manga.title} ».
            </p>
            {availableSources.length === 0 ? (
              <p className="text-sm text-content-4">Aucune autre source disponible.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {availableSources.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setTargetSource(s)
                        setStep('pick-match')
                      }}
                      className="flex w-full items-center justify-between rounded-lg bg-fill/5 px-3 py-2 text-sm text-content hover:bg-fill/10"
                    >
                      <span>{s.name}</span>
                      <span className="text-xs text-content-4">{s.lang}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === 'pick-match' && targetSource && (
          <div>
            <p className="mb-3 text-sm text-content-2">
              Sélectionnez le manga correspondant dans <strong>{targetSource.name}</strong>.
            </p>
            <div className="mb-3 flex gap-2">
              <input
                value={matchQuery}
                onChange={(e) => setMatchQuery(e.target.value)}
                placeholder="Recherche…"
                className="min-w-0 flex-1 rounded-lg border border-line/10 bg-surface px-3 py-1.5 text-sm text-content outline-none focus:border-accent"
              />
            </div>

            {matchesLoading ? (
              <p className="py-6 text-center text-sm text-content-4">Recherche…</p>
            ) : matchesError ? (
              <p className="py-6 text-center text-sm text-content-4">{matchesError}</p>
            ) : matches.length === 0 ? (
              <p className="py-6 text-center text-sm text-content-4">Aucun résultat.</p>
            ) : (
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
                {matches.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => void prepareConfirm(m)}
                      className="flex w-full items-center gap-3 rounded-lg bg-fill/5 px-3 py-2 text-left hover:bg-fill/10"
                    >
                      <span className="block h-12 w-9 shrink-0 overflow-hidden rounded bg-surface">
                        {m.coverUrl ? (
                          <img
                            src={m.coverUrl}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-content">
                        {m.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex justify-between">
              <button
                type="button"
                onClick={() => setStep('pick-source')}
                className="rounded-lg bg-fill/5 px-3 py-1.5 text-sm text-content-2 hover:bg-fill/10"
              >
                ← Retour
              </button>
            </div>
          </div>
        )}

        {step === 'confirm' && targetSource && selectedMatch && (
          <div>
            <div className="mb-3 rounded-lg border border-line/5 bg-surface px-3 py-2 text-sm">
              <div className="text-content-3">
                Source actuelle : <span className="text-content">{manga.sourceId}</span>
              </div>
              <div className="text-content-3">
                Source cible : <span className="text-content">{targetSource.name}</span>
              </div>
              <div className="mt-1 truncate text-content">{selectedMatch.title}</div>
            </div>

            {!targetManga ? (
              <p className="py-6 text-center text-sm text-content-4">
                Préparation de la migration…
              </p>
            ) : (
              <div className="space-y-2 text-sm text-content-2">
                <p>
                  Chapitres transférables : <strong>{mapping.matched}</strong> /{' '}
                  {sourceChapters.length}
                </p>
                {mapping.unmatched > 0 && (
                  <p className="text-amber-400">
                    ⚠️ {mapping.unmatched} chapitre(s) sans correspondance — leur état (lu /
                    progression) ne sera pas transféré.
                  </p>
                )}
                <p className="text-content-3">
                  Les statistiques de lecture, l'historique et les catégories sont conservés.
                </p>
              </div>
            )}

            <div className="mt-4 flex justify-between gap-2">
              <button
                type="button"
                onClick={() => setStep('pick-match')}
                className="rounded-lg bg-fill/5 px-3 py-1.5 text-sm text-content-2 hover:bg-fill/10"
              >
                ← Retour
              </button>
              <button
                type="button"
                disabled={!targetManga}
                onClick={() => void runMigration()}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Migrer
              </button>
            </div>
          </div>
        )}

        {step === 'running' && (
          <p className="py-6 text-center text-sm text-content-2">Migration en cours…</p>
        )}

        {step === 'done' && result && targetManga && (
          <div>
            <p className="mb-3 text-sm text-content-2">
              Migration terminée. {result.chaptersMigrated} chapitre(s) transférés,{' '}
              {result.historyEntriesMigrated} entrée(s) d'historique copiées
              {result.chaptersNotFound > 0
                ? ` (${result.chaptersNotFound} sans correspondance)`
                : ''}
              .
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => onSuccess(targetManga.id, targetManga.sourceId)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
              >
                Ouvrir le manga migré
              </button>
            </div>
          </div>
        )}

        {step === 'error' && (
          <div>
            <p className="mb-3 text-sm text-red-400">{error}</p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-fill/5 px-4 py-2 text-sm text-content-2 hover:bg-fill/10"
              >
                Fermer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
