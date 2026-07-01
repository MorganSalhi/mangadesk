import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { useSource } from '../hooks/useSource'
import { useLibraryStore } from '../store/libraryStore'
import { useDownloadStore } from '../store/downloadStore'
import type { Chapter, Manga } from '../types'
import TrackingPanel from '../components/TrackingPanel'
import MigrationModal from '../components/MigrationModal'
import Modal from '../components/ui/Modal'

// ============================================================================
// Page « détail manga » — hub par manga : métadonnées, bascule bibliothèque,
// suivi (AniList/MAL avec le vrai titre), et liste des chapitres (état lu /
// téléchargé + actions lecture / téléchargement).
// Route : /manga/:sourceId/:mangaId
// ============================================================================

const STATUS_LABEL: Record<Manga['status'], string> = {
  ongoing: 'En cours',
  completed: 'Terminé',
  hiatus: 'En pause',
  cancelled: 'Annulé',
  unknown: 'Inconnu',
}

// Forme renvoyée par get_chapters (snake_case).
interface ChapterRow {
  id: string
  manga_id: string
  number: number
  title: string | null
  scanlator: string | null
  date_upload: number | null
  is_read: number
  last_page_read: number
}

function toChapter(r: ChapterRow): Chapter {
  return {
    id: r.id,
    mangaId: r.manga_id,
    number: r.number,
    title: r.title ?? '',
    scanlator: r.scanlator ?? '',
    dateUpload: r.date_upload ?? 0,
    isRead: r.is_read === 1,
    lastPageRead: r.last_page_read,
  }
}

/**
 * Détermine où reprendre la lecture (Bug 3) :
 *  1. dernier chapitre en cours (non lu + page entamée) → à sa page,
 *  2. sinon premier chapitre non lu → page 0,
 *  3. sinon (tout lu) → premier chapitre, page 0.
 */
function getResumeChapter(chapters: Chapter[]): { chapter: Chapter; page: number } | null {
  if (chapters.length === 0) return null
  const sorted = [...chapters].sort((a, b) => a.number - b.number)
  const inProgress = [...sorted].reverse().find((ch) => !ch.isRead && ch.lastPageRead > 0)
  if (inProgress) return { chapter: inProgress, page: inProgress.lastPageRead }
  const firstUnread = sorted.find((ch) => !ch.isRead)
  if (firstUnread) return { chapter: firstUnread, page: 0 }
  return { chapter: sorted[0], page: 0 }
}

/** Map Chapter → ligne snake_case pour `upsert_chapters` (chapitres neufs). */
function toRow(c: Chapter, sourceId: string) {
  return {
    id: c.id,
    manga_id: c.mangaId,
    source_id: sourceId,
    remote_id: c.id,
    number: c.number,
    title: c.title,
    scanlator: c.scanlator,
    date_upload: c.dateUpload,
    is_read: c.isRead ? 1 : 0,
    is_bookmarked: 0,
    last_page_read: c.lastPageRead,
    pages_count: null,
    date_fetch: Date.now(),
  }
}

/** Map Manga → ligne snake_case pour `upsert_manga`. */
function toMangaRow(m: Manga) {
  return {
    id: m.id,
    source_id: m.sourceId,
    remote_id: m.id,
    title: m.title,
    cover_url: m.coverUrl,
    description: m.description,
    author: m.author,
    artist: m.artist,
    status: m.status,
    genres: JSON.stringify(m.genres),
    in_library: m.inLibrary ? 1 : 0,
    date_added: null,
    last_updated: Date.now(),
  }
}

