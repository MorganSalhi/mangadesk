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
import { parseHumanDate, parseMadaraStatus } from './lelmanga'

// ============================================================================
// Source Mangas Origines (https://mangas-origines.fr) — moteur WordPress/Madara.
//
// Spécificités (calquées sur l'extension Keiyoushi/Tachiyomi
// `eu.kanade.tachiyomi.extension.fr.mangasoriginesfr`, themePkg=madara) :
//   - mangaSubString = "catalogues" (et NON "manga")
//   - tri populaire : m_orderby=views ; récents : m_orderby=latest
//   - useNewChapterEndpoint : chapitres via POST {mangaUrl}/ajax/chapters
//
// Cloudflare : le site vérifie l'empreinte TLS, donc `reqwest` est rejeté (403)
// même avec le cookie cf_clearance. On passe TOUT par le WebView (vrai Chrome) :
// `solve_cloudflare` ouvre la session, `fetch_via_webview` rejoue les requêtes
// dans cette session (empreinte TLS valide + cookie same-origin). Cf. SESSION7.
// ============================================================================

// DOIT rester identique à `CF_BROWSER_UA` côté Rust (commands/fetch.rs).
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const CF_COOKIE_PREF = 'mangasorigines_cf_cookie'
const CF_UA_PREF = 'mangasorigines_cf_ua'

// Subtilité du site : l'archive/listing est sous `/catalogues/`, mais les
// permaliens des fiches ET des chapitres sont sous `/oeuvre/{slug}/`.
const ARCHIVE_SUB = 'catalogues'
const MANGA_SUB = 'oeuvre'

interface FetchResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

interface CloudflareClearance {
  cookie: string
  userAgent: string
}

// --- Clearance Cloudflare (cookie cf_clearance + UA assorti) -----------------
// Persistée en préférence SQLite pour les en-têtes images (le HTML, lui, passe
// toujours par le WebView).
let cfCookie: string | null = null
let cfUserAgent: string = UA
let clearanceLoaded = false
// Un seul WebView solveur à la fois : les requêtes concurrentes partagent la
// même résolution au lieu d'ouvrir N fenêtres.
let solving: Promise<boolean> | null = null

async function loadClearance(): Promise<void> {
  if (clearanceLoaded) return
  clearanceLoaded = true
  try {
    cfCookie = (await invoke<string | null>('get_preference', { key: CF_COOKIE_PREF })) ?? null
    const ua = await invoke<string | null>('get_preference', { key: CF_UA_PREF })
    if (ua) cfUserAgent = ua
  } catch {
    // get_preference indisponible (ex. tests) → on reste sans clearance.
  }
}

/** Ouvre le WebView solveur, persiste la clearance obtenue. Retourne false si
 *  l'utilisateur annule / le délai expire. */
async function solveCloudflare(url: string): Promise<boolean> {
  if (solving) return solving
  solving = (async () => {
    try {
      const res = await invoke<CloudflareClearance>('solve_cloudflare', { url })
      cfCookie = res.cookie
      cfUserAgent = res.userAgent || UA
      await invoke('set_preference', { key: CF_COOKIE_PREF, value: cfCookie })
      await invoke('set_preference', { key: CF_UA_PREF, value: cfUserAgent })
      return true
    } catch {
      return false
    } finally {
      solving = null
    }
  })()
  return solving
}

/** Lit data-src / data-lazy-src / srcset / src (priorité lazy-load Madara). */
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

export class MangasOriginesSource implements Source {
  readonly id = 'mangasorigines'
  readonly name = 'Mangas Origines'
  readonly lang = 'fr'
  readonly baseUrl = 'https://mangas-origines.fr'
  readonly version = '1.0.0'
  readonly isNsfw = false
  readonly supportsLatest = true
  readonly filters: Filter[] = []

