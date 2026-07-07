import type { FilterOption, FilterValues, Manga } from '../../types'

// ============================================================================
// Helpers de scraping partagés (session 13 ter — dédup de la review).
// Regroupe ce qui était copié dans madara.ts / mangathemesia.ts /
// demonicscans.ts / mangadex.ts / scanmanga.ts / cfTransport.ts.
// ============================================================================

/**
 * UA desktop de référence. DOIT rester identique à `CF_BROWSER_UA` côté Rust
 * (commands/fetch.rs) : le cookie cf_clearance n'est valide qu'avec l'UA qui
 * l'a obtenu.
 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Réponse des commandes Rust `fetch_url` / `fetch_via_webview`. */
export interface FetchResponse {
  status: number
  body: string
  headers?: Record<string, string>
}

// --- Micro-cache de page -------------------------------------------------------

/**
 * Micro-cache du DERNIER HTML récupéré (une seule entrée, TTL court).
 * `getMangaDetails` puis `getChapterList` re-téléchargent la même fiche —
 * or sur une source Cloudflare en mode `navigate`, chaque récupération coûte
 * une navigation WebView complète (plusieurs secondes). Le TTL court garantit
 * qu'un rafraîchissement manuel ultérieur revoit bien le site.
 */
export function createPageMicroCache(ttlMs = 20_000) {
  let entry: { url: string; html: string; at: number } | null = null
  return {
    async fetch(url: string, fetcher: (url: string) => Promise<string>): Promise<string> {
      if (entry && entry.url === url && Date.now() - entry.at < ttlMs) return entry.html
      const html = await fetcher(url)
      entry = { url, html, at: Date.now() }
      return html
    },
  }
}

// --- Valeurs de filtres -------------------------------------------------------

/** Valeur multiselect d'un FilterValues, sinon []. */
export function strList(v: FilterValues[string]): string[] {
  return Array.isArray(v) ? v : []
}

/** Valeur texte (trimée) d'un FilterValues, sinon ''. */
export function str(v: FilterValues[string]): string {
  return typeof v === 'string' ? v.trim() : ''
}

// --- Parsing de formulaires de filtres (Madara / Themesia / custom) -----------

/** Libellé associé à un input (label[for], sinon texte du parent, sinon value). */
export function inputLabel(doc: Document, input: Element): string {
  const id = input.getAttribute('id')
  const label = id ? doc.querySelector(`label[for="${id}"]`) : null
  return (
    label?.textContent?.trim() ||
    input.parentElement?.textContent?.trim() ||
    input.getAttribute('value') ||
    ''
  )
}

/**
 * Options d'un groupe d'inputs (checkboxes/radios) `name="..."`, dédupliquées
 * par valeur. `keepEmptyValue` conserve l'option vide (radio « Tous »).
 */
export function inputOptions(
  doc: Document,
  name: string,
  opts: { keepEmptyValue?: boolean } = {},
): FilterOption[] {
  const seen = new Set<string>()
  const options: FilterOption[] = []
  doc.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    const value = input.getAttribute('value') ?? ''
    if (!value && !opts.keepEmptyValue) return
    if (seen.has(value)) return
    seen.add(value)
    options.push({ value, label: inputLabel(doc, input) || value || 'Tous' })
  })
  return options
}

// --- Dates & statuts -----------------------------------------------------------

/**
 * Date « humaine » de site de scan (FR/EN) → epoch ms : ISO/US direct, sinon
 * relatif (« il y a 2 jours », « 3 hours ago »). 0 si illisible.
 */
export function parseRelativeDate(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  const direct = Date.parse(trimmed)
  if (!Number.isNaN(direct)) return direct
  const rel = trimmed
    .toLowerCase()
    .match(
      /(\d+)\s*(seconde?|second|minute|min|heure|hour|jour|day|semaine|week|mois|month|année|an|year)/,
    )
  if (!rel) return 0
  const n = parseInt(rel[1], 10)
  const unit = rel[2]
  const factor = unit.startsWith('second') || unit.startsWith('seconde')
    ? 1000
    : unit.startsWith('min')
      ? 60_000
      : unit.startsWith('heure') || unit.startsWith('hour')
        ? 3_600_000
        : unit.startsWith('jour') || unit.startsWith('day')
          ? 86_400_000
          : unit.startsWith('semaine') || unit.startsWith('week')
            ? 7 * 86_400_000
            : unit.startsWith('mois') || unit.startsWith('month')
              ? 30 * 86_400_000
              : 365 * 86_400_000
  return Date.now() - n * factor
}

/** Statut de publication d'après un libellé FR/EN de site de scan. */
export function parseScanStatus(text: string): Manga['status'] {
  const t = text.toLowerCase()
  if (!t) return 'unknown'
  if (t.includes('en cours') || t.includes('ongoing') || t.includes('publishing')) {
    return 'ongoing'
  }
  if (
    t.includes('terminé') ||
    t.includes('completed') ||
    t.includes('fini') ||
    t.includes('finished')
  ) {
    return 'completed'
  }
  if (t.includes('hiatus') || t.includes('pause')) return 'hiatus'
  if (t.includes('annul') || t.includes('cancelled') || t.includes('abandonn') || t.includes('dropped')) {
    return 'cancelled'
  }
  return 'unknown'
}