export default function MangaDetail() {
  const { sourceId, mangaId } = useParams<{ sourceId: string; mangaId: string }>()
  const navigate = useNavigate()
  const source = useSource(sourceId ?? '')

  const [manga, setManga] = useState<Manga | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [cover, setCover] = useState<string | undefined>(undefined)
  const [downloadedIds, setDownloadedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showTracking, setShowTracking] = useState(false)
  const [showMigration, setShowMigration] = useState(false)
  const [showCategory, setShowCategory] = useState(false)
  const [pendingCats, setPendingCats] = useState<number[]>([])
  const [libBusy, setLibBusy] = useState(false)

  // Bibliothèque (état réactif + actions).
  const libraryMangas = useLibraryStore((s) => s.mangas)
  const loadLibrary = useLibraryStore((s) => s.loadLibrary)
  const addToLibrary = useLibraryStore((s) => s.addToLibrary)
  const removeFromLibrary = useLibraryStore((s) => s.removeFromLibrary)
  const categories = useLibraryStore((s) => s.categories)
  const loadCategories = useLibraryStore((s) => s.loadCategories)
  const loadMangaCategories = useLibraryStore((s) => s.loadMangaCategories)
  const mangaCategories = useLibraryStore((s) => s.mangaCategories)
  const inLibrary = useMemo(
    () => libraryMangas.some((m) => m.id === mangaId),
    [libraryMangas, mangaId],
  )

  // File de téléchargement (statut par chapitre).
  const queue = useDownloadStore((s) => s.queue)
  const enqueueDownload = useDownloadStore((s) => s.enqueueDownload)
  const queueByChapter = useMemo(
    () => new Map(queue.map((t) => [t.chapterId, t])),
    [queue],
  )

  const refreshDownloaded = useCallback(async () => {
    try {
      const ids = await invoke<string[]>('get_downloaded_chapter_ids')
      setDownloadedIds(new Set(ids))
    } catch {
      /* backend absent */
    }
  }, [])

  // S'assure que l'état bibliothèque est chargé (accès direct par URL possible).
  useEffect(() => {
    if (libraryMangas.length === 0) void loadLibrary()
  }, [libraryMangas.length, loadLibrary])

  // Catégories (pour le bouton « Catégorie » de la fiche).
  useEffect(() => {
    void loadCategories()
    void loadMangaCategories()
  }, [loadCategories, loadMangaCategories])

  // Chargement métadonnées + chapitres.
  useEffect(() => {
    if (!mangaId || !sourceId) return
    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      if (!source) {
        setError('Source introuvable')
        setLoading(false)
        return
      }
      try {
        const details = await source.getMangaDetails(mangaId)
        if (cancelled) return
        setManga(details)

        // Persiste la ligne manga AVANT toute opération sur ses chapitres /
        // historique : chapters.manga_id et history.manga_id ont une FK vers
        // manga(id), donc sans cette upsert les inserts ultérieurs échouent et
        // l'app « oublie » silencieusement (ajout biblio, historique de lecture).
        await invoke('upsert_manga', { manga: toMangaRow(details) }).catch((e) =>
          console.error('[MangaDetail] upsert_manga failed:', e, toMangaRow(details)),
        )

        // Couverture (Rust → base64, repli WebView pour CDN Cloudflare, puis URL).
        invoke<string>('fetch_image_as_base64', {
          url: details.coverUrl,
          headers: {},
          label: details.sourceId ? `cf-${details.sourceId}` : null,
        })
          .then((data) => !cancelled && setCover(data))
          .catch(() => !cancelled && setCover(details.coverUrl))

        // Chapitres : DB d'abord ; sinon source + upsert (chapitres neufs).
        let list: Chapter[] = []
        try {
          const rows = await invoke<ChapterRow[]>('get_chapters', { mangaId })
          if (rows.length) list = rows.map(toChapter)
        } catch {
          /* backend absent */
        }
        if (list.length === 0) {
          list = await source.getChapterList(mangaId)
          await invoke('upsert_chapters', {
            chapters: list.map((c) => toRow(c, sourceId)),
          }).catch((e) => console.error('[MangaDetail] upsert_chapters failed:', e))
        }
        if (cancelled) return
        list = [...list].sort((a, b) => b.number - a.number)
        setChapters(list)
        setLoading(false)
      } catch (e) {
        if (!cancelled) {
          const msg = e instanceof Error ? e.message : String(e)
          setError(`Échec du chargement du manga : ${msg}`)
          setLoading(false)
        }
      }
    })()

    void refreshDownloaded()
    return () => {
      cancelled = true
    }
  }, [mangaId, sourceId, source, refreshDownloaded])

  // Rafraîchit l'état « téléchargé » quand un download se termine.
  useEffect(() => {
    if (queue.some((t) => t.status === 'completed')) void refreshDownloaded()
  }, [queue, refreshDownloaded])

  // Retour à l'écran précédent ; repli sur /library si on est arrivé par URL
  // directe (recharge, deep link) — `history.state.idx` est l'index React Router.
  const handleBack = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
    if (idx > 0) navigate(-1)
    else navigate('/') // route index = Bibliothèque (pas de '/library')
  }, [navigate])

  function readChapter(chapterId: string) {
    navigate(`/reader/${mangaId}/${chapterId}/${sourceId}`)
  }

  function startReading() {
    const resume = getResumeChapter(chapters)
    if (resume && mangaId && sourceId) {
      navigate(
        `/reader/${mangaId}/${resume.chapter.id}/${sourceId}?startPage=${resume.page}`,
      )
    }
  }

  async function toggleLibrary() {
    if (!manga || libBusy) return // garde anti double-clic
    setLibBusy(true)
    try {
      if (inLibrary) await removeFromLibrary(manga.id)
      else await addToLibrary(manga, source ?? undefined)
    } finally {
      setLibBusy(false)
    }
  }

  function openCategory() {
    setPendingCats(mangaId ? (mangaCategories.get(mangaId) ?? []) : [])
    setShowCategory(true)
  }

  async function applyCategory() {
    if (!mangaId) return
    try {
      await invoke('set_manga_categories', {
        mangaId,
        categoryIds: pendingCats.map(Number),
      })
    } catch (e) {
      console.error('[MangaDetail] set_manga_categories failed:', e)
    }
    await loadMangaCategories()
    setShowCategory(false)
  }

  // Met en file tous les chapitres pas encore téléchargés ni en cours.
  function downloadAll() {
    if (!mangaId || !sourceId) return
    for (const c of chapters) {
      if (!downloadedIds.has(c.id) && !queueByChapter.get(c.id)) {
        void enqueueDownload(c.id, mangaId, sourceId)
      }
    }
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-content-2">
        <span className="text-4xl">⚠️</span>
        <p>{error}</p>
        <button
          type="button"
          onClick={() => navigate(-1)}
          className="rounded-lg bg-fill/10 px-4 py-2 text-sm hover:bg-fill/20"
        >
          Retour
        </button>
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-y-auto">
      {/* Barre de retour (sticky) — toujours un moyen de revenir sans la sidebar. */}
      <div className="sticky top-0 z-20 flex items-center gap-2 border-b border-line/5 bg-surface/90 px-4 py-2 backdrop-blur">
        <button
          type="button"
          onClick={handleBack}
          aria-label="Retour"
          className="flex h-8 w-8 items-center justify-center rounded-full text-lg text-content hover:bg-fill/10"
        >
          ←
        </button>
        <span className="truncate text-sm font-medium text-content-2">
          {manga?.title ?? ''}
        </span>
      </div>

      {/* En-tête */}
      <header className="flex flex-col gap-6 px-8 pt-6 sm:flex-row">
        <div className="mx-auto h-64 w-44 shrink-0 overflow-hidden rounded-xl bg-surface-raised sm:mx-0">
          {cover ? (
            <img src={cover} alt={manga?.title ?? ''} className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full animate-pulse bg-fill/10" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-content">
            {manga?.title ?? (loading ? 'Chargement…' : '')}
          </h1>
          {manga && (
            <p className="mt-1 text-sm text-content-3">
              {[manga.author, manga.artist].filter(Boolean).join(' · ')}
            </p>
          )}

          {manga && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-medium text-accent">
                {STATUS_LABEL[manga.status]}
              </span>
              {manga.genres.map((g) => (
                <span
                  key={g}
                  className="rounded-full bg-fill/5 px-2.5 py-0.5 text-xs text-content-2"
                >
                  {g}
                </span>
              ))}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startReading}
              disabled={chapters.length === 0}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Lire
            </button>
            <button
              type="button"
              onClick={toggleLibrary}
              disabled={!manga || libBusy}
              className={[
                'rounded-lg px-4 py-2 text-sm font-medium',
                inLibrary
                  ? 'bg-fill/10 text-content hover:bg-fill/20'
                  : 'bg-fill/5 text-content-2 hover:bg-fill/10',
              ].join(' ')}
            >
              {inLibrary ? '✓ Dans la bibliothèque' : '+ Ajouter'}
            </button>
            {inLibrary && (
              <button
                type="button"
                onClick={openCategory}
                className="rounded-lg bg-fill/5 px-4 py-2 text-sm font-medium text-content-2 hover:bg-fill/10"
                title="Changer de catégorie"
              >
                ☰ Catégorie
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowTracking(true)}
              disabled={!manga}
              className="rounded-lg bg-fill/5 px-4 py-2 text-sm font-medium text-content-2 hover:bg-fill/10"
            >
              ★ Suivi
            </button>
            <button
              type="button"
              onClick={() => setShowMigration(true)}
              disabled={!manga}
              className="rounded-lg bg-fill/5 px-4 py-2 text-sm font-medium text-content-2 hover:bg-fill/10"
              title="Migrer vers une autre source"
            >
              ⇄ Migrer
            </button>
          </div>

          {manga?.description && (
            <p className="mt-4 max-w-2xl whitespace-pre-line text-sm leading-relaxed text-content-2">
              {manga.description}
            </p>
          )}
        </div>
      </header>

      {/* Liste des chapitres */}
      <section className="px-8 py-6">
        <div className="mb-2 flex items-center gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-content-3">
            Chapitres ({chapters.length})
          </h2>
          {chapters.length > 0 && (
            <button
              type="button"
              onClick={downloadAll}
              className="ml-auto rounded-lg bg-fill/5 px-3 py-1 text-xs font-medium text-content-2 hover:bg-fill/10"
              title="Mettre tous les chapitres non téléchargés en file"
            >
              ↓ Tout télécharger
            </button>
          )}
        </div>
        {loading && chapters.length === 0 ? (
          <p className="py-8 text-center text-sm text-content-4">Chargement…</p>
        ) : chapters.length === 0 ? (
          <p className="py-8 text-center text-sm text-content-4">Aucun chapitre.</p>
        ) : (
          <div className="flex flex-col divide-y divide-line/5">
            {chapters.map((c) => {
              const task = queueByChapter.get(c.id)
              const downloaded = downloadedIds.has(c.id)
              return (
                <div key={c.id} className="flex items-center gap-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => readChapter(c.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div
                      className={[
                        'truncate text-sm',
                        c.isRead ? 'text-content-4' : 'text-content',
                      ].join(' ')}
                    >
                      Chapitre {c.number}
                      {c.title ? ` · ${c.title}` : ''}
                    </div>
                    <div className="truncate text-xs text-content-4">
                      {c.scanlator || '—'}
                      {c.lastPageRead > 0 && !c.isRead ? ` · page ${c.lastPageRead + 1}` : ''}
                    </div>
                  </button>

                  <ChapterDownloadButton
                    downloaded={downloaded}
                    status={task?.status}
                    progress={task ? `${task.progress}/${task.total || '?'}` : ''}
                    onDownload={() => {
                      if (mangaId && sourceId) void enqueueDownload(c.id, mangaId, sourceId)
                    }}
                  />
                </div>
              )
            })}
          </div>
        )}
      </section>

      {showCategory && (
        <Modal title="Changer de catégorie" onClose={() => setShowCategory(false)}>
          {categories.length === 0 ? (
            <p className="mb-4 text-sm text-content-3">
              Aucune catégorie. Créez-en une depuis la bibliothèque.
            </p>
          ) : (
            <div className="mb-4 flex flex-col gap-1">
              {categories.map((cat) => (
                <label
                  key={cat.id}
                  className="flex cursor-pointer items-center gap-2 text-sm text-content"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={pendingCats.includes(cat.id)}
                    onChange={() =>
                      setPendingCats((prev) =>
                        prev.includes(cat.id)
                          ? prev.filter((id) => id !== cat.id)
                          : [...prev, cat.id],
                      )
                    }
                  />
                  {cat.name}
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCategory(false)}
              className="rounded-lg px-3 py-2 text-sm text-content-3 hover:text-content"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={applyCategory}
              disabled={categories.length === 0}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Appliquer
            </button>
          </div>
        </Modal>
      )}

      {showTracking && manga && (
        <TrackingPanel
          mangaId={manga.id}
          mangaTitle={manga.title}
          onClose={() => setShowTracking(false)}
        />
      )}

      {showMigration && manga && (
        <MigrationModal
          manga={manga}
          onClose={() => setShowMigration(false)}
          onSuccess={(targetMangaId, targetSourceId) => {
            setShowMigration(false)
            // Recharge la bibliothèque avant de naviguer pour que l'état du
            // bouton "Dans la bibliothèque" soit correct sur la fiche cible.
            void loadLibrary()
            navigate(`/manga/${targetSourceId}/${targetMangaId}`, { replace: true })
          }}
        />
      )}
    </div>
  )
}

function ChapterDownloadButton({
  downloaded,
  status,
  progress,
  onDownload,
}: {
  downloaded: boolean
  status?: string
  progress: string
  onDownload(): void
}) {
  if (downloaded || status === 'completed') {
    return (
      <span
        className="flex h-8 w-8 items-center justify-center rounded-lg text-green-500"
        title="Téléchargé"
      >
        ✓
      </span>
    )
  }
  if (status === 'downloading' || status === 'queued' || status === 'paused') {
    return (
      <span className="px-2 text-xs text-content-3" title="En file">
        {status === 'downloading' ? progress : '…'}
      </span>
    )
  }
  return (
    <button
      type="button"
      onClick={onDownload}
      aria-label="Télécharger le chapitre"
      title="Télécharger"
      className="flex h-8 w-8 items-center justify-center rounded-lg bg-fill/5 text-sm text-content-2 hover:bg-fill/10"
    >
      ↓
    </button>
  )
}