  /**
   * Effectue une requête DANS le WebView (Cloudflare vérifie l'empreinte TLS :
   * `reqwest` est rejeté, le vrai Chrome passe). Sur `CF_NEEDS_SOLVE` (pas de
   * session / clearance expirée), ouvre le solveur puis retente une fois.
   */
  private async viaWebview(url: string, method?: string, body?: string): Promise<string> {
    const doFetch = async () => {
      const res = await invoke<FetchResponse>('fetch_via_webview', { url, method, body })
      if (res.status !== 200) throw new Error(`Mangas Origines HTTP ${res.status} sur ${url}`)
      return res.body
    }
    try {
      return await doFetch()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CF_NEEDS_SOLVE')) {
        const solved = await solveCloudflare(this.baseUrl)
        if (!solved) {
          throw new Error(
            `CLOUDFLARE_BLOCKED: Mangas Origines bloque les requêtes automatiques. ` +
              `Cliquez pour ouvrir la vérification Cloudflare, résolvez le challenge, ` +
              `puis réessayez.`,
          )
        }
        return await doFetch()
      }
      throw err
    }
  }

  async search(query: string, page: number, _filters: Filter[]): Promise<MangaListPage> {
    const q = query.trim()
    let url: string
    if (q) {
      // Recherche : /?s=...&post_type=wp-manga (page>1 → /page/N/?s=...).
      const base = page === 1 ? `${this.baseUrl}/` : `${this.baseUrl}/page/${page}/`
      url = `${base}?s=${encodeURIComponent(q)}&post_type=wp-manga`
    } else {
      // Populaire : /catalogues/(page/N/)?m_orderby=views.
      const base =
        page === 1 ? `${this.baseUrl}/${ARCHIVE_SUB}/` : `${this.baseUrl}/${ARCHIVE_SUB}/page/${page}/`
      url = `${base}?m_orderby=views`
    }
    const html = await this.viaWebview(url)
    return this.parseMangaList(html, page, !!q)
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const base =
      page === 1 ? `${this.baseUrl}/${ARCHIVE_SUB}/` : `${this.baseUrl}/${ARCHIVE_SUB}/page/${page}/`
    const html = await this.viaWebview(`${base}?m_orderby=latest`)
    return this.parseMangaList(html, page, false)
  }

  private parseMangaList(html: string, page: number, isSearch: boolean): MangaListPage {
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // Sélecteurs Madara : populaire = .page-item-detail ; recherche = .c-tabs-item__content.
    const selector = isSearch
      ? 'div.c-tabs-item__content, .manga__item'
      : 'div.page-item-detail, .manga__item'
    const items = Array.from(doc.querySelectorAll(selector))

    const seen = new Set<string>()
    const mangas: MangaPreview[] = []

    for (const item of items) {
      // Le lien fiche est une ancre /oeuvre/{slug}/ SANS .btn-link (celles-ci
      // pointent vers des chapitres /oeuvre/{slug}/chapitre-N/).
      const linkEl =
        item.querySelector<HTMLAnchorElement>(`a[href*="/${MANGA_SUB}/"]:not(.btn-link)`) ??
        item.querySelector<HTMLAnchorElement>(`a[href*="/${MANGA_SUB}/"]`)
      if (!linkEl) continue
      const href = linkEl.getAttribute('href') ?? ''
      const slug = href.split(`/${MANGA_SUB}/`)[1]?.split('/')[0]?.split(/[?#]/)[0]
      if (!slug || seen.has(slug)) continue
      seen.add(slug)
      const title =
        item.querySelector('.post-title')?.textContent?.trim() ||
        (linkEl.textContent ?? '').trim() ||
        slug
      mangas.push({
        id: slug,
        title,
        coverUrl: imgSrc(item.querySelector('img')),
        sourceId: this.id,
      })
    }

    if (mangas.length === 0) {
      console.warn(
        `[MangasOrigines] 0 résultat (search=${isSearch}) — html len=${html.length}, ` +
          `items(${selector})=${items.length}, ancres /${MANGA_SUB}/=` +
          doc.querySelectorAll(`a[href*="/${MANGA_SUB}/"]`).length,
      )
    }

    const hasNextPage =
      mangas.length > 0 &&
      !!doc.querySelector('.nav-previous, .next.page-numbers, a.nextpostslink, .wp-pagenavi .nextpostslink')
    return { mangas, hasNextPage, currentPage: page }
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    const html = await this.viaWebview(`${this.baseUrl}/${MANGA_SUB}/${mangaId}/`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    const title =
      doc.querySelector('div.post-title h3, div.post-title h1, #manga-title > h1')?.textContent?.trim() ??
      doc.querySelector('h1')?.textContent?.trim() ??
      mangaId
    const coverUrl = imgSrc(doc.querySelector('div.summary_image img'))
    const description =
      doc.querySelector('div.summary__content > p, div.summary__content, .description-summary')
        ?.textContent?.trim() ?? ''
    const statusText =
      doc.querySelector('.post-status .summary-content, div.summary-content')?.textContent?.trim() ?? ''
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
      status: parseMadaraStatus(statusText),
      genres,
      inLibrary: false,
    }
  }

  async getChapterList(mangaId: string): Promise<Chapter[]> {
    const mangaUrl = `${this.baseUrl}/${MANGA_SUB}/${mangaId}`
    // Nouvel endpoint chapitres Madara : POST {mangaUrl}/ajax/chapters.
    let html = await this.viaWebview(`${mangaUrl}/ajax/chapters`, 'POST', '')
    let doc = new DOMParser().parseFromString(html, 'text/html')
    let items = Array.from(doc.querySelectorAll('li.wp-manga-chapter'))

    // Repli : certains mangas listent les chapitres directement dans la fiche.
    if (items.length === 0) {
      html = await this.viaWebview(`${mangaUrl}/`)
      doc = new DOMParser().parseFromString(html, 'text/html')
      items = Array.from(doc.querySelectorAll('li.wp-manga-chapter'))
    }

    const chapters: Chapter[] = []
    items.forEach((item, idx) => {
      const linkEl = item.querySelector<HTMLAnchorElement>('a')
      if (!linkEl) return
      const href = linkEl.getAttribute('href') ?? ''
      // Slug du chapitre = dernier segment de l'URL (ex. "chapitre-200").
      // On le stocke SANS slash/encodage dans l'id : un id contenant `%2F`
      // serait mutilé par React Router (route /reader/:mangaId/:chapterId/…),
      // ce qui désynchronise l'id stocké et l'id lu → FK historique cassée.
      // Les chapitres sont à /oeuvre/{mangaSlug}/{chapterSlug}/, getPageList
      // reconstruit l'URL à partir de là.
      const chapterSlug =
        href.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? `ch-${idx}`
      const dateText = item.querySelector('span.chapter-release-date')?.textContent?.trim() ?? ''
      const numMatch = (linkEl.textContent ?? '').match(/([\d]+(?:[.,][\d]+)?)/)
      const number = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : items.length - idx
      chapters.push({
        id: `${mangaId}:${chapterSlug}`,
        mangaId,
        number,
        title: (linkEl.textContent ?? '').trim() || `Chapitre ${number}`,
        scanlator: '',
        dateUpload: parseHumanDate(dateText),
        isRead: false,
        lastPageRead: 0,
      })
    })

    return chapters.sort((a, b) => a.number - b.number)
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    await loadClearance()
    // chapterId = `${mangaSlug}:${chapterSlug}` (cf. getChapterList) → URL
    // /oeuvre/{mangaSlug}/{chapterSlug}/.
    const sep = chapterId.indexOf(':')
    const mangaSlug = sep >= 0 ? chapterId.slice(0, sep) : ''
    const chapterSlug = sep >= 0 ? chapterId.slice(sep + 1) : chapterId
    const url = `${this.baseUrl}/${MANGA_SUB}/${mangaSlug}/${chapterSlug}/`

    const html = await this.viaWebview(url)
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
          'User-Agent': cfCookie ? cfUserAgent : UA,
        }
        if (cfCookie) headers.Cookie = cfCookie
        pages.push({ index, imageUrl: cleaned, headers })
      }
    })
    return pages
  }
}
