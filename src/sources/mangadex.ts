import { invoke } from '@tauri-apps/api/core'
import type {
  Chapter,
  FilterValues,
  SourceFilterDef,
  Manga,
  MangaListPage,
  MangaPreview,
  Page,
  Source,
} from '../types'

// ============================================================================
// Source MangaDex — API JSON publique (https://api.mangadex.org).
//
// Tous les appels passent par la commande Rust `fetch_url` (contourne CORS /
// referer, cohérent avec l'architecture). Fallback `fetch` direct hors Tauri
// (`pnpm dev`) : MangaDex renvoie `Access-Control-Allow-Origin: *`.
//
// Les images (couvertures, pages) sont des URLs résolues plus tard par le
// lecteur / la bibliothèque via `fetch_image_as_base64`.
// ============================================================================

const API = 'https://api.mangadex.org'
const COVERS = 'https://uploads.mangadex.org/covers'
const PAGE_SIZE = 24
const CONTENT_RATING = ['safe', 'suggestive', 'erotica'] as const
const LANG = 'en'

// MangaDex applique une limite globale de 5 req/s sur l'API (et plus stricte
// sur certains endpoints, ex. /at-home/server à 40 req/min). On sérialise les
// appels avec un intervalle minimal pour rester nettement sous le seuil et
// éviter les 429 — pages détail/chapitres + couvertures peuvent se cumuler
// très vite lors d'une navigation rapide.
const MIN_INTERVAL_MS = 340 // ≈ 3 req/s
let apiChain: Promise<void> = Promise.resolve()
let lastApiCall = 0

function rateLimit(): Promise<void> {
  const next = apiChain.then(async () => {
    const elapsed = Date.now() - lastApiCall
    const delay = Math.max(0, MIN_INTERVAL_MS - elapsed)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
    lastApiCall = Date.now()
  })
  // Swallow rejections dans la chaîne pour ne pas bloquer les appels suivants.
  apiChain = next.catch(() => {})
  return next
}

interface FetchResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

function retryAfterMs(res: FetchResponse): number {
  const h = res.headers?.['retry-after'] ?? res.headers?.['Retry-After']
  const n = h ? parseInt(h, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n * 1000 : 1500
}

async function apiGet<T>(path: string): Promise<T> {
  const url = `${API}${path}`
  for (let attempt = 0; attempt < 3; attempt++) {
    await rateLimit()
    try {
      const res = await invoke<FetchResponse>('fetch_url', { url, headers: {} })
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, retryAfterMs(res)))
        continue
      }
      return JSON.parse(res.body) as T
    } catch {
      // Hors Tauri : MangaDex autorise le CORS → requête directe.
      const r = await fetch(url)
      if (r.status === 429) {
        const h = r.headers.get('Retry-After')
        const wait = h ? parseInt(h, 10) * 1000 : 1500
        await new Promise((res) => setTimeout(res, wait))
        continue
      }
      return (await r.json()) as T
    }
  }
  throw new Error('MangaDex: rate limit dépassé après plusieurs tentatives')
}

// --- Typage minimal des réponses MangaDex -----------------------------------

interface MdRelationship {
  id: string
  type: string
  attributes?: Record<string, unknown>
}

interface MdEntity<A> {
  id: string
  type: string
  attributes: A
  relationships?: MdRelationship[]
}

interface MdList<A> {
  data: MdEntity<A>[]
  total: number
  limit: number
  offset: number
}

type LocalizedString = Record<string, string>

interface MdMangaAttributes {
  title: LocalizedString
  altTitles?: LocalizedString[]
  description?: LocalizedString
  status?: string
  year?: number | null
  tags?: { attributes?: { name?: LocalizedString } }[]
}

interface MdChapterAttributes {
  volume: string | null
  chapter: string | null
  title: string | null
  translatedLanguage: string
  pages: number
  externalUrl: string | null
  publishAt: string
  readableAt: string
}

// --- Helpers de mapping ------------------------------------------------------

function localized(s: LocalizedString | undefined): string {
  if (!s) return ''
  return s.en ?? s['ja-ro'] ?? s.ja ?? Object.values(s)[0] ?? ''
}

function coverUrlFor(entity: MdEntity<unknown>): string {
  const rel = entity.relationships?.find((r) => r.type === 'cover_art')
  const fileName = rel?.attributes?.fileName as string | undefined
  if (!fileName) return ''
  return `${COVERS}/${entity.id}/${fileName}.512.jpg`
}

function relName(entity: MdEntity<unknown>, type: string): string {
  const rel = entity.relationships?.find((r) => r.type === type)
  return (rel?.attributes?.name as string | undefined) ?? ''
}

const STATUS_MAP: Record<string, Manga['status']> = {
  ongoing: 'ongoing',
  completed: 'completed',
  hiatus: 'hiatus',
  cancelled: 'cancelled',
}

function toPreview(entity: MdEntity<MdMangaAttributes>): MangaPreview {
  return {
    id: entity.id,
    title: localized(entity.attributes.title) || '(sans titre)',
    coverUrl: coverUrlFor(entity),
    sourceId: 'mangadex',
  }
}

