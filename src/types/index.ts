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
  /** Nombre de pages, persisté à la lecture (absent tant que jamais ouvert). */
  pagesCount?: number | null
}

export interface Page {
  index: number
  imageUrl: string
  headers?: Record<string, string>
}

// ----------------------------------------------------------------------------
// Filtres de source (session 13)
// Chaque source déclare ses filtres (tri, genres, statut…) de façon
// déclarative ; le panneau de filtres de « Parcourir » les rend dynamiquement.
// ----------------------------------------------------------------------------

export interface FilterOption {
  value: string
  label: string
}

/** Filtre à choix unique (tri, statut, année…). */
export interface SelectFilterDef {
  id: string
  name: string
  type: 'select'
  options: FilterOption[]
  /** Valeur pré-sélectionnée (défaut : la 1re option). */
  default?: string
}

/** Filtre à choix multiples (genres, types…). */
export interface MultiSelectFilterDef {
  id: string
  name: string
  type: 'multiselect'
  options: FilterOption[]
}

/** Filtre booléen simple. */
export interface CheckboxFilterDef {
  id: string
  name: string
  type: 'checkbox'
  default?: boolean
}

/** Champ texte libre (auteur, année…). */
export interface TextFilterDef {
  id: string
  name: string
  type: 'text'
  placeholder?: string
}

export type SourceFilterDef =
  | SelectFilterDef
  | MultiSelectFilterDef
  | CheckboxFilterDef
  | TextFilterDef

/** Valeurs choisies par l'utilisateur, indexées par `SourceFilterDef.id`. */
export type FilterValues = Record<string, string | string[] | boolean | undefined>

export interface Source {
  id: string
  name: string
  lang: string
  baseUrl: string
  version: string
  isNsfw: boolean
  supportsLatest: boolean
  /** Définitions des filtres supportés ([] si aucun). */
  filters: SourceFilterDef[]
  /**
   * Optionnel : charge/complète les définitions de filtres de façon asynchrone
   * (ex. liste de tags MangaDex via l'API). Doit aussi mettre à jour `filters`.
   */
  getFilters?(): Promise<SourceFilterDef[]>
  /** Optionnel : renvoie un manga aléatoire de la source (bouton 🎲). */
  getRandom?(): Promise<MangaPreview>
  search(query: string, page: number, filters: FilterValues): Promise<MangaListPage>
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
