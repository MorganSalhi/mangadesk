import type {
  Chapter,
  Filter,
  Manga,
  MangaListPage,
  MangaPreview,
  Page,
  Source,
} from '../../types'
import { createTransport, type Transport } from './cfTransport'

// ============================================================================
// Moteur Madara / WordPress WP-Manga partagé.
//
// Couvre la majorité des sites Madara FR. Les variations par site (base d'URL
// des fiches, tri populaire, nouvel endpoint chapitres, Cloudflare…) passent
// par `MadaraConfig`. Valeurs par défaut = comportement Madara standard de
// Tachiyomi/Keiyoushi. Cf. SESSION7 pour la méthode (config tirée de Keiyoushi).
// ============================================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface MadaraConfig {
  id: string
  name: string
  baseUrl: string
  lang?: string
  version?: string
  isNsfw?: boolean
  cloudflare?: 'always' | 'auto'
  /** Base d'URL de l'archive/listing (défaut 'manga'). */
  archiveSub?: string
  /** Base d'URL des permaliens fiche/chapitre (défaut = archiveSub). */
  mangaSub?: string
  /** Clé de tri populaire (défaut 'views'). */
  popularOrderby?: string
  latestOrderby?: string
  /** POST {mangaUrl}/ajax/chapters au lieu de scraper la fiche. */
  useNewChapterEndpoint?: boolean
  /**
   * Récupération HTML en mode WebView : 'fetch' (défaut, rapide) ou 'navigate'
   * (vraie navigation `render_via_webview`). 'navigate' est requis quand le WAF
   * Cloudflare refuse le `fetch()` programmatique d'une page HTML (403,
   * Sec-Fetch-Mode: cors) et n'accepte qu'un chargement navigateur — cas des
   * sites passés en challenge Turnstile permanent (Manga-Scantrad, Sushi-Scan).
   */
  htmlVia?: 'fetch' | 'navigate'
  /** UA imposé (solveur + reqwest), si la source en exige un de spécifique. */
  userAgent?: string
}

function imgSrc(el: Element | null): string {
  if (!el) return ''
  const srcset = el.getAttribute('srcset') ?? el.getAttribute('data-srcset')
  return (
    el.getAttribute('data-src') ??
    el.getAttribute('data-lazy-src') ??
    (srcset ? srcset.split(',')[0]?.trim().split(' ')[0] : null) ??
    el.getAttribute('src') ??
    ''
  ).trim()
}

function parseStatus(text: string): Manga['status'] {
  const t = text.toLowerCase()
  if (!t) return 'unknown'
  if (t.includes('en cours') || t.includes('ongoing') || t.includes('publishing')) return 'ongoing'
  if (t.includes('terminé') || t.includes('completed') || t.includes('fini') || t.includes('finished'))
    return 'completed'
  if (t.includes('hiatus') || t.includes('pause')) return 'hiatus'
  if (t.includes('annul') || t.includes('cancelled') || t.includes('abandonn')) return 'cancelled'
  return 'unknown'
}

function parseDate(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const direct = Date.parse(trimmed)
  if (!Number.isNaN(direct)) return direct
  const rel = trimmed
    .toLowerCase()
    .match(/(\d+)\s*(jour|day|heure|hour|min|seconde|second|semaine|week|mois|month|an|year)/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const u = rel[2]
    const f = u.startsWith('second')
      ? 1000
      : u.startsWith('min')
        ? 60_000
        : u.startsWith('heure') || u.startsWith('hour')
          ? 3_600_000
          : u.startsWith('jour') || u.startsWith('day')
            ? 86_400_000
            : u.startsWith('semaine') || u.startsWith('week')
              ? 7 * 86_400_000
              : u.startsWith('mois') || u.startsWith('month')
                ? 30 * 86_400_000
                : 365 * 86_400_000
    return Date.now() - n * f
  }
  return 0
}

export class MadaraSource implements Source {
  readonly id: string
  readonly name: string
  readonly lang: string
  readonly baseUrl: string
  readonly version: string
  readonly isNsfw: boolean
  readonly supportsLatest = true
  readonly filters: Filter[] = []

