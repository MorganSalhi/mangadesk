import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

// ============================================================================
// Chargement d'images distantes via `fetch_image_as_base64` (session 13 ter —
// dédup de la review) : ce pattern était copié dans 7 fichiers, sans cache ni
// label Cloudflare homogène (History/Updates/Stats perdaient le repli WebView).
//
// - Cache LRU en mémoire : le backend ne cache pas, chaque affichage refaisait
//   le fetch réseau complet (re-visiter une page = re-télécharger les covers).
// - Dédoublonnage : plusieurs composants demandant la même URL partagent la
//   même promesse au lieu d'empiler N requêtes identiques.
// ============================================================================

const MAX_CACHE_ENTRIES = 300
const cache = new Map<string, string>()
const pending = new Map<string, Promise<string>>()

export interface RemoteImageOptions {
  /** Id de la source : active le repli WebView Cloudflare (`cf-{sourceId}`). */
  sourceId?: string | null
  headers?: Record<string, string>
}

function keyOf(url: string, sourceId?: string | null): string {
  return `${sourceId ?? ''}|${url}`
}

/** Data-URI base64 de l'image (cache LRU + requêtes concurrentes partagées). */
export async function fetchRemoteImage(
  url: string,
  opts: RemoteImageOptions = {},
): Promise<string> {
  const key = keyOf(url, opts.sourceId)
  const hit = cache.get(key)
  if (hit !== undefined) {
    // LRU : re-insertion en fin de Map (ordre d'insertion = ancienneté).
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  let promise = pending.get(key)
  if (!promise) {
    promise = invoke<string>('fetch_image_as_base64', {
      url,
      headers: opts.headers ?? {},
      label: opts.sourceId ? `cf-${opts.sourceId}` : null,
    })
      .then((data) => {
        cache.set(key, data)
        if (cache.size > MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        return data
      })
      .finally(() => pending.delete(key))
    pending.set(key, promise)
  }
  return promise
}

/**
 * Hook composant : null pendant le chargement, data-URI au succès, URL brute
 * en dernier recours (échec backend). `headers` doit être une référence
 * stable (constante module) — il n'est pas suivi comme dépendance.
 */
export function useRemoteImage(
  url: string | null | undefined,
  opts: RemoteImageOptions = {},
): string | null {
  const [src, setSrc] = useState<string | null>(() =>
    url ? cache.get(keyOf(url, opts.sourceId)) ?? null : null,
  )

  useEffect(() => {
    if (!url) {
      setSrc(null)
      return
    }
    let cancelled = false
    fetchRemoteImage(url, opts)
      .then((data) => !cancelled && setSrc(data))
      .catch(() => !cancelled && setSrc(url))
    return () => {
      cancelled = true
    }
    // opts.headers : référence stable exigée (cf. docstring).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, opts.sourceId])

  return src
}
