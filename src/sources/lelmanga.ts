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
// Source LelManga (https://www.lelmanga.com) — scraping HTML.
// Le site tourne sous WordPress + plugin Madara/WP-Manga ; les sélecteurs CSS
// utilisés (.page-item-detail, .wp-manga-chapter, .reading-content img…)
// suivent les conventions de ce thème. À ajuster si le markup évolue.
// ============================================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface FetchResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

export class LelMangaSource implements Source {
  readonly id = 'lelmanga'
  readonly name = 'LelManga'
  readonly lang = 'fr'
  readonly baseUrl = 'https://www.lelmanga.com'
  readonly version = '1.0.0'
  readonly isNsfw = false
  readonly supportsLatest = true
  readonly filters: Filter[] = []

  private async fetchHtml(url: string): Promise<string> {
    const res = await invoke<FetchResponse>('fetch_url', {
      url,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
        Referer: this.baseUrl,
      },
    })
    if (res.status !== 200) throw new Error(`LelManga HTTP ${res.status}`)
    return res.body
  }

  async search(query: string, page: number, _filters: Filter[]): Promise<MangaListPage> {
    const url = query.trim()
      ? `${this.baseUrl}/?s=${encodeURIComponent(query.trim())}&post_type=wp-manga&paged=${page}`
      : `${this.baseUrl}/manga/page/${page}/?m_orderby=trending`
    const html = await this.fetchHtml(url)
    return this.parseMangaList(html, page)
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const html = await this.fetchHtml(
      `${this.baseUrl}/manga/page/${page}/?m_orderby=latest`,
    )
    return this.parseMangaList(html, page)
  }

  /**
   * Le thème Madara/WP-Manga présente la liste de mangas dans des conteneurs
   * variables selon la version du plugin. On essaie plusieurs sélecteurs
   * connus, du plus spécifique au plus large, et on garde la première liste
   * non vide. En dernier recours, on parse depuis les ancres globales
   * `a[href*="/manga/"]` (au prix de quelques liens parasites filtrés).
   */
  private parseMangaList(html: string, page: number): MangaListPage {
    const doc = new DOMParser().parseFromString(html, 'text/html')

    const containers = [
      '.page-item-detail',
      '.c-tabs-item__content',
      '.manga-item',
      'article.manga',
      '.listupd .bs',
      '.mngalist .item',
    ]
    let items: Element[] = []
    for (const sel of containers) {
      const found = Array.from(doc.querySelectorAll(sel))
      if (found.length > 0) {
        items = found
        break
      }
    }

    const seen = new Set<string>()
    const mangas: MangaPreview[] = []

    const pushFromItem = (item: Element) => {
      const linkEl = item.querySelector<HTMLAnchorElement>(
        '.item-thumb a, .tab-thumb a, .post-title a, a[href*="/manga/"]',
      )
      const imgEl = item.querySelector<HTMLImageElement>('img')
      const titleEl =
        item.querySelector('.post-title a, .h4 a, .post-title, .tt') ?? linkEl
      if (!linkEl || !titleEl) return
      const href = linkEl.getAttribute('href') ?? ''
      const slug = href.split('/manga/')[1]?.replace(/\/$/, '')?.split('?')[0]
      if (!slug || seen.has(slug)) return
      seen.add(slug)
      const coverUrl =
        imgEl?.getAttribute('data-src') ??
        imgEl?.getAttribute('data-lazy-src') ??
        imgEl?.getAttribute('src') ??
        ''
      mangas.push({
        id: slug,
        title: titleEl.textContent?.trim() ?? slug,
        coverUrl,
        sourceId: this.id,
      })
    }

    if (items.length > 0) {
      items.forEach(pushFromItem)
    } else {
      // Fallback global : toutes les ancres /manga/{slug}.
      const anchors = Array.from(
        doc.querySelectorAll<HTMLAnchorElement>('a[href*="/manga/"]'),
      )
      for (const a of anchors) {
        // Reconstruit un "item" minimal autour de chaque ancre pour réutiliser
        // pushFromItem (qui sait gérer les liens directs).
        const wrapper = a.parentElement ?? a
        pushFromItem(wrapper)
      }
    }

    if (mangas.length === 0) {
      console.debug('[LelManga] parseMangaList: 0 résultats — html len =', html.length)
    }

    const hasNextPage =
      !!doc.querySelector('.nav-previous, .next.page-numbers, a.next.page-numbers')
    return { mangas, hasNextPage, currentPage: page }
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    const html = await this.fetchHtml(`${this.baseUrl}/manga/${mangaId}/`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    const title =
      doc.querySelector('.post-title h1, .post-title h3')?.textContent?.trim() ??
      doc.querySelector('h1')?.textContent?.trim() ??
      mangaId
    const coverEl = doc.querySelector<HTMLImageElement>('.summary_image img')
    const coverUrl =
      coverEl?.getAttribute('data-src') ??
      coverEl?.getAttribute('data-lazy-src') ??
      coverEl?.getAttribute('src') ??
      ''
    const description =
      doc.querySelector('.summary__content p, .description-summary p')?.textContent?.trim() ?? ''
    const statusText =
      doc
        .querySelector('.post-status .summary-content, .post-content_item .summary-content')
        ?.textContent?.trim()
        ?.toLowerCase() ?? ''
    const author =
      doc.querySelector('.author-content a')?.textContent?.trim() ??
      doc.querySelector('.author-content')?.textContent?.trim() ??
      ''
    const artist =
      doc.querySelector('.artist-content a')?.textContent?.trim() ?? author
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
    const html = await this.fetchHtml(`${this.baseUrl}/manga/${mangaId}/`)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Thème Themesia/WPMangaStream : liste dans #chapterlist .eplister li
    // (<li data-num> → .chapternum / .chapterdate). Repli Madara (.wp-manga-chapter)
    // au cas où un autre markup serait servi.
    let items = Array.from(doc.querySelectorAll('#chapterlist li, .eplister li'))
    if (items.length === 0) items = Array.from(doc.querySelectorAll('.wp-manga-chapter'))
    const chapters: Chapter[] = []

    items.forEach((item, idx) => {
      const linkEl = item.querySelector<HTMLAnchorElement>('a')
      if (!linkEl) return
      const href = linkEl.getAttribute('href') ?? ''
      // URL chapitre = à la racine du site (ex. /{mangaSlug}-148), pas sous /manga/.
      const chapterSlug = href.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? `ch-${idx}`
      const label =
        item.querySelector('.chapternum')?.textContent?.trim() ||
        linkEl.textContent?.trim() ||
        ''
      const dateText =
        item.querySelector('.chapterdate, .chapter-release-date')?.textContent?.trim() ?? ''
      // Numéro : attribut data-num (fiable), sinon libellé, sinon slug.
      const dataNum = item.getAttribute('data-num') ?? ''
      const numMatch =
        dataNum.match(/([\d]+(?:[.,][\d]+)?)/) ??
        label.match(/([\d]+(?:[.,][\d]+)?)/) ??
        chapterSlug.match(/([\d]+(?:[.,][\d]+)?)/)
      const number = numMatch
        ? parseFloat(numMatch[1].replace(',', '.'))
        : items.length - idx
      chapters.push({
        id: `${mangaId}:${chapterSlug}`,
        mangaId,
        number,
        title: label || `Chapitre ${number}`,
        scanlator: '',
        dateUpload: parseHumanDate(dateText),
        isRead: false,
        lastPageRead: 0,
      })
    })

    // Le markup Madara liste en général le plus récent en premier ; on
    // remonte d'abord puis le tri par numéro DESC est fait par MangaDetail.
    return chapters.sort((a, b) => a.number - b.number)
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    const chapterSlug = chapterId.split(':').pop() ?? chapterId
    const url = `${this.baseUrl}/${chapterSlug}/`
    const html = await this.fetchHtml(url)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Thème Themesia : pages dans #readerarea img (src direct, CDN Jetpack).
    // Replis Madara (.reading-content / .page-break) conservés.
    const imgs = doc.querySelectorAll<HTMLImageElement>(
      '#readerarea img, .reading-content img, .page-break img',
    )
    const pages: Page[] = []
    imgs.forEach((img, index) => {
      const src =
        img.getAttribute('data-src') ??
        img.getAttribute('data-lazy-src') ??
        img.getAttribute('src') ??
        ''
      const cleaned = src.trim()
      if (cleaned && !cleaned.endsWith('.svg')) {
        pages.push({
          index,
          imageUrl: cleaned,
          headers: { Referer: url, 'User-Agent': UA },
        })
      }
    })
    return pages
  }
}

