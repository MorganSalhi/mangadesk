import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import pLimit from 'p-limit'
import { fetchRemoteImage } from '../lib/remoteImage'
import type {
  Category,
  LibraryFilters,
  LibrarySortOrder,
  Manga,
  Source,
} from '../types'

// ============================================================================
// Store Bibliothèque (session 2).
// - mangas chargés depuis SQLite (get_library)
// - couvertures chargées via fetch_image_as_base64, limitées à 5 en parallèle
// - filtrage / tri appliqués côté JS (cf. filterAndSortMangas)
// Le mode d'affichage (grille/liste) est persisté dans settingsStore.
// ============================================================================

/** Manga enrichi des métadonnées de bibliothèque utiles au tri. */
export interface LibraryManga extends Manga {
  dateAdded?: number
  lastUpdated?: number
  lastRead?: number
}

// Forme "row" telle qu'attendue/retournée par les commandes Rust (snake_case).
interface MangaRow {
  id: string
  source_id: string
  remote_id: string
  title: string
  cover_url: string | null
  description: string | null
  author: string | null
  artist: string | null
  status: Manga['status'] | null
  genres: string | null
  in_library: number
  date_added: number | null
  last_updated: number | null
}

interface CategoryRow {
  id: number
  name: string
  sort_order: number
  flags: number
}

function toRow(m: Manga): MangaRow {
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
    date_added: Date.now(),
    last_updated: Date.now(),
  }
}

function fromRow(r: MangaRow): LibraryManga {
  return {
    id: r.id,
    sourceId: r.source_id,
    title: r.title,
    coverUrl: r.cover_url ?? '',
    description: r.description ?? '',
    author: r.author ?? '',
    artist: r.artist ?? '',
    status: r.status ?? 'unknown',
    genres: r.genres ? (JSON.parse(r.genres) as string[]) : [],
    inLibrary: r.in_library === 1,
    dateAdded: r.date_added ?? undefined,
    lastUpdated: r.last_updated ?? undefined,
  }
}

function fromCategoryRow(r: CategoryRow): Category {
  return { id: r.id, name: r.name, sortOrder: r.sort_order, flags: r.flags }
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  sourceIds: [],
  statuses: [],
  categoryIds: [],
  downloadedOnly: false,
  unreadOnly: false,
}

/** Nombre de filtres actifs (pour le badge du bouton "Filtres"). */
export function countActiveFilters(f: LibraryFilters): number {
  return (
    (f.sourceIds.length > 0 ? 1 : 0) +
    (f.statuses.length > 0 ? 1 : 0) +
    (f.categoryIds.length > 0 ? 1 : 0) +
    (f.downloadedOnly ? 1 : 0) +
    (f.unreadOnly ? 1 : 0)
  )
}

interface FilterContext {
  mangas: LibraryManga[]
  filters: LibraryFilters
  sortOrder: LibrarySortOrder
  activeCategory: number | null
  mangaCategories: Map<string, number[]>
  unreadCounts: Map<string, number>
  downloadedMangaIds: Set<string>
}

/** Applique catégorie active + filtres + tri, entièrement côté JS. */
export function filterAndSortMangas(ctx: FilterContext): LibraryManga[] {
  const {
    mangas,
    filters,
    sortOrder,
    activeCategory,
    mangaCategories,
    unreadCounts,
    downloadedMangaIds,
  } = ctx

  let out = mangas.filter((m) => {
    if (activeCategory !== null) {
      const cats = mangaCategories.get(m.id) ?? []
      if (!cats.includes(activeCategory)) return false
    }
    if (filters.sourceIds.length && !filters.sourceIds.includes(m.sourceId)) {
      return false
    }
    if (filters.statuses.length && !filters.statuses.includes(m.status)) {
      return false
    }
    if (filters.categoryIds.length) {
      const cats = mangaCategories.get(m.id) ?? []
      if (!filters.categoryIds.some((id) => cats.includes(id))) return false
    }
    if (filters.downloadedOnly && !downloadedMangaIds.has(m.id)) return false
    if (filters.unreadOnly && (unreadCounts.get(m.id) ?? 0) === 0) return false
    return true
  })

  out = [...out].sort((a, b) => {
    switch (sortOrder) {
      case 'title-asc':
        return a.title.localeCompare(b.title)
      case 'title-desc':
        return b.title.localeCompare(a.title)
      case 'dateAdded':
        return (b.dateAdded ?? 0) - (a.dateAdded ?? 0)
      case 'lastUpdated':
        return (b.lastUpdated ?? 0) - (a.lastUpdated ?? 0)
      case 'lastRead':
        return (b.lastRead ?? 0) - (a.lastRead ?? 0)
      default:
        return 0
    }
  })

  return out
}

