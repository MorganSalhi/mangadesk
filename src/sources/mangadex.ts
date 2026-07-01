import { invoke } from '@tauri-apps/api/core'
import type {
  Chapter,
  Filter,
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

export class MangaDexSource implements Source {
  readonly id = 'mangadex'
  readonly name = 'MangaDex'
  readonly lang = 'en'
  readonly baseUrl = 'https://mangadex.org'
  readonly version = '1.0.0'
  readonly isNsfw = false
  readonly supportsLatest = true
  readonly filters: Filter[] = []

  async search(query: string, page: number, _filters: Filter[]): Promise<MangaListPage> {
    const q = query.trim()
    if (!q) return this.getLatest(page)
    const offset = (page - 1) * PAGE_SIZE
    const res = await apiGet<MdList<MdMangaAttributes>>(
      `/manga?limit=${PAGE_SIZE}&offset=${offset}&title=${encodeURIComponent(q)}` +
        `&includes[]=cover_art&${ratingQuery()}&order[relevance]=desc`,
    )
    return this.toListPage(res, page)
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
