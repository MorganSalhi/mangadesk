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
// Moteur MangaThemesia (WP-Mangastream / « ts_reader ») partagé.
//
// Sélecteurs et endpoints calqués sur la classe de base MangaThemesia de
// Keiyoushi. Les images de lecture sont servies via un objet JS inline
// `ts_reader.run({ sources: [{ images: [...] }] })`. Cf. SESSION7.
// ============================================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export interface MangaThemesiaConfig {
  id: string
  name: string
  baseUrl: string
  lang?: string
  version?: string
  isNsfw?: boolean
  cloudflare?: 'always' | 'auto'
  /** Répertoire des fiches (défaut '/manga' ; Sushi-Scan '/catalogue'). */
  mangaUrlDirectory?: string
  /** Libellés de l'infotable pour auteur / statut. */
  authorLabel?: string
  statusLabel?: string
  /**
   * Récupération HTML en mode WebView : 'fetch' (défaut) ou 'navigate' (vraie
   * navigation `render_via_webview`), requis quand le WAF Cloudflare refuse le
   * `fetch()` programmatique (challenge Turnstile permanent, ex. Sushi-Scan).
   */
  htmlVia?: 'fetch' | 'navigate'
  /** UA imposé (solveur + reqwest), si la source en exige un de spécifique. */
  userAgent?: string
}

function imgAttr(el: Element | null): string {
  if (!el) return ''
  const srcset = el.getAttribute('srcset') ?? el.getAttribute('data-srcset')
  return (
    el.getAttribute('data-lazy-src') ??
    el.getAttribute('data-src') ??
    (srcset ? srcset.split(',').pop()?.trim().split(' ')[0] : null) ??
    el.getAttribute('src') ??
    ''
  ).trim()
}

function parseStatus(text: string): Manga['status'] {
  const t = text.toLowerCase()
  if (t.includes('en cours') || t.includes('ongoing')) return 'ongoing'
  if (t.includes('terminé') || t.includes('completed')) return 'completed'
  if (t.includes('abandonn') || t.includes('cancelled') || t.includes('dropped')) return 'cancelled'
  if (t.includes('pause') || t.includes('hiatus')) return 'hiatus'
  return 'unknown'
}

/** Valeur d'une ligne d'`.infotable` par libellé (`:contains` n'existe pas en CSS DOM). */
function infotableValue(doc: Document, label: string): string {
  const rows = Array.from(doc.querySelectorAll('.infotable tr'))
  for (const tr of rows) {
    if ((tr.textContent ?? '').toLowerCase().includes(label.toLowerCase())) {
      const cells = tr.querySelectorAll('td')
      const last = cells[cells.length - 1]
      if (last) return last.textContent?.trim() ?? ''
    }
  }
  return ''
}

function lastSegment(href: string): string {
  return href.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? ''
}

export class MangaThemesiaSource implements Source {
  readonly id: string
  readonly name: string
  readonly lang: string
  readonly baseUrl: string
  readonly version: string
  readonly isNsfw: boolean
  readonly supportsLatest = true
  readonly filters: Filter[] = []

  protected readonly dir: string
  protected readonly authorLabel: string
  protected readonly statusLabel: string
  protected readonly transport: Transport

  constructor(config: MangaThemesiaConfig) {
    this.id = config.id
    this.name = config.name
    this.baseUrl = config.baseUrl.replace(/\/$/, '')
    this.lang = config.lang ?? 'fr'
    this.version = config.version ?? '1.0.0'
    this.isNsfw = config.isNsfw ?? false
    this.dir = config.mangaUrlDirectory ?? '/manga'
    this.authorLabel = config.authorLabel ?? 'Auteur'
    this.statusLabel = config.statusLabel ?? 'Statut'
    this.transport = createTransport(this.id, this.baseUrl, config.cloudflare ?? 'auto', {
      htmlVia: config.htmlVia,
      userAgent: config.userAgent,
    })
  }