  protected readonly cfg: Required<
    Pick<
      MadaraConfig,
      'archiveSub' | 'mangaSub' | 'popularOrderby' | 'latestOrderby' | 'useNewChapterEndpoint'
    >
  >
  protected readonly transport: Transport

  constructor(config: MadaraConfig) {
    this.id = config.id
    this.name = config.name
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.lang = config.lang ?? 'fr'
    this.version = config.version ?? '1.0.0'
    this.isNsfw = config.isNsfw ?? false
    const archiveSub = config.archiveSub ?? 'manga'
    this.cfg = {
      archiveSub,
      mangaSub: config.mangaSub ?? archiveSub,
      popularOrderby: config.popularOrderby ?? 'views',
      latestOrderby: config.latestOrderby ?? 'latest',
      useNewChapterEndpoint: config.useNewChapterEndpoint ?? false,
    }
    this.transport = createTransport(this.id, this.baseUrl, config.cloudflare ?? 'auto', {
      htmlVia: config.htmlVia,
      userAgent: config.userAgent,
    })
  }

  private archiveUrl(page: number, orderby: string): string {
    const base =
      page === 1
        ? `${this.baseUrl}/${this.cfg.archiveSub}/`
        : `${this.baseUrl}/${this.cfg.archiveSub}/page/${page}/`
    return `${base}?m_orderby=${orderby}`
  }

  async search(query: string, page: number, _filters: Filter[]): Promise<MangaListPage> {
    const q = query.trim()
    if (!q) {
      const html = await this.transport.fetchHtml(this.archiveUrl(page, this.cfg.popularOrderby))
      return this.parseMangaList(html, page, false)
    }
    const base = page === 1 ? `${this.baseUrl}/` : `${this.baseUrl}/page/${page}/`
    const html = await this.transport.fetchHtml(`${base}?s=${encodeURIComponent(q)}&post_type=wp-manga`)
    return this.parseMangaList(html, page, true)
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const html = await this.transport.fetchHtml(this.archiveUrl(page, this.cfg.latestOrderby))
    return this.parseMangaList(html, page, false)
  }

