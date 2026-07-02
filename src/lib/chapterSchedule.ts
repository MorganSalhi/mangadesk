import { invoke } from '@tauri-apps/api/core'

// ============================================================================
// Pronostic des sorties de chapitres (session 13 bis).
//
// Il n'existe pas de planning centralisé des chapitres (l'API MangaPlus
// est verrouillée, les sites de scan n'annoncent rien) — mais l'app connaît
// les dates de publication des chapitres de la bibliothèque. On en déduit,
// par série, la cadence médiane de parution et la date ESTIMÉE du prochain
// chapitre. Les séries au rythme erratique (ex. Berserk) sont classées
// « irrégulières » plutôt que d'afficher une fausse date.
// ============================================================================

/** Ligne brute renvoyée par la commande `get_chapter_schedule`. */
interface ScheduleRow {
  mangaId: string
  remoteId: string
  sourceId: string
  title: string
  coverUrl: string | null
  status: string | null
  number: number
  dateUpload: number
}

export interface ChapterForecast {
  mangaId: string
  /** Id distant (celui des routes /manga/:sourceId/:mangaId). */
  remoteId: string
  sourceId: string
  title: string
  coverUrl: string | null
  /** Dernier chapitre connu. */
  lastNumber: number
  lastDate: number
  /** Intervalle médian entre deux sorties (jours) — null si irrégulier. */
  intervalDays: number | null
  /** Libellé de cadence (« ~hebdomadaire »…) — null si irrégulier. */
  cadence: string | null
  /** Date estimée de la prochaine sortie (epoch ms) — null si irrégulier. */
  nextDate: number | null
  /** true si la sortie estimée est déjà passée (chapitre « attendu »). */
  overdue: boolean
}

const DAY_MS = 86_400_000
/** Deux chapitres publiés à moins de 36 h d'écart = un même « drop ». */
const SAME_DROP_MS = 36 * 3_600_000
/** Au-delà (jours), la série est considérée en pause/irrégulière. */
const MAX_INTERVAL_DAYS = 75
/** Dispersion relative (MAD/médiane) au-delà de laquelle on ne prédit pas. */
const MAX_RELATIVE_SPREAD = 0.6

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function cadenceLabel(days: number): string {
  if (days <= 9) return '~hebdomadaire'
  if (days <= 20) return '~bimensuel'
  if (days <= 45) return '~mensuel'
  return `~tous les ${Math.round(days)} j`
}

/**
 * Construit le pronostic d'une série à partir des dates (desc) de ses derniers
 * chapitres. Exporté pour testabilité.
 */
export function forecastFromDates(
  datesDesc: number[],
  now = Date.now(),
): Pick<ChapterForecast, 'intervalDays' | 'cadence' | 'nextDate' | 'overdue'> {
  // Regroupe les chapitres publiés en rafale (multi-chapitres le même jour)
  // en une seule « sortie », sinon les intervalles seraient pollués de zéros.
  const drops: number[] = []
  for (const d of datesDesc) {
    if (drops.length === 0 || drops[drops.length - 1] - d > SAME_DROP_MS) {
      drops.push(d)
    }
  }

  const none = { intervalDays: null, cadence: null, nextDate: null, overdue: false }
  if (drops.length < 3) return none // pas assez d'historique pour prédire

  const intervals: number[] = []
  for (let i = 0; i + 1 < drops.length && intervals.length < 6; i++) {
    intervals.push((drops[i] - drops[i + 1]) / DAY_MS)
  }
  const med = median(intervals)
  if (med <= 0 || med > MAX_INTERVAL_DAYS) return none
  // Dispersion : écart absolu médian — rythme erratique → pas de prédiction.
  const mad = median(intervals.map((v) => Math.abs(v - med)))
  if (mad / med > MAX_RELATIVE_SPREAD) return none

  // Prochaine sortie : dernière sortie + médiane. Si la date est déjà passée,
  // on projette sur la prochaine occurrence à venir (série en léger retard →
  // « attendu »), sans dépasser un cycle complet de retard.
  let next = drops[0] + med * DAY_MS
  const overdue = next < now
  if (overdue && now - next > med * DAY_MS) {
    // Plus d'un cycle de retard : probablement une pause non détectée.
    return none
  }
  return { intervalDays: med, cadence: cadenceLabel(med), nextDate: next, overdue }
}

/** Pronostics de toute la bibliothèque, triés par prochaine sortie estimée. */
export async function fetchChapterForecasts(): Promise<ChapterForecast[]> {
  const rows = await invoke<ScheduleRow[]>('get_chapter_schedule')

  // Regroupe par manga (les lignes arrivent triées manga_id / date desc).
  const byManga = new Map<string, ScheduleRow[]>()
  for (const row of rows) {
    const list = byManga.get(row.mangaId) ?? []
    list.push(row)
    byManga.set(row.mangaId, list)
  }

  const now = Date.now()
  const forecasts: ChapterForecast[] = []
  for (const list of byManga.values()) {
    const first = list[0]
    const dates = list.map((r) => r.dateUpload).filter((d) => d > 0 && d <= now + DAY_MS)
    if (dates.length === 0) continue
    forecasts.push({
      mangaId: first.mangaId,
      remoteId: first.remoteId,
      sourceId: first.sourceId,
      title: first.title,
      coverUrl: first.coverUrl,
      lastNumber: first.number,
      lastDate: dates[0],
      ...forecastFromDates(dates, now),
    })
  }

  forecasts.sort((a, b) => {
    // Prédits d'abord (par date estimée croissante), irréguliers ensuite
    // (par dernière sortie décroissante).
    if (a.nextDate != null && b.nextDate != null) return a.nextDate - b.nextDate
    if (a.nextDate != null) return -1
    if (b.nextDate != null) return 1
    return b.lastDate - a.lastDate
  })
  return forecasts
}
