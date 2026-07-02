// ============================================================================
// Détermination du nombre de pages d'un catalogue quand la pagination du site
// ne lie pas la dernière page (Madara n'affiche que « page suivante »,
// DemonicScans tronque avec « . . . »). Sans cela, un « manga aléatoire »
// resterait cantonné aux premières pages (les têtes d'affiche).
//
// Stratégie : sonde exponentielle (2, 4, 8, … jusqu'à une page vide ou au
// plafond), puis dichotomie courte pour resserrer. Coût borné (~6-8 requêtes),
// à ne payer qu'une fois — l'appelant met le résultat en cache session.
// ============================================================================

export interface ProbeOptions {
  /** Dernière page dont on SAIT qu'elle est non vide (défaut 1). */
  knownMax?: number
  /** Plafond de la sonde (défaut 128 pages). */
  cap?: number
}

/**
 * Renvoie la dernière page non vide du catalogue (approximation basse en cas
 * de plafond atteint). `countAt(page)` doit renvoyer le nombre d'entrées de la
 * page (0 = au-delà de la fin).
 */
export async function probeMaxPage(
  countAt: (page: number) => Promise<number>,
  opts: ProbeOptions = {},
): Promise<number> {
  const cap = Math.max(1, opts.cap ?? 128)
  let lo = Math.max(1, opts.knownMax ?? 1) // non vide (supposé)
  let hi: number | null = null // premier vide connu

  let probe = Math.max(2, lo * 2)
  for (let i = 0; i < 6 && probe <= cap; i++) {
    if ((await countAt(probe)) > 0) {
      lo = probe
      probe *= 2
    } else {
      hi = probe
      break
    }
  }
  if (hi == null) return lo // plafond (ou cap) atteint sans page vide

  // Dichotomie courte : 2 itérations suffisent pour un aléatoire correct.
  for (let i = 0; i < 2 && hi - lo > 1; i++) {
    const mid = Math.floor((lo + hi) / 2)
    if ((await countAt(mid)) > 0) lo = mid
    else hi = mid
  }
  return lo
}

/** Élément aléatoire d'un tableau non vide. */
export function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}