function ratingQuery(): string {
  return CONTENT_RATING.map((r) => `contentRating[]=${r}`).join('&')
}

// --- Filtres (session 13) -----------------------------------------------------
// Correspondance valeur du filtre → paramètre `order[...]` de l'API.
const SORT_PARAMS: Record<string, string> = {
  relevance: 'order[relevance]=desc',
  follows: 'order[followedCount]=desc',
  latestChapter: 'order[latestUploadedChapter]=desc',
  newest: 'order[createdAt]=desc',
  updated: 'order[updatedAt]=desc',
  titleAsc: 'order[title]=asc',
  rating: 'order[rating]=desc',
  year: 'order[year]=desc',
}

const STATIC_FILTERS: SourceFilterDef[] = [
  {
    id: 'sort',
    name: 'Trier par',
    type: 'select',
    default: 'follows',
    options: [
      { value: 'follows', label: 'Popularité (follows)' },
      { value: 'relevance', label: 'Pertinence (recherche)' },
      { value: 'latestChapter', label: 'Dernier chapitre publié' },
      { value: 'newest', label: 'Ajout le plus récent' },
      { value: 'updated', label: 'Dernière mise à jour' },
      { value: 'rating', label: 'Note' },
      { value: 'year', label: 'Année de parution' },
      { value: 'titleAsc', label: 'Titre (A→Z)' },
    ],
  },
  {
    id: 'status',
    name: 'Statut',
    type: 'multiselect',
    options: [
      { value: 'ongoing', label: 'En cours' },
      { value: 'completed', label: 'Terminé' },
      { value: 'hiatus', label: 'En pause' },
      { value: 'cancelled', label: 'Annulé' },
    ],
  },
  {
    id: 'demographic',
    name: 'Démographie',
    type: 'multiselect',
    options: [
      { value: 'shounen', label: 'Shōnen' },
      { value: 'shoujo', label: 'Shōjo' },
      { value: 'seinen', label: 'Seinen' },
      { value: 'josei', label: 'Josei' },
    ],
  },
  {
    id: 'contentRating',
    name: 'Classification',
    type: 'multiselect',
    options: [
      { value: 'safe', label: 'Tout public' },
      { value: 'suggestive', label: 'Suggestif' },
      { value: 'erotica', label: 'Érotique' },
    ],
  },
  {
    id: 'year',
    name: 'Année de parution',
    type: 'text',
    placeholder: 'ex. 2020',
  },
  {
    id: 'hasChapters',
    name: 'Avec chapitres disponibles (EN)',
    type: 'checkbox',
    default: false,
  },
]

interface MdTagAttributes {
  name?: LocalizedString
  group?: string
}

function strList(v: FilterValues[string]): string[] {
  return Array.isArray(v) ? v : []
}

export class MangaDexSource implements Source {
  readonly id = 'mangadex'
  readonly name = 'MangaDex'
  readonly lang = 'en'
  readonly baseUrl = 'https://mangadex.org'
  readonly version = '1.0.0'
  readonly isNsfw = false
  readonly supportsLatest = true
  filters: SourceFilterDef[] = STATIC_FILTERS

  // Tags (genres/thèmes/formats) chargés une fois via /manga/tag.
  private tagFiltersPromise: Promise<SourceFilterDef[]> | null = null

  async getFilters(): Promise<SourceFilterDef[]> {
    this.tagFiltersPromise ??= (async () => {
      const res = await apiGet<MdList<MdTagAttributes>>('/manga/tag')
      const byGroup = new Map<string, { value: string; label: string }[]>()
      for (const tag of res.data) {
        const label = localized(tag.attributes.name)
        if (!label) continue
        const group = tag.attributes.group ?? 'genre'
        const list = byGroup.get(group) ?? []
        list.push({ value: tag.id, label })
        byGroup.set(group, list)
      }
      const groups: { key: string; id: string; name: string }[] = [
        { key: 'genre', id: 'genres', name: 'Genres' },
        { key: 'theme', id: 'themes', name: 'Thèmes' },
        { key: 'format', id: 'formats', name: 'Formats' },
      ]
      const tagDefs: SourceFilterDef[] = []
      for (const g of groups) {
        const options = (byGroup.get(g.key) ?? []).sort((a, b) =>
          a.label.localeCompare(b.label),
        )
        if (options.length > 0) {
          tagDefs.push({ id: g.id, name: g.name, type: 'multiselect', options })
        }
      }
      this.filters = [...STATIC_FILTERS, ...tagDefs]
      return this.filters
    })()
    try {
      return await this.tagFiltersPromise
    } catch (err) {
      // Prochaine ouverture du panneau → nouvel essai.
      this.tagFiltersPromise = null
      throw err
    }
  }