// ---------------------------------------------------------------------------
// Helpers partagés avec les autres sources Madara
// ---------------------------------------------------------------------------

export function parseMadaraStatus(text: string): Manga['status'] {
  const t = text.toLowerCase()
  if (!t) return 'unknown'
  if (t.includes('ongoing') || t.includes('en cours') || t.includes('publishing')) return 'ongoing'
  if (t.includes('completed') || t.includes('terminé') || t.includes('finished')) return 'completed'
  if (t.includes('hiatus') || t.includes('pause')) return 'hiatus'
  if (t.includes('cancelled') || t.includes('annul')) return 'cancelled'
  return 'unknown'
}

/** Parse une date « humaine » WP-Manga (FR/EN) en epoch ms. */
export function parseHumanDate(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const direct = Date.parse(trimmed)
  if (!Number.isNaN(direct)) return direct
  // Patterns approximatifs : « il y a 2 jours », « 3 hours ago »…
  const rel = trimmed.toLowerCase().match(/(\d+)\s*(jour|day|heure|hour|minute|second|semaine|week|mois|month|année|year)/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    const factor =
      unit.startsWith('second') ? 1000
      : unit.startsWith('minute') ? 60_000
      : unit.startsWith('heure') || unit.startsWith('hour') ? 3_600_000
      : unit.startsWith('jour') || unit.startsWith('day') ? 86_400_000
      : unit.startsWith('semaine') || unit.startsWith('week') ? 7 * 86_400_000
      : unit.startsWith('mois') || unit.startsWith('month') ? 30 * 86_400_000
      : 365 * 86_400_000
    return Date.now() - n * factor
  }
  return 0
}
