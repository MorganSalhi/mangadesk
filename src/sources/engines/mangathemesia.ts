import type {
  Chapter,
  FilterOption,
  FilterValues,
  SourceFilterDef,
  Manga,
  MangaListPage,
  MangaPreview,
  Page,
  Source,
} from '../../types'
import { createTransport, type Transport } from './cfTransport'
import { probeMaxPage } from './randomCatalog'

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

/**
 * Valeur d'une info de série par libellé, sur les trois structures Themesia
 * rencontrées : `.infotable tr` (td libellé / td valeur — ex. Sushi-Scan),
 * `.imptdt` (« Status <i>Ongoing</i> » — ex. LelManga) et `.fmed`
 * (`<b>Libellé</b><span>valeur</span>`). Plusieurs libellés candidats (FR/EN).
 */
function seriesInfoValue(doc: Document, labels: string[]): string {
  const needles = labels.map((l) => l.toLowerCase())
  const matches = (text: string) => {
    const t = text.toLowerCase()
    return needles.some((n) => t.includes(n))
  }
  for (const tr of Array.from(doc.querySelectorAll('.infotable tr'))) {
    if (matches(tr.textContent ?? '')) {
      const cells = tr.querySelectorAll('td')
      const last = cells[cells.length - 1]
      if (last) return last.textContent?.trim() ?? ''
    }
  }
  for (const el of Array.from(doc.querySelectorAll('.imptdt'))) {
    if (matches(el.textContent ?? '')) {
      const value = el.querySelector('i, a')?.textContent?.trim()
      if (value) return value
    }
  }
  for (const el of Array.from(doc.querySelectorAll('.fmed'))) {
    if (matches(el.querySelector('b')?.textContent ?? '')) {
      const value = el.querySelector('span')?.textContent?.trim()
      if (value) return value
    }
  }
  return ''
}

function lastSegment(href: string): string {
  return href.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? ''
}

// --- Filtres (session 13) ----------------------------------------------------

/** Tris standards du paramètre `order` MangaThemesia. */
const THEMESIA_SORT_OPTIONS: FilterOption[] = [
  { value: 'popular', label: 'Popularité' },
  { value: 'update', label: 'Dernières mises à jour' },
  { value: 'latest', label: 'Ajout le plus récent' },
  { value: 'title', label: 'Titre (A→Z)' },
  { value: 'titlereverse', label: 'Titre (Z→A)' },
]

function strList(v: FilterValues[string]): string[] {
  return Array.isArray(v) ? v : []
}

function str(v: FilterValues[string]): string {
  return typeof v === 'string' ? v.trim() : ''
}

export class MangaThemesiaSource implements Source {
  readonly id: string
  readonly name: string
  readonly lang: string
  readonly baseUrl: string
  readonly version: string
  readonly isNsfw: boolean
  readonly supportsLatest = true
  filters: SourceFilterDef[]

