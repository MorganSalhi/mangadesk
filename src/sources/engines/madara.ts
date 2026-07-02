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
import { pickRandom, probeMaxPage } from './randomCatalog'

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

// --- Filtres (session 13) ----------------------------------------------------

/** Tris supportés par le paramètre `m_orderby` du formulaire Madara standard. */
const MADARA_SORT_OPTIONS: FilterOption[] = [
  { value: 'views', label: 'Popularité (vues)' },
  { value: 'trending', label: 'Tendance' },
  { value: 'latest', label: 'Dernières mises à jour' },
  { value: 'new-manga', label: 'Nouveautés' },
  { value: 'rating', label: 'Note' },
  { value: 'alphabet', label: 'Titre (A→Z)' },
  { value: '', label: 'Pertinence (recherche)' },
]

/** Libellés FR des statuts Madara standards (repli si le formulaire est muet). */
const MADARA_STATUS_FALLBACK: FilterOption[] = [
  { value: 'on-going', label: 'En cours' },
  { value: 'end', label: 'Terminé' },
  { value: 'on-hold', label: 'En pause' },
  { value: 'canceled', label: 'Annulé' },
]

function strList(v: FilterValues[string]): string[] {
  return Array.isArray(v) ? v : []
}

function str(v: FilterValues[string]): string {
  return typeof v === 'string' ? v.trim() : ''
}