interface LibraryState {
  mangas: LibraryManga[]
  categories: Category[]
  coverCache: Map<string, string> // mangaId → data URI base64 (ou URL directe en fallback)
  unreadCounts: Map<string, number> // mangaId → nb chapitres is_read = 0
  downloadedMangaIds: Set<string> // mangas ayant ≥ 1 chapitre téléchargé
  mangaCategories: Map<string, number[]> // mangaId → category ids
  activeCategory: number | null // null = "Tous"
  filters: LibraryFilters
  sortOrder: LibrarySortOrder
  loading: boolean

  // Actions
  loadLibrary(): Promise<void>
  loadCovers(mangas: Manga[]): Promise<void>
  loadCategories(): Promise<void>
  loadMangaCategories(): Promise<void>
  addToLibrary(manga: Manga, source?: Source): Promise<void>
  removeFromLibrary(mangaId: string): Promise<void>
  removeManyFromLibrary(mangaIds: string[]): Promise<void>
  createCategory(name: string): Promise<void>
  reorderCategories(ids: number[]): Promise<void>
  setActiveCategory(id: number | null): void
  setFilters(filters: Partial<LibraryFilters>): void
  resetFilters(): void
  setSortOrder(order: LibrarySortOrder): void
}

interface MangaCategoryAssocRow {
  mangaId: string
  categoryId: number
}

// 5 couvertures téléchargées en parallèle au maximum (cf. brief).
const coverLimit = pLimit(5)