  /** Promesse mémoïsée de chargement des filtres dynamiques (genres du site). */
  private dynamicFiltersPromise: Promise<SourceFilterDef[]> | null = null
  /** Nombre de pages du catalogue (cache session, pour getRandom). */
  private catalogPageCount: number | null = null

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
    this.filters = this.staticFilterDefs()
  }

  // --- Filtres ---------------------------------------------------------------

  /** Définitions disponibles sans requête réseau (le tri seul). */
  protected staticFilterDefs(): SourceFilterDef[] {
    return [
      {
        id: 'sort',
        name: 'Trier par',
        type: 'select',
        default: 'popular',
        options: THEMESIA_SORT_OPTIONS,
      },
    ]
  }

  /**
   * Complète les définitions depuis le formulaire de filtres de l'archive
   * (`{dir}/`) : genres (`genre[]`, ids propres au site), statut, type.
   * ⚠️ Limitation MangaThemesia : ces filtres ne s'appliquent qu'au listing,
   * pas à la recherche textuelle (`?s=`) — géré dans `search()`.
   */
  async getFilters(): Promise<SourceFilterDef[]> {
    this.dynamicFiltersPromise ??= (async () => {
      const html = await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/`)
      const doc = new DOMParser().parseFromString(html, 'text/html')

      const labelFor = (input: Element): string => {
        const id = input.getAttribute('id')
        const label = id ? doc.querySelector(`label[for="${id}"]`) : null
        return (
          label?.textContent?.trim() ||
          input.parentElement?.textContent?.trim() ||
          input.getAttribute('value') ||
          ''
        )
      }
      const inputOptions = (name: string): FilterOption[] => {
        const seen = new Set<string>()
        const options: FilterOption[] = []
        doc.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
          const value = input.getAttribute('value') ?? ''
          if (seen.has(value)) return
          seen.add(value)
          options.push({ value, label: labelFor(input) || value || 'Tous' })
        })
        return options
      }

      const defs: SourceFilterDef[] = []

      // Tri : options du site si présentes (radios name=order), sinon standard.
      const orders = inputOptions('order')
      defs.push({
        id: 'sort',
        name: 'Trier par',
        type: 'select',
        default: 'popular',
        options: orders.length > 1 ? orders : THEMESIA_SORT_OPTIONS,
      })

      const genres = inputOptions('genre[]')
      if (genres.length > 0) {
        defs.push({ id: 'genres', name: 'Genres', type: 'multiselect', options: genres })
      }
      const statuses = inputOptions('status')
      if (statuses.length > 1) {
        defs.push({
          id: 'status',
          name: 'Statut',
          type: 'select',
          default: '',
          options: statuses,
        })
      }
      const types = inputOptions('type')
      if (types.length > 1) {
        defs.push({ id: 'type', name: 'Type', type: 'select', default: '', options: types })
      }

      this.filters = defs
      return defs
    })()
    try {
      return await this.dynamicFiltersPromise
    } catch (err) {
      this.dynamicFiltersPromise = null
      throw err
    }
  }

  async search(query: string, page: number, filters: FilterValues): Promise<MangaListPage> {
    const q = query.trim()
    if (q) {
      // La recherche textuelle Themesia ne supporte pas les autres filtres.
      const html = await this.transport.fetchHtml(
        `${this.baseUrl}/page/${page}?s=${encodeURIComponent(q)}`,
      )
      return this.parseMangaList(html, page)
    }

    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('order', str(filters.sort) || 'popular')
    const status = str(filters.status)
    if (status) params.set('status', status)
    const type = str(filters.type)
    if (type) params.set('type', type)
    let url = `${this.baseUrl}${this.dir}/?${params.toString()}`
    for (const g of strList(filters.genres)) {
      url += `&genre%5B%5D=${encodeURIComponent(g)}`
    }
    const html = await this.transport.fetchHtml(url)
    return this.parseMangaList(html, page)
  }

  /**
   * Manga aléatoire : page aléatoire du catalogue, puis entrée aléatoire.
   * Le nombre de pages vient de la pagination (Themesia lie la dernière page,
   * ex. « 1 2 … 8 ») ; si elle n'expose pas de numéros mais qu'une page
   * suivante existe, on sonde (cf. randomCatalog) pour couvrir TOUT le
   * catalogue et pas seulement les têtes d'affiche.
   */
  async getRandom(): Promise<MangaPreview> {
    if (this.catalogPageCount == null) {
      const html = await this.transport.fetchHtml(
        `${this.baseUrl}${this.dir}/?page=1&order=popular`,
      )
      const doc = new DOMParser().parseFromString(html, 'text/html')
      let max = 1
      doc.querySelectorAll('.pagination a.page-numbers, .pagination a, .hpage a').forEach((a) => {
        const n = parseInt((a.textContent ?? '').replace(/[^\d]/g, ''), 10)
        if (Number.isFinite(n) && n > max) max = n
      })
      const hasNext = !!doc.querySelector('.pagination .next, .hpage .r')
      if (max === 1 && hasNext) {
        max = await probeMaxPage(
          async (page) =>
            this.parseMangaList(
              await this.transport.fetchHtml(
                `${this.baseUrl}${this.dir}/?page=${page}&order=popular`,
              ),
              page,
            ).mangas.length,
          { knownMax: 1 },
        )
      }
      this.catalogPageCount = max
    }

    const total = Math.max(1, this.catalogPageCount)
    const page = 1 + Math.floor(Math.random() * total)
    let list = this.parseMangaList(
      await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/?page=${page}&order=popular`),
      page,
    )
    if (list.mangas.length === 0 && page !== 1) {
      this.catalogPageCount = null
      list = this.parseMangaList(
        await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/?page=1&order=popular`),
        1,
      )
    }
    if (list.mangas.length === 0) {
      throw new Error(`${this.name}: catalogue vide ou inaccessible.`)
    }
    return list.mangas[Math.floor(Math.random() * list.mangas.length)]
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
    const author = seriesInfoValue(doc, [this.authorLabel, 'Author', 'Auteur'])
    const statusText = seriesInfoValue(doc, [this.statusLabel, 'Status', 'Statut'])

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
      // Numéro : attribut data-num (fiable, ex. LelManga), sinon libellé/slug.
      const dataNum = item.getAttribute('data-num') ?? ''
      const numMatch =
        dataNum.match(/([\d]+(?:[.,][\d]+)?)/) ??
        (name || chapterSlug).match(/([\d]+(?:[.,][\d]+)?)/)
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