  protected parseMangaList(html: string, page: number, isSearch: boolean): MangaListPage {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const sub = this.cfg.mangaSub
    const selector = isSearch
      ? 'div.c-tabs-item__content, .manga__item'
      : 'div.page-item-detail, .manga__item'
    const items = Array.from(doc.querySelectorAll(selector))

    const seen = new Set<string>()
    const mangas: MangaPreview[] = []
    for (const item of items) {
      const linkEl =
        item.querySelector<HTMLAnchorElement>(`a[href*="/${sub}/"]:not(.btn-link)`) ??
        item.querySelector<HTMLAnchorElement>('div.post-title a') ??
        item.querySelector<HTMLAnchorElement>(`a[href*="/${sub}/"]`)
      if (!linkEl) continue
      const href = linkEl.getAttribute('href') ?? ''
      const slug = href.split(`/${sub}/`)[1]?.split('/')[0]?.split(/[?#]/)[0]
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      const title =
        item.querySelector('.post-title')?.textContent?.trim() ||
        (linkEl.textContent ?? '').trim() ||
        slug
      mangas.push({ id: slug, title, coverUrl: imgSrc(item.querySelector('img')), sourceId: this.id })
    }

    if (mangas.length === 0) {
      console.warn(
        `[${this.id}] 0 résultat (search=${isSearch}) — html len=${html.length}, ` +
          `items(${selector})=${items.length}, ancres /${sub}/=` +
          doc.querySelectorAll(`a[href*="/${sub}/"]`).length,
      )
    }

    const hasNextPage =
      mangas.length > 0 &&
      !!doc.querySelector('.nav-previous, .next.page-numbers, a.nextpostslink')
    return { mangas, hasNextPage, currentPage: page }
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    const html = await this.transport.fetchHtml(`${this.baseUrl}/${this.cfg.mangaSub}/${mangaId}/`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    const title =
      doc
        .querySelector('div.post-title h3, div.post-title h1, #manga-title > h1')
        ?.textContent?.trim() ??
      doc.querySelector('h1')?.textContent?.trim() ??
      mangaId
    const coverUrl = imgSrc(doc.querySelector('div.summary_image img'))
    const description =
      doc
        .querySelector('div.summary__content > p, div.summary__content, .description-summary')
        ?.textContent?.trim() ?? ''
    const statusText =
      doc.querySelector('.post-status .summary-content, div.summary-content')?.textContent?.trim() ??
      ''
    const author =
      doc.querySelector('div.author-content > a, .author-content')?.textContent?.trim() ?? ''
    const artist =
      doc.querySelector('div.artist-content > a, .artist-content')?.textContent?.trim() ?? author
    const genres = Array.from(doc.querySelectorAll('.genres-content a'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean)

    return {
      id: mangaId,
      title,
      coverUrl,
      sourceId: this.id,
      description,
      author,
      artist,
      status: parseStatus(statusText),
      genres,
      inLibrary: false,
    }
  }

  async getChapterList(mangaId: string): Promise<Chapter[]> {
    const mangaUrl = `${this.baseUrl}/${this.cfg.mangaSub}/${mangaId}`
    let doc: Document
    if (this.cfg.useNewChapterEndpoint) {
      const html = await this.transport.fetchHtml(`${mangaUrl}/ajax/chapters`, {
        method: 'POST',
        body: '',
        referer: `${mangaUrl}/`,
      })
      doc = new DOMParser().parseFromString(html, 'text/html')
      if (doc.querySelectorAll('li.wp-manga-chapter').length === 0) {
        // Repli : chapitres parfois inline dans la fiche.
        const page = await this.transport.fetchHtml(`${mangaUrl}/`)
        doc = new DOMParser().parseFromString(page, 'text/html')
      }
    } else {
      const html = await this.transport.fetchHtml(`${mangaUrl}/`)
      doc = new DOMParser().parseFromString(html, 'text/html')
    }

    const items = Array.from(doc.querySelectorAll('li.wp-manga-chapter'))
    const chapters: Chapter[] = []
    items.forEach((item, idx) => {
      const linkEl = item.querySelector<HTMLAnchorElement>('a')
      if (!linkEl) return
      const href = linkEl.getAttribute('href') ?? ''
      // Slug = dernier segment (sans slash/encodage → id router-safe, cf. le bug
      // historique résolu en SESSION7). URL reconstruite par getPageList.
      const chapterSlug = href.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? `ch-${idx}`
      const dateText = item.querySelector('span.chapter-release-date')?.textContent?.trim() ?? ''
      const numMatch = (linkEl.textContent ?? '').match(/([\d]+(?:[.,][\d]+)?)/)
      const number = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : items.length - idx
      chapters.push({
        id: `${mangaId}:${chapterSlug}`,
        mangaId,
        number,
        title: (linkEl.textContent ?? '').trim() || `Chapitre ${number}`,
        scanlator: '',
        dateUpload: parseDate(dateText),
        isRead: false,
        lastPageRead: 0,
      })
    })

    return chapters.sort((a, b) => a.number - b.number)
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    const sep = chapterId.indexOf(':')
    const mangaSlug = sep >= 0 ? chapterId.slice(0, sep) : ''
    const chapterSlug = sep >= 0 ? chapterId.slice(sep + 1) : chapterId
    const url = `${this.baseUrl}/${this.cfg.mangaSub}/${mangaSlug}/${chapterSlug}/`

    const html = await this.transport.fetchHtml(url)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const imgs = doc.querySelectorAll<HTMLImageElement>(
      'div.page-break img, li.blocks-gallery-item img, .reading-content img',
    )
    const pages: Page[] = []
    imgs.forEach((img, index) => {
      const cleaned = imgSrc(img)
      if (cleaned && !cleaned.endsWith('.svg')) {
        const headers: Record<string, string> = {
          Referer: url,
          'User-Agent': this.transport.cookie ? this.transport.userAgent : UA,
        }
        if (this.transport.cookie) headers.Cookie = this.transport.cookie
        pages.push({ index, imageUrl: cleaned, headers })
      }
    })
    return pages
  }
}
