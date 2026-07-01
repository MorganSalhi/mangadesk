import { create } from 'zustand'
import type { Chapter, Page } from '../types'

// ============================================================================
// Store Lecteur (session 2).
// Contient l'état de lecture du chapitre courant. Le chargement réel des images
// (fetch_image_as_base64 / asset protocol + préchargement) est piloté par le
// composant Reader, qui pousse les résultats ici via setLoadedPage().
// ============================================================================

interface ReaderState {
  mangaId: string | null
  sourceId: string | null
  chapterId: string | null

  pages: Page[] // métadonnées des pages du chapitre courant
  loadedPages: Map<number, string> // index de page → src image (data URI ou asset://)
  currentPage: number
  totalPages: number

  chapterList: Chapter[] // tous les chapitres du manga, triés number ASC
  currentChapterIndex: number

  isLoading: boolean
  error: string | null

  // Session 4B — mode immersif :
  // `isFullscreen` est lu par App.tsx pour masquer la sidebar ;
  // `isHudVisible` est piloté par Reader.tsx via `showHud()` (debounce 2 s).
  isFullscreen: boolean
  isHudVisible: boolean

  // Actions
  initChapter(args: {
    mangaId: string
    sourceId: string
    chapterId: string
  }): void
  setChapterList(chapters: Chapter[]): void
  setPages(pages: Page[]): void
  setLoadedPage(index: number, src: string): void
  setCurrentPage(index: number): void
  setLoading(isLoading: boolean): void
  setError(error: string | null): void
  setFullscreen(value: boolean): void
  setHudVisible(value: boolean): void
  reset(): void
}

const INITIAL = {
  mangaId: null,
  sourceId: null,
  chapterId: null,
  pages: [] as Page[],
  loadedPages: new Map<number, string>(),
  currentPage: 0,
  totalPages: 0,
  chapterList: [] as Chapter[],
  currentChapterIndex: -1,
  isLoading: false,
  error: null as string | null,
  isFullscreen: false,
  isHudVisible: true,
}

export const useReaderStore = create<ReaderState>((set, get) => ({
  ...INITIAL,

  initChapter: ({ mangaId, sourceId, chapterId }) =>
    set({
      mangaId,
      sourceId,
      chapterId,
      pages: [],
      loadedPages: new Map(),
      currentPage: 0,
      totalPages: 0,
      isLoading: true,
      error: null,
    }),

  setChapterList: (chapters) => {
    const { chapterId } = get()
    const currentChapterIndex = chapters.findIndex((c) => c.id === chapterId)
    set({ chapterList: chapters, currentChapterIndex })
  },

  setPages: (pages) => set({ pages, totalPages: pages.length }),

  // Nouveau Map à chaque insertion pour déclencher le re-render React.
  setLoadedPage: (index, src) =>
    set((s) => {
      const next = new Map(s.loadedPages)
      next.set(index, src)
      return { loadedPages: next }
    }),

  setCurrentPage: (index) => {
    const { totalPages } = get()
    const clamped = Math.max(0, Math.min(index, Math.max(0, totalPages - 1)))
    set({ currentPage: clamped })
  },

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error, isLoading: false }),

  // En sortie de plein écran le HUD est toujours visible pour ne pas laisser
  // l'utilisateur sans contrôles ; en entrée on le masque pour démarrer immersif.
  setFullscreen: (value) => set({ isFullscreen: value, isHudVisible: !value }),
  setHudVisible: (value) => set({ isHudVisible: value }),

  reset: () => set({ ...INITIAL, loadedPages: new Map(), pages: [], chapterList: [] }),
}))