export class MadaraSource implements Source {
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
    this.filters = this.staticFilterDefs()
  }

  private archiveUrl(page: number, orderby: string): string {
    const base =
      page === 1
        ? `${this.baseUrl}/${this.cfg.archiveSub}/`
        : `${this.baseUrl}/${this.cfg.archiveSub}/page/${page}/`
    return `${base}?m_orderby=${orderby}`
  }

  // --- Filtres ---------------------------------------------------------------

  /** Définitions disponibles sans requête réseau (le tri seul). */
  protected staticFilterDefs(): SourceFilterDef[] {
    return [
      {
        id: 'sort',
        name: 'Trier par',
        type: 'select',
        default: this.cfg.popularOrderby,
        options: MADARA_SORT_OPTIONS,
      },
    ]
  }

  /**
   * Complète les définitions depuis le formulaire de recherche avancée du site
   * (`/?s=&post_type=wp-manga`) : genres, statuts, contenu adulte, auteur…
   * Chaque site Madara a sa propre taxonomie de genres — d'où le parsing
   * dynamique plutôt qu'une liste codée en dur.
   */
  async getFilters(): Promise<SourceFilterDef[]> {
    this.dynamicFiltersPromise ??= (async () => {
      const html = await this.transport.fetchHtml(
        `${this.baseUrl}/?s=&post_type=wp-manga`,
      )
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
      const checkboxOptions = (name: string): FilterOption[] => {
        const seen = new Set<string>()
        const options: FilterOption[] = []
        doc.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
          const value = input.getAttribute('value') ?? ''
          if (!value || seen.has(value)) return
          seen.add(value)
          options.push({ value, label: labelFor(input) || value })
        })
        return options
      }

      const defs: SourceFilterDef[] = [...this.staticFilterDefs()]

      const genres = checkboxOptions('genre[]')
      if (genres.length > 0) {
        defs.push({ id: 'genres', name: 'Genres', type: 'multiselect', options: genres })
        defs.push({
          id: 'genresAnd',
          name: 'Cumuler les genres (ET)',
          type: 'checkbox',
          default: false,
        })
      }

      const statuses = checkboxOptions('status[]')
      defs.push({
        id: 'status',
        name: 'Statut',
        type: 'multiselect',
        options: statuses.length > 0 ? statuses : MADARA_STATUS_FALLBACK,
      })

      if (doc.querySelector('select[name="adult"]')) {
        defs.push({
          id: 'adult',
          name: 'Contenu adulte',
          type: 'select',
          default: '',
          options: [
            { value: '', label: 'Tout afficher' },
            { value: '0', label: 'Masquer le contenu adulte' },
            { value: '1', label: 'Contenu adulte uniquement' },
          ],
        })
      }

      const releases = checkboxOptions('release[]')
      if (releases.length > 0) {
        defs.push({
          id: 'release',
          name: 'Année de sortie',
          type: 'multiselect',
          options: releases,
        })
      }

      if (doc.querySelector('input[name="author"]')) {
        defs.push({ id: 'author', name: 'Auteur', type: 'text', placeholder: 'Nom d’auteur' })
      }
      if (doc.querySelector('input[name="artist"]')) {
        defs.push({ id: 'artist', name: 'Artiste', type: 'text', placeholder: 'Nom d’artiste' })
      }

      this.filters = defs
      return defs
    })()
    try {
      return await this.dynamicFiltersPromise
    } catch (err) {
      // Prochain passage → nouvel essai (échec réseau/Cloudflare ponctuel).
      this.dynamicFiltersPromise = null
      throw err
    }
  }

  async search(query: string, page: number, filters: FilterValues): Promise<MangaListPage> {
    const q = query.trim()
    const genres = strList(filters.genres)
    const statuses = strList(filters.status)
    const releases = strList(filters.release)
    const adult = str(filters.adult)
    const author = str(filters.author)
    const artist = str(filters.artist)
    const sort = typeof filters.sort === 'string' ? filters.sort : this.cfg.popularOrderby

    const hasAdvanced =
      !!q ||
      genres.length > 0 ||
      statuses.length > 0 ||
      releases.length > 0 ||
      adult !== '' ||
      !!author ||
      !!artist

    if (!hasAdvanced) {
      // Archive simple : plus léger et markup « populaire » plus riche.
      const html = await this.transport.fetchHtml(
        this.archiveUrl(page, sort || this.cfg.popularOrderby),
      )
      return this.parseMangaList(html, page, false)
    }

    // Formulaire de recherche avancée Madara (fonctionne aussi avec s vide).
    const params = new URLSearchParams()
    params.set('s', q)
    params.set('post_type', 'wp-manga')
    if (sort) params.set('m_orderby', sort)
    for (const g of genres) params.append('genre[]', g)
    if (genres.length > 0 && filters.genresAnd === true) params.set('op', '1')
    for (const s of statuses) params.append('status[]', s)
    for (const r of releases) params.append('release[]', r)
    if (adult) params.set('adult', adult)
    if (author) params.set('author', author)
    if (artist) params.set('artist', artist)

    const base = page === 1 ? `${this.baseUrl}/` : `${this.baseUrl}/page/${page}/`
    const html = await this.transport.fetchHtml(`${base}?${params.toString()}`)
    return this.parseMangaList(html, page, true)
  }

  /** URL de la recherche vide (mode search, paginable, avec compteur total). */
  private emptySearchUrl(page: number): string {
    const base = page === 1 ? `${this.baseUrl}/` : `${this.baseUrl}/page/${page}/`
    return `${base}?s=&post_type=wp-manga`
  }

  /**
   * Nombre de pages du catalogue. L'archive Madara ne lie que « page
   * suivante » (pas de dernier numéro) — mais la page de RECHERCHE vide
   * affiche le total (« 418 results » / « résultats ») : total ÷ taille de la
   * page 1 = nombre de pages. Repli : sonde exponentielle (cf. randomCatalog).
   */
  private async resolveCatalogPageCount(): Promise<{ pages: number; firstPage: MangaPreview[] }> {
    const html = await this.transport.fetchHtml(this.emptySearchUrl(1))
    const list = this.parseMangaList(html, 1, true)
    const perPage = list.mangas.length
    if (perPage === 0) throw new Error(`${this.name}: catalogue vide ou inaccessible.`)

    if (this.catalogPageCount == null) {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const headerText =
        doc.querySelector('.search-wrap h1, .c-blog__heading h1, h1.h4')?.textContent ?? ''
      const counter = headerText.match(/([\d][\d\s.,]*)\s*(?:results?|r[ée]sultats?)/i)
      if (counter) {
        const total = parseInt(counter[1].replace(/[\s.,]/g, ''), 10)
        if (Number.isFinite(total) && total > 0) {
          this.catalogPageCount = Math.max(1, Math.ceil(total / perPage))
        }
      }
      if (this.catalogPageCount == null) {
        this.catalogPageCount = await probeMaxPage(
          async (page) =>
            this.parseMangaList(
              await this.transport.fetchHtml(this.emptySearchUrl(page)),
              page,
              true,
            ).mangas.length,
          { knownMax: 1 },
        )
      }
    }
    return { pages: this.catalogPageCount, firstPage: list.mangas }
  }

  /**
   * Manga aléatoire : page aléatoire de la recherche vide (= catalogue
   * complet, pas seulement les têtes d'affiche), puis entrée aléatoire.
   */
  async getRandom(): Promise<MangaPreview> {
    const { pages, firstPage } = await this.resolveCatalogPageCount()
    const page = 1 + Math.floor(Math.random() * pages)
    if (page === 1) return pickRandom(firstPage)

    let list = this.parseMangaList(
      await this.transport.fetchHtml(this.emptySearchUrl(page)),
      page,
      true,
    )
    if (list.mangas.length === 0) {
      // Pagination surestimée (catalogue rétréci) → repli page 1.
      this.catalogPageCount = null
      list = { mangas: firstPage, hasNextPage: false, currentPage: 1 }
    }
    return pickRandom(list.mangas)
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
