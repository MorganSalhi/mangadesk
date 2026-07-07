import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import pLimit from 'p-limit'
import { useSource } from '../hooks/useSource'
import { toChapter, type ChapterRow } from '../lib/dbRows'
import { useReaderStore } from '../store/readerStore'
import { useSettingsStore } from '../store/settingsStore'
import { useDownloadStore } from '../store/downloadStore'
import TrackingPanel from '../components/TrackingPanel'
import type { Chapter, Page, ReaderSettings } from '../types'

interface TrackingEntry {
  provider: string
  progress: number | null
}

/**
 * Synchro tracking « fire-and-forget » après lecture d'un chapitre.
 * On ne pousse que si la progression du chapitre dépasse celle du tracker.
 */
async function syncTracking(mangaId: string, chapterNumber: number): Promise<void> {
  try {
    const tracking = await invoke<TrackingEntry[]>('get_manga_tracking', { mangaId })
    for (const tracker of tracking) {
      if (chapterNumber > (tracker.progress ?? 0)) {
        invoke('sync_tracker_progress', {
          mangaId,
          provider: tracker.provider,
          progress: Math.floor(chapterNumber),
        }).catch(console.error)
      }
    }
  } catch {
    /* pas de backend / pas de tracking */
  }
}

const BG_PRESETS: { label: string; value: string }[] = [
  { label: 'Noir', value: '#000000' },
  { label: 'Blanc', value: '#ffffff' },
  { label: 'Gris foncé', value: '#15171d' },
  { label: 'Sépia', value: '#f4ecd8' },
]

function scaleStyle(
  scaleType: ReaderSettings['scaleType'],
  zoom: number,
): React.CSSProperties {
  switch (scaleType) {
    case 'fit-page':
      return { maxWidth: '100%', maxHeight: '100vh' }
    case 'fit-width':
      return { width: '100%', height: 'auto' }
    case 'fit-height':
      return { height: '100vh', width: 'auto' }
    case 'original':
      return { transform: `scale(${zoom})`, transformOrigin: 'center top' }
  }
}

function range(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i)
}