  async search(query: string, page: number, _filters: Filter[]): Promise<MangaListPage> {
    const q = query.trim()
    const url = q
      ? `${this.baseUrl}/page/${page}?s=${encodeURIComponent(q)}`
      : `${this.baseUrl}${this.dir}/?page=${page}&order=popular`
    const html = await this.transport.fetchHtml(url)
    return this.parseMangaList(html, page)
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const html = await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/?page=${page}&order=update`)
    return this.parseMangaList(html, page)
  }

  protected parseMangaList(html: string, page: number): MangaListPage {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const items = Array.from(
      doc.querySelectorAll('.utao .uta .imgu, .listupd .bs .bsx, .listo .bs .bsx'),
    )

    const seen = new Set<string>()
    const mangas: MangaPreview[] = []
    for (const item of items) {
      const a = item.querySelector<HTMLAnchorElement>('a')
      if (!a) continue
      const href = a.getAttribute('href') ?? ''
      const slug = href.split(`${this.dir}/`)[1]?.split('/')[0]?.split(/[?#]/)[0] ?? lastSegment(href)
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      mangas.push({
        id: slug,
        title: a.getAttribute('title')?.trim() || a.textContent?.trim() || slug,
        coverUrl: imgAttr(item.querySelector('img')),
        sourceId: this.id,
      })
    }

    if (mangas.length === 0) {
      console.warn(
        `[${this.id}] 0 résultat — html len=${html.length}, items=${items.length}, ` +
          `ancres ${this.dir}/=` + doc.querySelectorAll(`a[href*="${this.dir}/"]`).length,
      )
    }

    const hasNextPage =
      mangas.length > 0 && !!doc.querySelector('div.pagination .next, div.hpage .r')
    return { mangas, hasNextPage, currentPage: page }
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    const html = await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/${mangaId}/`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    const title =
      doc.querySelector('h1.entry-title, .ts-breadcrumb li:last-child span')?.textContent?.trim() ??
      doc.querySelector('h1')?.textContent?.trim() ??
      mangaId
    const coverUrl = imgAttr(
      doc.querySelector('.infomanga > div[itemprop=image] img, .thumb img, .ime img'),
    )
    const description = Array.from(
      doc.querySelectorAll('.desc, .entry-content[itemprop=description]'),
    )
      .map((el) => el.textContent?.trim() ?? '')
      .join('\n')
      .trim()
    const genres = Array.from(doc.querySelectorAll('div.gnr a, .mgen a, .seriestugenre a'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean)
    const author = infotableValue(doc, this.authorLabel)
    const statusText = infotableValue(doc, this.statusLabel)

    return {
      id: mangaId,
      title,
      coverUrl,
      sourceId: this.id,
      description,
      author,
      artist: author,
      status: parseStatus(statusText),
      genres,
      inLibrary: false,
    }
  }

  async getChapterList(mangaId: string): Promise<Chapter[]> {
    const html = await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/${mangaId}/`)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const items = Array.from(doc.querySelectorAll('#chapterlist li, div.bxcl li, div.cl li'))

    const chapters: Chapter[] = []
    items.forEach((item, idx) => {
      const a = item.querySelector<HTMLAnchorElement>('a')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      const chapterSlug = lastSegment(href) || `ch-${idx}`
      const name =
        item.querySelector('.lch a, .chapternum')?.textContent?.trim() ||
        a.textContent?.trim() ||
        ''
      const dateText = item.querySelector('.chapterdate')?.textContent?.trim() ?? ''
      const numMatch = (name || chapterSlug).match(/([\d]+(?:[.,][\d]+)?)/)
      const number = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : items.length - idx
      chapters.push({
        id: `${mangaId}:${chapterSlug}`,
        mangaId,
        number,
        title: name || `Chapitre ${number}`,
        scanlator: '',
        dateUpload: dateText ? Date.parse(dateText) || 0 : 0,
        isRead: false,
        lastPageRead: 0,
      })
    })

    return chapters.sort((a, b) => a.number - b.number)
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    const sep = chapterId.indexOf(':')
    const chapterSlug = sep >= 0 ? chapterId.slice(sep + 1) : chapterId
    // Les chapitres MangaThemesia sont à la racine du domaine.
    const url = `${this.baseUrl}/${chapterSlug}/`
    const html = await this.transport.fetchHtml(url)

    const headers: Record<string, string> = {
      Referer: url,
      'User-Agent': this.transport.cookie ? this.transport.userAgent : UA,
    }
    if (this.transport.cookie) headers.Cookie = this.transport.cookie

    // Images servies via ts_reader.run({ sources: [{ images: [...] }] }).
    const m = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/)
    if (m) {
      try {
        const data = JSON.parse(m[1]) as { sources?: { images?: string[] }[] }
        const images = data.sources?.[0]?.images ?? []
        if (images.length > 0) {
          return images.map((imageUrl, index) => ({
            index,
            imageUrl: imageUrl.replace(/^http:\/\//, 'https://'),
            headers,
          }))
        }
      } catch {
        /* JSON malformé → fallback DOM */
      }
    }

    const doc = new DOMParser().parseFromString(html, 'text/html')
    const pages: Page[] = []
    doc.querySelectorAll<HTMLImageElement>('div#readerarea img').forEach((img, index) => {
      const src = imgAttr(img)
      if (src && !src.endsWith('.svg')) pages.push({ index, imageUrl: src, headers })
    })
    return pages
  }
}
