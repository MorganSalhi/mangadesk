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
// Source DemonicScans (https://demonicscans.org) — scraping HTML.
//
// Particularités confirmées en session 6 :
// - les slugs dans le HTML sont DÉJÀ URL-encodés (parfois double-encodés —
//   `One%252DPunch-Man` = `%252D` = encode("%2D")), donc on les décode jusqu'à
//   stabilisation avant tout usage. Surtout, on NE les réencode PAS quand on
//   reconstruit l'URL de la fiche manga (`${baseUrl}/manga/${slug}`).
// - le site n'est pas Madara : pages listées via index.php / lastupdates.php,
//   chapitres servis par chaptered.php?manga=…&chapter=…, et images parfois
//   injectées via objet JS inline (`var pages = […]`).
// - selon le manga (one-shot / serie longue / récent), les sélecteurs de
//   chapitres et de couverture varient → on essaie plusieurs candidats en
//   cascade et on logue (`console.debug`) quand rien ne match pour faciliter
//   un diagnostic ultérieur dans la console webview.
// ============================================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface FetchResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

export class DemonicScansSource implements Source {
  readonly id = 'demonicscans'
  readonly name = 'DemonicScans'
  readonly lang = 'en'
  readonly baseUrl = 'https://demonicscans.org'
  readonly version = '1.0.0'
  readonly isNsfw = false
  readonly supportsLatest = true
  readonly filters: Filter[] = []