export const useLibraryStore = create<LibraryState>((set, get) => ({
  mangas: [],
  categories: [],
  coverCache: new Map(),
  unreadCounts: new Map(),
  downloadedMangaIds: new Set(),
  mangaCategories: new Map(),
  activeCategory: null,
  filters: DEFAULT_LIBRARY_FILTERS,
  sortOrder: 'title-asc',
  loading: false,

  loadLibrary: async () => {
    set({ loading: true })
    try {
      // Recharge en parallèle les méta-tables qui pilotent les badges (non-lus,
      // téléchargés) et le filtre par catégorie. Avant session 6 ces Maps
      // n'étaient jamais peuplées : badges toujours à 0, filtres inopérants.
      const [rows, unreadRows, dlIds, catRows] = await Promise.all([
        invoke<MangaRow[]>('get_library'),
        invoke<{ mangaId: string; unread: number }[]>('get_unread_counts').catch(
          () => [] as { mangaId: string; unread: number }[],
        ),
        invoke<string[]>('get_downloaded_manga_ids').catch(() => [] as string[]),
        invoke<MangaCategoryAssocRow[]>('get_manga_categories').catch(
          () => [] as MangaCategoryAssocRow[],
        ),
      ])
      const mangas = rows.map(fromRow)
      const unreadCounts = new Map<string, number>(
        unreadRows.map((r) => [r.mangaId, r.unread]),
      )
      const downloadedMangaIds = new Set(dlIds)
      const mangaCategories = new Map<string, number[]>()
      for (const r of catRows) {
        const arr = mangaCategories.get(r.mangaId) ?? []
        arr.push(r.categoryId)
        mangaCategories.set(r.mangaId, arr)
      }
      set({ mangas, unreadCounts, downloadedMangaIds, mangaCategories, loading: false })
      void get().loadCovers(mangas)
    } catch {
      // Backend indisponible (ex. Rust non lancé) : bibliothèque vide, pas de crash.
      set({ loading: false })
    }
  },

  loadCovers: async (mangas) => {
    await Promise.all(
      mangas.map((manga) =>
        coverLimit(async () => {
          if (get().coverCache.has(manga.id)) return
          let src = manga.coverUrl
          try {
            src = await fetchRemoteImage(manga.coverUrl, { sourceId: manga.sourceId })
          } catch {
            // Échec (backend absent) : on retombe sur l'URL directe plutôt que rien.
          }
          set((s) => {
            const next = new Map(s.coverCache)
            next.set(manga.id, src)
            return { coverCache: next }
          })
        }),
      ),
    )
  },

  loadCategories: async () => {
    try {
      const rows = await invoke<CategoryRow[]>('get_categories')
      set({ categories: rows.map(fromCategoryRow) })
    } catch {
      /* backend absent */
    }
  },

  // Reconstitue la Map<mangaId, categoryIds[]> à partir de la table de jointure
  // côté SQLite. Sans cet appel les filtres / onglets par catégorie ne voient
  // jamais les associations (bug 2).
  loadMangaCategories: async () => {
    try {
      const rows = await invoke<MangaCategoryAssocRow[]>('get_manga_categories')
      const map = new Map<string, number[]>()
      for (const r of rows) {
        const arr = map.get(r.mangaId) ?? []
        arr.push(r.categoryId)
        map.set(r.mangaId, arr)
      }
      set({ mangaCategories: map })
    } catch {
      /* backend absent */
    }
  },

  addToLibrary: async (manga, _source) => {
    try {
      await invoke('add_to_library', { manga: toRow({ ...manga, inLibrary: true }) })
    } catch {
      /* optimiste même si backend absent */
    }
    set((s) => ({
      mangas: [
        ...s.mangas.filter((m) => m.id !== manga.id),
        { ...manga, inLibrary: true },
      ],
    }))
    void get().loadCovers([manga])
    // Note (session 5A) : les chapitres sont déjà insérés par MangaDetail
    // (upsert_chapters au chargement de la fiche). Un second upsert ici les
    // ré-écrirait avec `date_fetch = now()` POSTÉRIEUR au `date_added` que
    // `add_to_library` vient de fixer — ce qui les ferait apparaître à tort
    // dans la page Updates (bug 3). On laisse donc MangaDetail être l'unique
    // point d'insertion initiale des chapitres.
  },

  removeFromLibrary: async (mangaId) => {
    try {
      await invoke('remove_from_library', { mangaId })
    } catch {
      /* ignore */
    }
    set((s) => ({ mangas: s.mangas.filter((m) => m.id !== mangaId) }))
  },

  removeManyFromLibrary: async (mangaIds) => {
    const ids = new Set(mangaIds)
    for (const id of mangaIds) {
      try {
        await invoke('remove_from_library', { mangaId: id })
      } catch {
        /* ignore */
      }
    }
    set((s) => ({ mangas: s.mangas.filter((m) => !ids.has(m.id)) }))
  },

  createCategory: async (name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const row = await invoke<CategoryRow>('create_category', { name: trimmed })
      set((s) => ({ categories: [...s.categories, fromCategoryRow(row)] }))
    } catch {
      // Fallback local si backend absent : id négatif temporaire.
      set((s) => ({
        categories: [
          ...s.categories,
          {
            id: -(s.categories.length + 1),
            name: trimmed,
            sortOrder: s.categories.length,
            flags: 0,
          },
        ],
      }))
    }
  },

  reorderCategories: async (ids) => {
    // Réordonne localement immédiatement.
    set((s) => {
      const byId = new Map(s.categories.map((c) => [c.id, c]))
      const reordered = ids
        .map((id) => byId.get(id))
        .filter((c): c is Category => Boolean(c))
        .map((c, i) => ({ ...c, sortOrder: i }))
      return { categories: reordered }
    })
    try {
      await invoke('reorder_categories', { ids })
    } catch {
      /* ignore */
    }
  },

  setActiveCategory: (id) => set({ activeCategory: id }),
  setFilters: (filters) => set((s) => ({ filters: { ...s.filters, ...filters } })),
  resetFilters: () => set({ filters: DEFAULT_LIBRARY_FILTERS }),
  setSortOrder: (order) => set({ sortOrder: order }),
}))