export default function Reader() {
  const { mangaId, chapterId, sourceId } = useParams<{
    mangaId: string
    chapterId: string
    sourceId: string
  }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  // Page de reprise transmise par le bouton « Lire » de la fiche manga.
  const startPage = parseInt(searchParams.get('startPage') ?? '0', 10) || 0
  const source = useSource(sourceId ?? '')

  const settings = useSettingsStore((s) => s.readerSettings)
  const updateReaderSettings = useSettingsStore((s) => s.updateReaderSettings)
  const incognitoMode = useSettingsStore((s) => s.incognitoMode)

  // Sélecteurs granulaires (actions stables → safe en deps).
  const initChapter = useReaderStore((s) => s.initChapter)
  const setChapterList = useReaderStore((s) => s.setChapterList)
  const setPages = useReaderStore((s) => s.setPages)
  const setLoadedPage = useReaderStore((s) => s.setLoadedPage)
  const setCurrentPage = useReaderStore((s) => s.setCurrentPage)
  const setLoading = useReaderStore((s) => s.setLoading)
  const setError = useReaderStore((s) => s.setError)
  const setFullscreenStore = useReaderStore((s) => s.setFullscreen)
  const setHudVisible = useReaderStore((s) => s.setHudVisible)

  const pages = useReaderStore((s) => s.pages)
  const loadedPages = useReaderStore((s) => s.loadedPages)
  const currentPage = useReaderStore((s) => s.currentPage)
  const totalPages = useReaderStore((s) => s.totalPages)
  const chapterList = useReaderStore((s) => s.chapterList)
  const currentChapterIndex = useReaderStore((s) => s.currentChapterIndex)
  const isLoading = useReaderStore((s) => s.isLoading)
  const error = useReaderStore((s) => s.error)
  const isFullscreen = useReaderStore((s) => s.isFullscreen)
  const isHudVisible = useReaderStore((s) => s.isHudVisible)

  const enqueueDownload = useDownloadStore((s) => s.enqueueDownload)

  const [showSettings, setShowSettings] = useState(false)
  const [showTracking, setShowTracking] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [boundary, setBoundary] = useState<null | 'next' | 'prev'>(null)
  // `isReady` passe à true une fois la page de reprise appliquée (ou déterminée
  // comme non applicable). Tant qu'il est false, la sauvegarde de position est
  // suspendue — sinon, à l'arrivée des pages, currentPage = 0 serait écrit en DB
  // et écraserait la position de reprise (cf. bug 1).
  const [isReady, setIsReady] = useState(false)

  const mountTime = useRef(Date.now())
  const fetchLimit = useRef(pLimit(4))
  const inflight = useRef<Set<number>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageEls = useRef<Map<number, HTMLElement>>(new Map())
  // Debounce du masquage HUD en plein écran (cf. showHud).
  const hudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isWebtoon = settings.readingMode === 'webtoon' || settings.readingMode === 'vertical'
  const isRtl = settings.readingMode === 'rtl'

  // Affiche le HUD et programme son masquage 2 s plus tard. Uniquement utile en
  // plein écran ; en mode fenêtré le HUD reste affiché en permanence (sauf
  // bascule manuelle via clic central).
  const showHud = useCallback(() => {
    setHudVisible(true)
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current)
    hudTimerRef.current = setTimeout(() => setHudVisible(false), 2000)
  }, [setHudVisible])

  // À la sortie du Reader on s'assure que la sidebar redevient visible.
  useEffect(() => {
    return () => {
      if (hudTimerRef.current) clearTimeout(hudTimerRef.current)
      setFullscreenStore(false)
      setHudVisible(true)
    }
  }, [setFullscreenStore, setHudVisible])

  // -- Résolution de la source image d'une page -------------------------------
  const resolvePageSrc = useCallback(
    async (page: Page): Promise<string> => {
      // 0. Image déjà inline (data URI) : sources qui capturent les octets
      //    elles-mêmes (ex. Scan-Manga récolte les blob: du lecteur). Rien à faire.
      if (page.imageUrl.startsWith('data:')) return page.imageUrl
      // 1. Chapitre téléchargé localement ? → protocole asset, sans réseau.
      if (mangaId && chapterId && sourceId) {
        try {
          const local = await invoke<string | null>('get_local_page_path', {
            sourceId,
            mangaId,
            chapterId,
            index: page.index,
          })
          if (local) return convertFileSrc(local)
        } catch {
          /* backend absent ou page non téléchargée → on bascule sur le réseau */
        }
      }
      // 2. Sinon réseau via Rust (CORS/referer contournés), fallback URL directe.
      try {
        return await invoke<string>('fetch_image_as_base64', {
          url: page.imageUrl,
          headers: page.headers ?? {},
          // Repli WebView pour les CDN images derrière Cloudflare (session solveur
          // de la source). Sans fenêtre solveur (sources non-CF), sans effet.
          label: sourceId ? `cf-${sourceId}` : null,
        })
      } catch {
        // Backend absent : on utilise l'URL directe (fonctionne en `pnpm dev`).
        return page.imageUrl
      }
    },
    [mangaId, chapterId, sourceId],
  )

  const ensureLoaded = useCallback(
    (indices: number[]) => {
      const { pages: allPages, loadedPages: loaded } = useReaderStore.getState()
      for (const index of indices) {
        if (index < 0 || index >= allPages.length) continue
        if (loaded.has(index) || inflight.current.has(index)) continue
        inflight.current.add(index)
        void fetchLimit.current(async () => {
          const src = await resolvePageSrc(allPages[index])
          setLoadedPage(index, src)
          inflight.current.delete(index)
        })
      }
    },
    [resolvePageSrc, setLoadedPage],
  )

  // -- Chargement du chapitre (liste chapitres + pages) -----------------------
  useEffect(() => {
    if (!mangaId || !chapterId || !sourceId) return
    let cancelled = false
    inflight.current = new Set()
    pageEls.current = new Map()
    mountTime.current = Date.now()
    setIsReady(false)
    initChapter({ mangaId, sourceId, chapterId })
    setZoom(1)

    void (async () => {
      // Liste complète des chapitres (SQLite, fallback source).
      let chapters: Chapter[] = []
      try {
        const rows = await invoke<ChapterRow[]>('get_chapters', { mangaId })
        if (rows.length) chapters = rows.map(toChapter)
      } catch {
        /* backend absent */
      }
      if (chapters.length === 0 && source) {
        try {
          chapters = await source.getChapterList(mangaId)
        } catch {
          /* ignore */
        }
      }
      chapters = [...chapters].sort((a, b) => a.number - b.number)
      if (cancelled) return
      setChapterList(chapters)

      // Pages du chapitre.
      if (!source) {
        setError('Source introuvable')
        return
      }
      try {
        const pageList = await source.getPageList(chapterId)
        if (cancelled) return
        setPages(pageList)
        setLoading(false)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!cancelled) setError(`Échec du chargement des pages : ${msg}`)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    mangaId,
    chapterId,
    sourceId,
    source,
    initChapter,
    setChapterList,
    setPages,
    setLoading,
    setError,
  ])

  // -- Reprise à la page transmise (?startPage) une fois les pages chargées ----
  // Le ready-flag conditionne ensuite la sauvegarde de position (sinon, la page
  // 0 affichée pendant le chargement écraserait la position transmise via URL).
  useEffect(() => {
    if (pages.length === 0 || isReady) return
    if (startPage > 0) {
      const clamped = Math.min(startPage, pages.length - 1)
      setCurrentPage(clamped)
      if (isWebtoon) {
        // Best-effort : faire défiler jusqu'à la page (élément déjà monté ou non).
        requestAnimationFrame(() => pageEls.current.get(clamped)?.scrollIntoView())
      }
    }
    setIsReady(true)
  }, [pages.length, startPage, isWebtoon, isReady, setCurrentPage])

  // -- Préchargement -----------------------------------------------------------
  useEffect(() => {
    if (pages.length === 0) return
    if (isWebtoon) {
      ensureLoaded(pages.map((p) => p.index))
    } else {
      ensureLoaded(range(currentPage, settings.preloadCount + 1))
    }
  }, [pages, currentPage, isWebtoon, settings.preloadCount, ensureLoaded])

  // -- Sauvegarde de position -------------------------------------------------
  // Dernière page → mark_chapter_read (is_read = 1). Sinon → progression seule
  // (is_read inchangé), pour que la reprise fonctionne (cf. getResumeChapter).
  // Guard incognito : aucune trace n'est écrite tant que le flag est actif.
  // Guard isReady : on n'écrit rien tant que la page de reprise n'est pas
  // appliquée (sinon on écraserait lastPageRead avec 0 — cf. bug 1).
  useEffect(() => {
    if (totalPages === 0 || !chapterId || incognitoMode || !isReady) return
    const delay = isWebtoon ? 1000 : 0
    const atEnd = currentPage >= totalPages - 1
    const t = window.setTimeout(() => {
      const cmd = atEnd ? 'mark_chapter_read' : 'update_chapter_progress'
      void invoke(cmd, { chapterId, lastPage: currentPage }).catch(() => {})
    }, delay)
    return () => window.clearTimeout(t)
  }, [currentPage, totalPages, chapterId, isWebtoon, incognitoMode, isReady])

  // -- Sauvegarde à la fermeture (historique systématique + complétion) --------
  // Snapshot d'incognito au moment de la fermeture pour rester cohérent avec
  // l'état au cours de la lecture (le cleanup ne se ré-exécute pas si le flag
  // change pendant la lecture, c'est attendu : on respecte l'état initial).
  useEffect(() => {
    return () => {
      const { currentPage: cp, totalPages: tp, chapterList: list, currentChapterIndex: idx } =
        useReaderStore.getState()
      const incognitoNow = useSettingsStore.getState().incognitoMode
      if (incognitoNow) return
      if (tp > 0 && chapterId && mangaId) {
        const duration = Math.round((Date.now() - mountTime.current) / 1000)
        const atEnd = cp >= tp - 1
        void invoke('add_history_entry', { chapterId, mangaId, duration }).catch((err) =>
          console.error('[Reader] history insert failed:', err),
        )
        // Filet de sécurité : pour les chapitres non terminés on persiste la
        // dernière position connue (la useEffect de progression est debouncée
        // 1 s en webtoon, donc peut ne pas s'être déclenchée avant la
        // fermeture). Sans ça la reprise serait imprécise — bug 1 résiduel.
        if (!atEnd) {
          void invoke('update_chapter_progress', { chapterId, lastPage: cp }).catch(() => {})
        }
        // Complétion (dernière page) : marquer lu + tracking.
        if (atEnd) {
          void invoke('mark_chapter_read', { chapterId, lastPage: cp }).catch((err) =>
            console.error('[Reader] mark_read failed:', err),
          )
          const chapter = list[idx]
          if (chapter) void syncTracking(mangaId, chapter.number)
        }
        // Stats : on ignore les passages éclair (< 5 s = navigation accidentelle)
        // pour éviter de polluer le classement (bug 4).
        if (duration >= 5) {
          void invoke('update_reading_stats', { mangaId, seconds: duration }).catch((err) =>
            console.error('[Reader] reading_stats failed:', err),
          )
        }
      }
    }
  }, [chapterId, mangaId])

  // -- Navigation pages / chapitres -------------------------------------------
  const goToChapter = useCallback(
    (dir: 'next' | 'prev') => {
      const target = dir === 'next' ? currentChapterIndex + 1 : currentChapterIndex - 1
      const chapter = chapterList[target]
      if (chapter && mangaId && sourceId) {
        navigate(`/reader/${mangaId}/${chapter.id}/${sourceId}`)
      }
      setBoundary(null)
    },
    [chapterList, currentChapterIndex, mangaId, sourceId, navigate],
  )

  const goNext = useCallback(() => {
    if (currentPage < totalPages - 1) setCurrentPage(currentPage + 1)
    else setBoundary('next')
  }, [currentPage, totalPages, setCurrentPage])

  const goPrev = useCallback(() => {
    if (currentPage > 0) setCurrentPage(currentPage - 1)
    else setBoundary('prev')
  }, [currentPage, setCurrentPage])

  // Auto-navigation après 3s sur l'overlay de fin/début de chapitre.
  useEffect(() => {
    if (!boundary) return
    const t = window.setTimeout(() => goToChapter(boundary), 3000)
    return () => window.clearTimeout(t)
  }, [boundary, goToChapter])

  // -- Plein écran -------------------------------------------------------------
  // Toggle synchronisé : OS (Tauri) + store (`isFullscreen`, lu par App.tsx
  // pour masquer la sidebar). À l'entrée le HUD est masqué (mode immersif) ;
  // à la sortie il revient (setFullscreen le gère).
  const toggleFullscreen = useCallback(async () => {
    let next = !isFullscreen
    try {
      const w = getCurrentWindow()
      const fs = await w.isFullscreen()
      next = !fs
      await w.setFullscreen(next)
    } catch {
      /* hors Tauri : on bascule quand même l'état immersif */
    }
    setFullscreenStore(next)
    if (hudTimerRef.current) clearTimeout(hudTimerRef.current)
  }, [isFullscreen, setFullscreenStore])

  // -- Raccourcis clavier ------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ne pas capter les raccourcis pendant une saisie (recherche tracking,
      // sélecteur de couleur, etc.) — sinon les flèches changent de page et Échap
      // quitte le lecteur au lieu d'agir sur le champ.
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          goPrev()
          break
        case 'ArrowRight':
        case 'd':
        case 'D':
          goNext()
          break
        case 'f':
        case 'F':
          void toggleFullscreen()
          break
        case 'm':
        case 'M': {
          const order: ReaderSettings['readingMode'][] = ['ltr', 'rtl', 'webtoon']
          const idx = order.indexOf(settings.readingMode)
          const next = order[(idx + 1) % order.length] ?? 'ltr'
          updateReaderSettings({ readingMode: next })
          break
        }
        case 'Escape':
          // Échap ferme d'abord un panneau ouvert, sinon quitte le lecteur.
          if (showTracking) setShowTracking(false)
          else if (showSettings) setShowSettings(false)
          else navigate(-1)
          break
        case '+':
        case '=':
          if (settings.scaleType === 'original') setZoom((z) => z + 0.1)
          break
        case '-':
          if (settings.scaleType === 'original') setZoom((z) => Math.max(0.1, z - 0.1))
          break
        case '0':
          setZoom(1)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    goNext,
    goPrev,
    toggleFullscreen,
    navigate,
    settings.readingMode,
    settings.scaleType,
    updateReaderSettings,
    showSettings,
    showTracking,
  ])

  // -- Webtoon : page courante synchronisée avec le défilement manuel ----------
  // Le slider latéral dérive de `currentPage` ; il faut donc mettre celui-ci à
  // jour quand l'utilisateur scrolle. On lit `pageEls` EN DIRECT à chaque scroll
  // (page dont la ligne du haut traverse le bord supérieur), ce qui reste correct
  // malgré le remplacement placeholder→img des pages — alors qu'un
  // IntersectionObserver figé à l'arrivée des `pages` finissait par observer des
  // nœuds détachés (les placeholders) et ne se déclenchait plus une fois les
  // images chargées (slider bloqué).
  useEffect(() => {
    if (!isWebtoon || pages.length === 0) return
    const root = scrollRef.current
    if (!root) return
    let raf = 0
    const update = () => {
      raf = 0
      const ref = root.getBoundingClientRect().top + 1
      let best = -1
      pageEls.current.forEach((el, idx) => {
        const r = el.getBoundingClientRect()
        if (r.top <= ref && r.bottom > ref) best = idx
      })
      if (best >= 0 && best !== useReaderStore.getState().currentPage) {
        setCurrentPage(best)
      }
    }
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(update)
    }
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [isWebtoon, pages.length, setCurrentPage])

  // -- Zones de clic (paged) ---------------------------------------------------
  function handleZoneClick(zone: 'left' | 'center' | 'right') {
    if (zone === 'center') {
      // En plein écran : on rafraîchit juste le timer (le mouvement de souris
      // gère déjà la visibilité). Sinon : toggle manuel comme avant.
      if (isFullscreen) showHud()
      else setHudVisible(!isHudVisible)
      return
    }
    // RTL : gauche = suivant, droite = précédent.
    const isPrev = isRtl ? zone === 'right' : zone === 'left'
    if (isPrev) goPrev()
    else goNext()
  }

  const bg = settings.backgroundColor
  // En plein écran, la souris immobile masque le curseur — uniquement utile
  // quand le HUD est masqué (sinon on a un curseur sur les boutons).
  const cursorClass = isFullscreen && !isHudVisible ? 'cursor-none' : ''
  // En mode fenêtré le HUD est toujours visible (bug 6) ; en plein écran le
  // store le masque/dévoile via mousemove + debounce.
  const hudVisible = !isFullscreen || isHudVisible

  return (
    <div
      className={`flex h-screen w-full flex-col ${cursorClass}`}
      style={{ backgroundColor: bg }}
      onMouseMove={isFullscreen ? showHud : undefined}
    >
      {/* HUD supérieur — DANS le flux (bug 6) : les images en dessous ne sont
          jamais masquées. En plein écran, on retire entièrement du flux pour
          immerger ; en fenêtré on garde la barre visible. */}
      {hudVisible && (
        <div className="flex h-14 flex-none items-center gap-3 bg-black/80 px-4 text-white">
          <button type="button" onClick={() => navigate(-1)} aria-label="Retour" className="text-xl">
            ←
          </button>
          <span className="truncate text-sm">
            {mangaId} · Chapitre {chapterList[currentChapterIndex]?.number ?? '—'}
          </span>
          <button
            type="button"
            onClick={() => {
              if (chapterId && mangaId && sourceId) {
                void enqueueDownload(chapterId, mangaId, sourceId)
              }
            }}
            className="ml-auto text-lg"
            aria-label="Télécharger ce chapitre"
            title="Télécharger ce chapitre"
          >
            ↓
          </button>
          <button
            type="button"
            onClick={() => setShowTracking(true)}
            className="text-lg"
            aria-label="Suivi du manga"
            title="Suivi (AniList / MAL)"
          >
            ★
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="text-lg"
            aria-label="Paramètres du lecteur"
            title="Paramètres"
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            className="text-lg"
            aria-label={isFullscreen ? 'Quitter plein écran' : 'Plein écran'}
            title={isFullscreen ? 'Quitter plein écran (F)' : 'Plein écran (F)'}
          >
            ⛶
          </button>
        </div>
      )}

      {/* Zone de lecture — prend tout l'espace restant. Le bandeau incognito,
          le spinner et l'overlay de fin de chapitre sont positionnés en
          absolute à L'INTÉRIEUR de cette zone uniquement. */}
      <div className="relative flex-1 overflow-hidden">
        {/* Bandeau « navigation privée » — discret, en haut, n'intercepte rien. */}
        {incognitoMode && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center pt-1">
            <span className="rounded-full bg-purple-900/80 px-3 py-0.5 text-xs text-purple-100 shadow">
              Navigation privée activée — aucune trace enregistrée
            </span>
          </div>
        )}

        {error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-300">
            <span className="text-4xl">⚠️</span>
            <p>{error}</p>
            <button
              type="button"
              onClick={() => {
                if (chapterId) {
                  inflight.current.delete(currentPage)
                  ensureLoaded([currentPage])
                }
              }}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
            >
              Réessayer
            </button>
          </div>
        ) : isWebtoon ? (
          <div ref={scrollRef} className="webtoon-container h-full w-full overflow-y-scroll">
            <div className="mx-auto flex max-w-3xl flex-col gap-0 leading-none">
              {pages.map((p) => (
                <PageImage
                  key={p.index}
                  index={p.index}
                  src={loadedPages.get(p.index)}
                  style={{ width: '100%', height: 'auto' }}
                  onRetry={() => {
                    inflight.current.delete(p.index)
                    ensureLoaded([p.index])
                  }}
                  registerEl={(el) => {
                    if (el) pageEls.current.set(p.index, el)
                    else pageEls.current.delete(p.index)
                  }}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <PageImage
              index={currentPage}
              src={loadedPages.get(currentPage)}
              style={scaleStyle(settings.scaleType, zoom)}
              onRetry={() => {
                inflight.current.delete(currentPage)
                ensureLoaded([currentPage])
              }}
            />
            {settings.doublePageMode && currentPage + 1 < totalPages && (
              <PageImage
                index={currentPage + 1}
                src={loadedPages.get(currentPage + 1)}
                style={scaleStyle(settings.scaleType, zoom)}
                onRetry={() => {
                  inflight.current.delete(currentPage + 1)
                  ensureLoaded([currentPage + 1])
                }}
              />
            )}

            {/* Zones de clic : pavé navigation pages, centre = refresh HUD. */}
            <div className="absolute inset-0 flex">
              <div className="h-full w-1/3" onClick={() => handleZoneClick('left')} />
              <div className="h-full w-1/3" onClick={() => handleZoneClick('center')} />
              <div className="h-full w-1/3" onClick={() => handleZoneClick('right')} />
            </div>
          </div>
        )}

        {isLoading && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          </div>
        )}

        {/* Overlay de changement de chapitre — confiné à la zone images. */}
        {boundary && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black/80 text-white">
            <p className="text-lg">
              {boundary === 'next' ? 'Chapitre suivant' : 'Chapitre précédent'} :{' '}
              {chapterList[
                boundary === 'next' ? currentChapterIndex + 1 : currentChapterIndex - 1
              ]?.title ?? '—'}
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => goToChapter(boundary)}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium"
              >
                Continuer
              </button>
              <button
                type="button"
                onClick={() => setBoundary(null)}
                className="rounded-lg bg-white/10 px-4 py-2 text-sm"
              >
                Rester
              </button>
            </div>
            <span className="text-xs text-slate-400">Navigation automatique dans 3 s…</span>
          </div>
        )}

        {/* Slider vertical (mode webtoon) — sur le côté, à la place du slider bas.
            Valeur inversée : haut = page 1, bas = dernière (slider-vertical met le
            max en haut). Glisser fait défiler jusqu'à la page visée. */}
        {isWebtoon && hudVisible && totalPages > 0 && !boundary && (
          <div className="absolute right-3 top-1/2 z-30 flex -translate-y-1/2 flex-col items-center gap-2 rounded-full bg-black/70 px-2 py-3 text-white">
            <input
              type="range"
              min={0}
              max={Math.max(0, totalPages - 1)}
              value={Math.max(0, totalPages - 1) - currentPage}
              onChange={(e) => {
                const idx = Math.max(0, totalPages - 1) - Number(e.target.value)
                setCurrentPage(idx)
                requestAnimationFrame(() =>
                  pageEls.current.get(idx)?.scrollIntoView({ block: 'start' }),
                )
              }}
              aria-label="Progression"
              className="reader-vslider accent-accent"
              style={{ height: '55vh' }}
            />
            {settings.showPageNumber && (
              <span className="text-xs tabular-nums">
                {currentPage + 1}/{totalPages}
              </span>
            )}
          </div>
        )}
      </div>

      {/* HUD inférieur (mode paginé) — en webtoon le slider passe sur le côté. */}
      {hudVisible && !isWebtoon && (
        <div className="flex h-14 flex-none items-center gap-3 bg-black/80 px-4 text-white">
          <input
            type="range"
            min={0}
            max={Math.max(0, totalPages - 1)}
            value={currentPage}
            onChange={(e) => setCurrentPage(Number(e.target.value))}
            className="flex-1 accent-accent"
            aria-label="Progression"
          />
          {settings.showPageNumber && (
            <span className="w-16 text-center text-sm tabular-nums">
              {currentPage + 1} / {totalPages}
            </span>
          )}
        </div>
      )}

      {/* Panneau settings lecteur */}
      {showSettings && (
        <ReaderSettingsPanel
          settings={settings}
          onChange={updateReaderSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Panneau de suivi (tracking) */}
      {showTracking && mangaId && (
        <TrackingPanel
          mangaId={mangaId}
          mangaTitle={mangaId}
          onClose={() => setShowTracking(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sous-composants
// ---------------------------------------------------------------------------

interface PageImageProps {
  index: number
  src: string | undefined
  style: React.CSSProperties
  onRetry(): void
  registerEl?(el: HTMLElement | null): void
}

function PageImage({ index, src, style, onRetry, registerEl }: PageImageProps) {
  const [errored, setErrored] = useState(false)

  if (!src) {
    return (
      <div
        ref={registerEl}
        data-index={index}
        className="flex aspect-[2/3] w-full max-w-full animate-pulse items-center justify-center bg-white/5"
      />
    )
  }

  if (errored) {
    return (
      <div
        ref={registerEl}
        data-index={index}
        className="flex aspect-[2/3] w-full flex-col items-center justify-center gap-2 bg-white/5 text-slate-300"
      >
        <span className="text-2xl">⚠️</span>
        <button
          type="button"
          onClick={() => {
            setErrored(false)
            onRetry()
          }}
          className="rounded bg-white/10 px-3 py-1 text-sm hover:bg-white/20"
        >
          Réessayer
        </button>
      </div>
    )
  }

  return (
    <img
      ref={registerEl}
      data-index={index}
      src={src}
      alt={`Page ${index + 1}`}
      style={style}
      onError={() => setErrored(true)}
      className="select-none"
      draggable={false}
    />
  )
}

interface ReaderSettingsPanelProps {
  settings: ReaderSettings
  onChange(patch: Partial<ReaderSettings>): void
  onClose(): void
}

function Radio<T extends string>({
  name,
  options,
  value,
  onChange,
  disabled,
}: {
  name: string
  options: { value: T; label: string }[]
  value: T
  onChange(v: T): void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      {options.map((o) => (
        <label
          key={o.value}
          className={[
            'flex items-center gap-2 text-sm',
            disabled ? 'text-slate-600' : 'text-slate-200',
          ].join(' ')}
        >
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
            className="accent-accent"
          />
          {o.label}
        </label>
      ))}
    </div>
  )
}

function ReaderSettingsPanel({ settings, onChange, onClose }: ReaderSettingsPanelProps) {
  const isWebtoon = settings.readingMode === 'webtoon' || settings.readingMode === 'vertical'
  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[300px] flex-col bg-surface-raised shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/5 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">Lecteur</h2>
        <button type="button" onClick={onClose} aria-label="Fermer" className="text-slate-400">
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 text-slate-200">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-400">Mode de lecture</h3>
          <Radio
            name="readingMode"
            value={settings.readingMode}
            onChange={(v) => onChange({ readingMode: v })}
            options={[
              { value: 'ltr', label: 'Gauche → droite' },
              { value: 'rtl', label: 'Droite → gauche' },
              { value: 'webtoon', label: 'Webtoon (vertical)' },
            ]}
          />
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-400">Ajustement</h3>
          <Radio
            name="scaleType"
            value={settings.scaleType}
            onChange={(v) => onChange({ scaleType: v })}
            options={[
              { value: 'fit-page', label: 'Page entière' },
              { value: 'fit-width', label: 'Largeur' },
              { value: 'fit-height', label: 'Hauteur' },
              { value: 'original', label: 'Taille réelle' },
            ]}
          />
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-400">Couleur de fond</h3>
          <div className="flex flex-wrap items-center gap-2">
            {BG_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                title={p.label}
                onClick={() => onChange({ backgroundColor: p.value })}
                className={[
                  'h-7 w-7 rounded-full border',
                  settings.backgroundColor === p.value
                    ? 'border-accent'
                    : 'border-white/20',
                ].join(' ')}
                style={{ backgroundColor: p.value }}
              />
            ))}
            <input
              type="color"
              value={settings.backgroundColor}
              onChange={(e) => onChange({ backgroundColor: e.target.value })}
              className="h-7 w-7 cursor-pointer rounded bg-transparent"
              aria-label="Couleur personnalisée"
            />
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-slate-400">
            Préchargement : {settings.preloadCount}
          </h3>
          <input
            type="range"
            min={1}
            max={8}
            value={settings.preloadCount}
            onChange={(e) => onChange({ preloadCount: Number(e.target.value) })}
            className="w-full accent-accent"
          />
        </section>

        <label className="flex items-center justify-between text-sm">
          Afficher le numéro de page
          <input
            type="checkbox"
            checked={settings.showPageNumber}
            onChange={(e) => onChange({ showPageNumber: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <label
          className={[
            'flex items-center justify-between text-sm',
            isWebtoon ? 'text-slate-600' : '',
          ].join(' ')}
        >
          Mode double page
          <input
            type="checkbox"
            checked={settings.doublePageMode}
            disabled={isWebtoon}
            onChange={(e) => onChange({ doublePageMode: e.target.checked })}
            className="h-4 w-4 accent-accent"
          />
        </label>

        <label className="flex items-center justify-between text-sm text-slate-600">
          Recadrage automatique (bientôt disponible)
          <input type="checkbox" checked={settings.cropBorders} disabled className="h-4 w-4" />
        </label>
      </div>
    </div>
  )
}