  private async fetchHtml(url: string): Promise<string> {
    let res: FetchResponse
    try {
      res = await invoke<FetchResponse>('fetch_url', {
        url,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: this.baseUrl,
        },
      })
    } catch (e) {
      throw new Error(`DemonicScans réseau : ${typeof e === 'string' ? e : 'inaccessible'}`)
    }
    if (res.status !== 200) throw new Error(`DemonicScans HTTP ${res.status} sur ${url}`)
    return res.body
  }

  /**
   * Décode un slug jusqu'à stabilisation (le HTML contient parfois des slugs
   * doublement encodés — `One%252DPunch-Man`). Plafonné à 3 passes pour ne
   * jamais boucler, même sur une chaîne mal formée.
   */
  private decodeSlug(raw: string): string {
    let decoded = raw
    for (let i = 0; i < 3; i++) {
      try {
        const next = decodeURIComponent(decoded)
        if (next === decoded) break
        decoded = next
      } catch {
        break
      }
    }
    return decoded
  }

  async search(query: string, page: number, _filters: Filter[]): Promise<MangaListPage> {
    const url = query.trim()
      ? `${this.baseUrl}/search.php?manga=${encodeURIComponent(query.trim())}`
      : `${this.baseUrl}/`
    const html = await this.fetchHtml(url)
    return this.parseMangaList(html, page)
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const html = await this.fetchHtml(`${this.baseUrl}/lastupdates.php`)
    return this.parseMangaList(html, page)
  }

  private parseMangaList(html: string, page: number): MangaListPage {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const seen = new Set<string>()
    const mangas: MangaPreview[] = []

    // Tous les liens vers une fiche manga ("/manga/{slug}" ou "/title/{slug}") :
    // on déduplique par slug pour évacuer les liens parasites (logos, header…).
    doc.querySelectorAll<HTMLAnchorElement>('a[href*="/manga/"], a[href*="/title/"]').forEach((a) => {
      const href = a.getAttribute('href') ?? ''
      const rawSlug = href.split(/\/(?:manga|title)\//)[1]?.replace(/\/$/, '')?.split('?')[0]
      if (!rawSlug) return
      const slug = this.decodeSlug(rawSlug)
      if (seen.has(slug)) return
      const img = a.querySelector<HTMLImageElement>('img')
      if (!img) return
      const title = img.getAttribute('alt')?.trim() || a.textContent?.trim() || slug
      const rawCover = img.getAttribute('data-src') ?? img.getAttribute('src') ?? ''
      if (!rawCover) return
      seen.add(slug)
      mangas.push({
        id: slug,
        title,
        coverUrl: rawCover.startsWith('http') ? rawCover : `${this.baseUrl}${rawCover}`,
        sourceId: this.id,
      })
    })

    if (mangas.length === 0) {
      console.debug('[DemonicScans] parseMangaList: 0 résultats — html len =', html.length)
    }
    return { mangas: mangas.slice(0, 30), hasNextPage: false, currentPage: page }
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    // mangaId est ce qu'on a stocké : un slug DÉJÀ décodé. Pas de ré-encodage.
    const html = await this.fetchHtml(`${this.baseUrl}/manga/${mangaId}`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // Titre — cascade : titre dédié → header principal → fallback id.
    const title = (
      doc.querySelector('h1.manga-title')?.textContent ??
      doc.querySelector('.manga-info h1')?.textContent ??
      doc.querySelector('.title-manga')?.textContent ??
      doc.querySelector('h1')?.textContent ??
      mangaId
    ).trim()

    // Couverture — cascade large, fallback heuristique sur le mot-clé d'URL.
    const coverEl =
      doc.querySelector<HTMLImageElement>('.manga-cover img') ??
      doc.querySelector<HTMLImageElement>('.summary_image img') ??
      doc.querySelector<HTMLImageElement>('img.thumbnail') ??
      doc.querySelector<HTMLImageElement>('.info-cover img')
    let rawCover = coverEl?.getAttribute('data-src') ?? coverEl?.getAttribute('src') ?? ''
    if (!rawCover) {
      const heuristic = Array.from(doc.querySelectorAll<HTMLImageElement>('img')).find((img) => {
        const s = (img.getAttribute('src') ?? '').toLowerCase()
        return s.includes('thumbnail') || s.includes('cover') || s.includes('poster')
      })
      rawCover = heuristic?.getAttribute('src') ?? ''
    }
    const coverUrl =
      !rawCover || rawCover.startsWith('http') ? rawCover : `${this.baseUrl}${rawCover}`

    // Description — cascade sur les conventions vues en HTML.
    const description = (
      doc.querySelector('.description')?.textContent ??
      doc.querySelector('.summary')?.textContent ??
      doc.querySelector('.manga-description')?.textContent ??
      doc.querySelector('.synopsis')?.textContent ??
      doc.querySelector('#manga-info-description')?.textContent ??
      doc.querySelector('.manga-info p')?.textContent ??
      ''
    ).trim()

    const author =
      doc.querySelector('.author a, .manga-author, .author-content a')?.textContent?.trim() ?? ''
    const artist =
      doc.querySelector('.artist a, .manga-artist, .artist-content a')?.textContent?.trim() ??
      author
    const genres = Array.from(
      doc.querySelectorAll('.genres a, .genre-list a, .manga-genre a, .genres-content a'),
    )
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean)

    if (!coverUrl || !description) {
      console.debug(
        `[DemonicScans] details ${mangaId}: title="${title}", cover=${!!coverUrl}, desc=${description.length}`,
      )
    }

    return {
      id: mangaId,
      title,
      coverUrl,
      sourceId: this.id,
      description,
      author,
      artist,
      status: 'unknown',
      genres,
      inLibrary: false,
    }
  }

  async getChapterList(mangaId: string): Promise<Chapter[]> {
    const html = await this.fetchHtml(`${this.baseUrl}/manga/${mangaId}`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // Sélecteurs candidats, par ordre de spécificité décroissante. On retient
    // la première liste non vide → tolère les variations de markup entre
    // one-shots, séries longues et titres récents.
    const selectors = [
      'a[href*="chaptered.php"]',
      'a[href*="/chapter/"]',
      '.chapter-list a',
      '.chapters a',
      'ul.chapter-list li a',
      '.manga-chapters a',
      'li a[href*="chapter"]',
    ]
    let links: NodeListOf<HTMLAnchorElement> | null = null
    for (const sel of selectors) {
      const found = doc.querySelectorAll<HTMLAnchorElement>(sel)
      if (found.length > 0) {
        links = found
        break
      }
    }
    if (!links || links.length === 0) {
      console.debug(
        `[DemonicScans] aucun chapitre trouvé pour ${mangaId} — html len = ${html.length}`,
      )
      return []
    }

    const seen = new Set<string>()
    const chapters: Chapter[] = []

    links.forEach((link) => {
      const href = link.getAttribute('href') ?? ''
      // Cas idéal : URL chaptered.php?manga=…&chapter=… (numérique stable).
      const chapterMatch = href.match(/chapter=([0-9]+(?:\.[0-9]+)?)/)
      const mangaIdMatch = href.match(/manga=([0-9]+)/)
      if (chapterMatch && mangaIdMatch) {
        const number = parseFloat(chapterMatch[1])
        const mangaNumericId = mangaIdMatch[1]
        const key = `${mangaNumericId}:${number}`
        if (seen.has(key)) return
        seen.add(key)
        const dateText =
          link
            .closest('li, tr, div')
            ?.querySelector('.date, time, .chapter-date')
            ?.textContent?.trim() ?? ''
        chapters.push({
          id: `${mangaId}:${mangaNumericId}:${number}`,
          mangaId,
          number,
          title: link.textContent?.trim() || `Chapter ${number}`,
          scanlator: 'DemonicScans',
          dateUpload: parseHumanDate(dateText),
          isRead: false,
          lastPageRead: 0,
        })
        return
      }
      // Cas /chapter/<slug>/ : on extrait le numéro depuis le texte ou le slug.
      const slugTail = href.split('/').filter(Boolean).pop() ?? ''
      const numMatch =
        link.textContent?.match(/([\d]+(?:[\.,][\d]+)?)/) ??
        slugTail.match(/([\d]+(?:[\.,][\d]+)?)/)
      if (!numMatch) return
      const number = parseFloat(numMatch[1].replace(',', '.'))
      const key = `slug:${slugTail}`
      if (seen.has(key)) return
      seen.add(key)
      chapters.push({
        id: `${mangaId}:slug:${slugTail}`,
        mangaId,
        number,
        title: link.textContent?.trim() || `Chapter ${number}`,
        scanlator: 'DemonicScans',
        dateUpload: 0,
        isRead: false,
        lastPageRead: 0,
      })
    })

    return chapters.sort((a, b) => a.number - b.number)
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    // Format attendu :
    //  - "{mangaSlug}:{mangaNumericId}:{chapterNumber}" (cas API stable)
    //  - "{mangaSlug}:slug:{chapterSlug}" (cas fallback /chapter/<slug>/)
    const parts = chapterId.split(':')
    let url: string
    if (parts[1] === 'slug') {
      const chapterSlug = parts[2] ?? ''
      url = `${this.baseUrl}/chapter/${chapterSlug}`
    } else if (parts.length >= 3) {
      const mangaNumericId = parts[1]
      const chapterNum = parts[2]
      url = `${this.baseUrl}/chaptered.php?manga=${mangaNumericId}&chapter=${chapterNum}`
    } else {
      throw new Error('DemonicScans chapter id invalide')
    }
    const html = await this.fetchHtml(url)

    // Les URLs d'images du CDN (demoniclibs.com) contiennent des ESPACES
    // littéraux (ex. ".../Children of the Rune/1./1.jpg"). reqwest ne sait pas
    // parser une URL avec espaces → on les encode (%20) sans toucher aux ':' '/'
    // déjà valides. encodeURI n'échappe pas '%', donc les %xx existants restent
    // intacts (pas de double-encodage).
    const encodeUrl = (u: string): string => {
      try {
        return encodeURI(u)
      } catch {
        return u
      }
    }
    const absolutize = (u: string): string =>
      encodeUrl(u.startsWith('http') ? u : `${this.baseUrl}${u}`)

    // Stratégie 1 : objet JS inline (var pages = [...]).
    const jsPatterns = [
      /var\s+pages\s*=\s*(\[[\s\S]*?\])\s*;/,
      /var\s+images\s*=\s*(\[[\s\S]*?\])\s*;/,
      /chapter_preloaded_images\s*=\s*(\[[\s\S]*?\])\s*;/,
    ]
    for (const pattern of jsPatterns) {
      const m = html.match(pattern)
      if (!m) continue
      try {
        const arr: unknown = JSON.parse(m[1])
        if (Array.isArray(arr)) {
          const urls = arr
            .map((v) => (typeof v === 'string' ? v : null))
            .filter((v): v is string => !!v)
          if (urls.length > 0) {
            return urls.map((u, index) => ({
              index,
              imageUrl: absolutize(u),
              headers: { Referer: url, 'User-Agent': UA },
            }))
          }
        }
      } catch {
        /* JSON.parse a échoué : on tente la stratégie DOM */
      }
    }

    // Stratégie 2 : DOM. Les pages sont des <img class="imgholder"> (markup réel
    // confirmé) ; les autres sélecteurs restent en repli pour d'éventuelles variantes.
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const imgs = doc.querySelectorAll<HTMLImageElement>(
      'img.imgholder, .reader-area img, #readerarea img, .chapter-content img, #chapter-container img, .reading-content img',
    )
    const pages: Page[] = []
    imgs.forEach((img, index) => {
      const src = img.getAttribute('data-src') ?? img.getAttribute('src') ?? ''
      const cleaned = src.trim()
      if (!cleaned) return
      if (cleaned.endsWith('.svg') || /\b(logo|banner|placeholder)\b/i.test(cleaned)) return
      pages.push({
        index,
        imageUrl: absolutize(cleaned),
        headers: { Referer: url, 'User-Agent': UA },
      })
    })

    if (pages.length === 0) {
      console.debug('[DemonicScans] no pages parsed; html length =', html.length)
    }
    return pages
  }
}

function parseHumanDate(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const direct = Date.parse(trimmed)
  if (!Number.isNaN(direct)) return direct
  const rel = trimmed.toLowerCase().match(/(\d+)\s*(second|minute|hour|day|week|month|year)/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const u = rel[2]
    const factor =
      u === 'second' ? 1000
      : u === 'minute' ? 60_000
      : u === 'hour' ? 3_600_000
      : u === 'day' ? 86_400_000
      : u === 'week' ? 7 * 86_400_000
      : u === 'month' ? 30 * 86_400_000
      : 365 * 86_400_000
    return Date.now() - n * factor
  }
  return 0
}
