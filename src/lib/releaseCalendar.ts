import { invoke } from '@tauri-apps/api/core'
import { createTransport } from '../sources/engines/cfTransport'

// ============================================================================
// Calendrier des sorties manga (session 13).
//
// Données : planning mensuel des sorties FR de Nautiljon
// (https://www.nautiljon.com/planning/manga/?y=YYYY&m=MM) — page entièrement
// rendue côté serveur : table#planning, une ligne par volume avec date
// (dd/mm/yyyy), lien fiche (attributs title + im = mini couverture), prix et
// éditeur. Vérifié le 02/07/2026 (289 sorties sur juillet 2026).
//
// Transport : cfTransport partagé (label cf-nautiljon) — Nautiljon renvoie
// 403 au reqwest nu (empreinte TLS), le transport bascule alors sur le
// WebView et ouvre le solveur si un challenge se présente (S13 bilan).
//
// Cache : mémoire (session) + préférence SQLite (`calendar_YYYY_MM`) avec TTL,
// pour ne pas re-scraper à chaque visite de la page.
// ============================================================================

export interface MangaRelease {
  /** Date de sortie ISO (yyyy-mm-dd). */
  date: string
  /** Nom de la série (sans le numéro de volume). */
  series: string
  /** Numéro de volume (texte), ou null (one-shot…). */
  volume: string | null
  /** Libellé complet (série + volume). */
  title: string
  /** URL absolue de la mini-couverture, ou null. */
  coverUrl: string | null
  publisher: string
  price: string | null
  /** URL absolue de la fiche Nautiljon. */
  url: string
}

const BASE = 'https://www.nautiljon.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
/** En-têtes à utiliser pour charger les couvertures (anti-hotlink). */
export const CALENDAR_IMAGE_HEADERS: Record<string, string> = {
  Referer: `${BASE}/planning/manga/`,
  'User-Agent': UA,
}

const CACHE_TTL_MS = 12 * 3_600_000
const memCache = new Map<string, MangaRelease[]>()

// 'auto' : reqwest d'abord (rapide) ; 403/challenge → WebView + solveur,
// durablement (préférence cf_mode_nautiljon).
const transport = createTransport('nautiljon', BASE, 'auto')

interface CachedMonth {
  fetchedAt: number
  releases: MangaRelease[]
}

function cacheKey(year: number, month: number): string {
  return `calendar_${year}_${String(month).padStart(2, '0')}`
}

/** dd/mm/yyyy → yyyy-mm-dd (ou null si inattendu). */
function toIsoDate(text: string): string | null {
  const m = text.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

function parsePlanning(html: string): MangaRelease[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const rows = Array.from(doc.querySelectorAll('#planning tbody tr'))
  const releases: MangaRelease[] = []

  for (const row of rows) {
    const cells = row.querySelectorAll('td')
    if (cells.length < 3) continue
    const date = toIsoDate(cells[0]?.textContent ?? '')
    const link = row.querySelector<HTMLAnchorElement>('a[href*="/mangas/"]')
    if (!date || !link) continue

    const title =
      link.getAttribute('title')?.trim() || link.textContent?.replace(/\s+/g, ' ').trim() || ''
    if (!title) continue

    // Cellule titre : « {Série} Vol. {n} » — repli : numéro final du title.
    const titleCellText =
      Array.from(cells)
        .map((td) => td.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .find((t) => t.includes('Vol.')) ?? ''
    let series = title
    let volume: string | null = null
    const volMatch = titleCellText.match(/^(.*?)\s+Vol\.\s*(\S+)/)
    if (volMatch) {
      series = volMatch[1].trim()
      volume = volMatch[2]
    } else {
      const numMatch = title.match(/^(.*?)\s+(\d+(?:\.\d+)?)$/)
      if (numMatch) {
        series = numMatch[1].trim()
        volume = numMatch[2]
      }
    }

    const im = link.getAttribute('im')
    const coverUrl = im ? (im.startsWith('http') ? im : `${BASE}${im}`) : null

    // Prix : cellule contenant « € » ; éditeur : lien /editeurs/.
    const price =
      Array.from(cells)
        .map((td) => td.textContent?.replace(/\s+/g, ' ').trim() ?? '')
        .find((t) => /€/.test(t)) ?? null
    const publisher =
      row.querySelector('td.p_editeur a, a[href*="/societes/"]')?.textContent?.trim() ?? ''

    const href = link.getAttribute('href') ?? ''
    releases.push({
      date,
      series,
      volume,
      title,
      coverUrl,
      publisher,
      price,
      url: href.startsWith('http') ? href : `${BASE}${href}`,
    })
  }
  return releases
}

/**
 * Sorties du mois demandé (month = 1..12), triées par date puis par série.
 * Lève une erreur avec message lisible si Nautiljon est inaccessible.
 */
export async function fetchMonthlyReleases(
  year: number,
  month: number,
): Promise<MangaRelease[]> {
  const key = cacheKey(year, month)
  const cached = memCache.get(key)
  if (cached) return cached

  // Cache persisté (préférences SQLite).
  try {
    const raw = await invoke<string | null>('get_preference', { key })
    if (raw) {
      const parsed = JSON.parse(raw) as CachedMonth
      if (Date.now() - parsed.fetchedAt < CACHE_TTL_MS && Array.isArray(parsed.releases)) {
        memCache.set(key, parsed.releases)
        return parsed.releases
      }
    }
  } catch {
    /* backend absent ou cache corrompu → on refetch */
  }

  const url = `${BASE}/planning/manga/?y=${year}&m=${String(month).padStart(2, '0')}`
  const body = await transport.fetchHtml(url)
  const releases = parsePlanning(body)
  if (releases.length === 0) {
    // Mois réellement vide (rare) ou markup changé : on ne cache pas longtemps
    // pour laisser une chance à un correctif/refresh.
    console.warn('[Calendar] 0 sortie parsée — markup Nautiljon changé ?')
  }
  releases.sort((a, b) => a.date.localeCompare(b.date) || a.series.localeCompare(b.series))

  memCache.set(key, releases)
  if (releases.length > 0) {
    try {
      await invoke('set_preference', {
        key,
        value: JSON.stringify({ fetchedAt: Date.now(), releases } satisfies CachedMonth),
      })
    } catch {
      /* backend absent */
    }
  }
  return releases
}
