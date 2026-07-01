// ============================================================================
// MangaDesk — Types partagés (session 1)
// ============================================================================

export interface MangaListPage {
  mangas: MangaPreview[]
  hasNextPage: boolean
  currentPage: number
}

export interface MangaPreview {
  id: string
  title: string
  coverUrl: string
  sourceId: string
}

export interface Manga extends MangaPreview {
  description: string
  author: string
  artist: string
  status: 'ongoing' | 'completed' | 'hiatus' | 'cancelled' | 'unknown'
  genres: string[]
  inLibrary: boolean
}

export interface Chapter {
  id: string
  mangaId: string
  number: number
  title: string
  scanlator: string
  dateUpload: number
  isRead: boolean
  lastPageRead: number
}

export interface Page {
  index: number
  imageUrl: string
  headers?: Record<string, string>
}

export type FilterType = 'select' | 'checkbox' | 'text' | 'sort'

export interface Filter {
  id: string
  name: string
  type: FilterType
  value: string | boolean | number
  options?: string[]
}

export interface Source {
  id: string
  name: string
  lang: string
  baseUrl: string
  version: string
  isNsfw: boolean
  supportsLatest: boolean
  filters: Filter[]
  search(query: string, page: number, filters: Filter[]): Promise<MangaListPage>
  getMangaDetails(mangaId: string): Promise<Manga>
  getChapterList(mangaId: string): Promise<Chapter[]>
  getPageList(chapterId: string): Promise<Page[]>
  getLatest(page: number): Promise<MangaListPage>
}

export interface ReaderSettings {
  readingMode: 'ltr' | 'rtl' | 'vertical' | 'webtoon'
  scaleType: 'fit-page' | 'fit-width' | 'fit-height' | 'original'
  backgroundColor: string
  preloadCount: number
  showPageNumber: boolean
  doublePageMode: boolean
  doublePageOffset: boolean
  // Présent dans le modèle mais non implémenté en session 2 (toggle désactivé).
  cropBorders: boolean
}

// ----------------------------------------------------------------------------
// Types support pour les stores (non couverts par l'interface Source)
// ----------------------------------------------------------------------------

export interface Category {
  id: number
  name: string
  sortOrder: number
  flags: number
}

export interface LibraryFilters {
  sourceIds: string[] // [] = toutes les sources
  statuses: string[] // [] = tous les statuts
  categoryIds: number[] // [] = toutes les catégories
  downloadedOnly: boolean
  unreadOnly: boolean
}

export type LibrarySortOrder =
  | 'title-asc'
  | 'title-desc'
  | 'dateAdded'
  | 'lastUpdated'
  | 'lastRead'