  /** Construit la query string /manga à partir de la recherche + des filtres. */
  private buildListQuery(query: string, page: number, filters: FilterValues): string {
    const offset = (page - 1) * PAGE_SIZE
    const parts: string[] = [
      `limit=${PAGE_SIZE}`,
      `offset=${offset}`,
      'includes[]=cover_art',
    ]
    const q = query.trim()
    if (q) parts.push(`title=${encodeURIComponent(q)}`)

    // Tri : « pertinence » n'a de sens qu'avec une recherche ; défaut =
    // pertinence avec requête, popularité sinon.
    let sort = typeof filters.sort === 'string' ? filters.sort : ''
    if (!SORT_PARAMS[sort]) sort = q ? 'relevance' : 'follows'
    if (sort === 'relevance' && !q) sort = 'follows'
    parts.push(SORT_PARAMS[sort])

    const ratings = strList(filters.contentRating)
    for (const r of ratings.length > 0 ? ratings : [...CONTENT_RATING]) {
      parts.push(`contentRating[]=${r}`)
    }
    for (const s of strList(filters.status)) parts.push(`status[]=${s}`)
    for (const d of strList(filters.demographic)) {
      parts.push(`publicationDemographic[]=${d}`)
    }
    for (const t of [
      ...strList(filters.genres),
      ...strList(filters.themes),
      ...strList(filters.formats),
    ]) {
      parts.push(`includedTags[]=${t}`)
    }
    const year = typeof filters.year === 'string' ? filters.year.trim() : ''
    if (/^\d{4}$/.test(year)) parts.push(`year=${year}`)
    if (filters.hasChapters === true) parts.push(`hasAvailableChapters=true&availableTranslatedLanguage[]=${LANG}`)
    return `/manga?${parts.join('&')}`
  }

  async search(query: string, page: number, filters: FilterValues): Promise<MangaListPage> {
    const res = await apiGet<MdList<MdMangaAttributes>>(
      this.buildListQuery(query, page, filters),
    )
    return this.toListPage(res, page)
  }

  async getRandom(): Promise<MangaPreview> {
    const res = await apiGet<{ data: MdEntity<MdMangaAttributes> }>(
      `/manga/random?includes[]=cover_art&${ratingQuery()}`,
    )
    return toPreview(res.data)
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const offset = (page - 1) * PAGE_SIZE
    const res = await apiGet<MdList<MdMangaAttributes>>(
      `/manga?limit=${PAGE_SIZE}&offset=${offset}` +
        `&includes[]=cover_art&${ratingQuery()}&order[followedCount]=desc`,
    )
    return this.toListPage(res, page)
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    const res = await apiGet<{ data: MdEntity<MdMangaAttributes> }>(
      `/manga/${mangaId}?includes[]=cover_art&includes[]=author&includes[]=artist`,
    )
    const e = res.data
    const a = e.attributes
    return {
      id: e.id,
      sourceId: 'mangadex',
      title: localized(a.title) || '(sans titre)',
      coverUrl: coverUrlFor(e),
      description: localized(a.description),
      author: relName(e, 'author'),
      artist: relName(e, 'artist'),
      status: STATUS_MAP[a.status ?? ''] ?? 'unknown',
      genres: (a.tags ?? [])
        .map((t) => localized(t.attributes?.name))
        .filter(Boolean),
      inLibrary: false,
    }
  }

  async getChapterList(mangaId: string): Promise<Chapter[]> {
    const all: MdEntity<MdChapterAttributes>[] = []
    let offset = 0
    // Pagination du feed (limite API : 500/req ; plafond de sécurité 2000).
    for (;;) {
      const res = await apiGet<MdList<MdChapterAttributes>>(
        `/manga/${mangaId}/feed?limit=500&offset=${offset}` +
          `&translatedLanguage[]=${LANG}&order[volume]=asc&order[chapter]=asc` +
          `&includes[]=scanlation_group&${ratingQuery()}`,
      )
      all.push(...res.data)
      offset += 500
      if (offset >= res.total || offset >= 2000 || res.data.length === 0) break
    }

    const chapters: Chapter[] = []
    const seen = new Set<string>()
    for (const e of all) {
      const a = e.attributes
      // Ignore les chapitres hébergés ailleurs (non lisibles via at-home).
      if (a.externalUrl || a.pages === 0) continue
      const numStr = a.chapter ?? '0'
      // Dédoublonne par numéro de chapitre (plusieurs teams = doublons).
      if (seen.has(numStr)) continue
      seen.add(numStr)
      chapters.push({
        id: e.id,
        mangaId,
        number: parseFloat(numStr) || 0,
        title: a.title ?? '',
        scanlator: relName(e, 'scanlation_group'),
        dateUpload: Date.parse(a.readableAt || a.publishAt) || 0,
        isRead: false,
        lastPageRead: 0,
      })
    }
    // Plus récent en premier (cohérent avec get_chapters côté DB).
    chapters.sort((x, y) => y.number - x.number)
    return chapters
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    const res = await apiGet<{
      baseUrl: string
      chapter: { hash: string; data: string[] }
    }>(`/at-home/server/${chapterId}`)
    const { baseUrl, chapter } = res
    return chapter.data.map((file, index) => ({
      index,
      imageUrl: `${baseUrl}/data/${chapter.hash}/${file}`,
    }))
  }

  private toListPage(res: MdList<MdMangaAttributes>, page: number): MangaListPage {
    return {
      mangas: res.data.map(toPreview),
      hasNextPage: res.offset + res.limit < res.total,
      currentPage: page,
    }
  }
}
