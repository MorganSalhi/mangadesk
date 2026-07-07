import { invoke } from '@tauri-apps/api/core'
import { DESKTOP_UA as UA, type FetchResponse } from './scrape'

// ============================================================================
// Transport HTTP réutilisable pour les sources scrapées.
//
// Stratégie : `reqwest` d'abord (rapide, aucune fenêtre). Si la réponse trahit
// un blocage Cloudflare (403/503 ou page de challenge JS), on bascule
// automatiquement et durablement sur le WebView (vrai Chrome → empreinte TLS
// valide + cookie cf_clearance same-origin). Cf. SESSION7.
//
// Chaque source a sa propre fenêtre solveur (`cf-{sourceId}`) et ses propres
// préférences persistées, pour que plusieurs sources Cloudflare coexistent.
// ============================================================================

interface CloudflareClearance {
  cookie: string
  userAgent: string
}

type Mode = 'reqwest' | 'webview'

export interface FetchOptions {
  method?: 'GET' | 'POST'
  body?: string
  referer?: string
}

/** Détecte une page de challenge Cloudflare renvoyée en HTTP 200. */
function isCloudflareChallenge(body: string): boolean {
  // Marqueurs forts (uniques aux pages de challenge) : quelle que soit la taille
  // — la page Turnstile fait ~27 Ko, donc la garde de longueur ne suffit pas.
  if (/_cf_chl_opt|cf-turnstile-response|cf-chl-widget|__cf_chl|challenge-platform/i.test(body)) {
    return true
  }
  if (body.length > 6000) return false // une vraie page est volumineuse
  return /just a moment|un instant|cf-mitigated|Attention Required|enable javascript and cookies/i.test(
    body,
  )
}

export interface ApiOptions {
  method?: 'GET' | 'POST'
  body?: string
  headers?: Record<string, string>
  /** Referer complet à poser via l'option `referrer` du fetch (en-tête interdit). */
  referrer?: string
}

export interface Transport {
  /** Récupère le HTML (ou fragment) d'une URL, en gérant Cloudflare. */
  fetchHtml(url: string, opts?: FetchOptions): Promise<string>
  /**
   * Requête API via le WebView (même session CF, TLS navigateur, CORS géré par
   * le site) avec en-têtes arbitraires. Pour les endpoints même-site que
   * `reqwest` ne peut atteindre (403), ex. `bqj.scan-manga.com/lel`. Ne navigue
   * pas et ne re-solve pas : la fenêtre reste sur la page courante (Origin/Referer
   * corrects, posés par le navigateur).
   */
  fetchApi(url: string, opts?: ApiOptions): Promise<{ status: number; body: string }>
  /**
   * Évalue `js` dans le WebView de la source et renvoie le résultat sérialisé
   * JSON. Pour lire une valeur posée par le JS de la page (ex. réponse `lel`
   * capturée dans `window.__lel`).
   */
  evalJson(js: string): Promise<string>
  /**
   * Affiche la fenêtre (hors écran) et la fait défiler pour forcer le lecteur à
   * décoder toutes ses pages (lazy-load gelé quand la fenêtre est masquée).
   * Renvoie le nombre de blobs images prêts dans `window.__blobs`.
   */
  harvestBlobs(expected: number, timeoutMs?: number): Promise<number>
  /** Cookie cf_clearance courant (pour en-têtes images), ou null. */
  readonly cookie: string | null
  /** User-Agent à utiliser pour les images (cohérent avec le cookie). */
  readonly userAgent: string
}

export interface TransportConfig {
  /** UA imposé (solveur + reqwest). Ex. Scan-Manga : UA mobile pour rester sur `m.`. */
  userAgent?: string
  /**
   * Comment récupérer le HTML une fois en mode WebView :
   * - 'fetch' (défaut) : `fetch()` dans le WebView (rapide).
   * - 'navigate' : navigation réelle (`render_via_webview`) puis lecture du DOM.
   *   Nécessaire quand le WAF refuse le `fetch` programmatique d'une page HTML
   *   (Sec-Fetch-Mode: cors → 403), ex. Scan-Manga.
   */
  htmlVia?: 'fetch' | 'navigate'
}

/**
 * @param cloudflare 'always' force d'emblée le WebView (site connu CF) ;
 *                   'auto' (défaut) essaie reqwest puis bascule si blocage.
 */
export function createTransport(
  sourceId: string,
  baseUrl: string,
  cloudflare: 'always' | 'auto' = 'auto',
  config: TransportConfig = {},
): Transport {
  const label = `cf-${sourceId}`
  const MODE_PREF = `cf_mode_${sourceId}`
  const COOKIE_PREF = `cf_cookie_${sourceId}`
  const UA_PREF = `cf_ua_${sourceId}`

  const userAgentOverride = config.userAgent
  const htmlVia = config.htmlVia ?? 'fetch'

  // UA par défaut desktop, sauf si la source en impose un (ex. Scan-Manga a
  // besoin d'un UA mobile pour rester sur `m.` sans être redirigé vers `www.`).
  const baseUA = userAgentOverride ?? UA

  let mode: Mode = cloudflare === 'always' ? 'webview' : 'reqwest'
  let cookie: string | null = null
  let userAgent = baseUA
  let loaded = false
  let solving: Promise<boolean> | null = null

  async function load(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const m = await invoke<string | null>('get_preference', { key: MODE_PREF })
      if (m === 'webview') mode = 'webview'
      cookie = (await invoke<string | null>('get_preference', { key: COOKIE_PREF })) ?? null
      // Une source qui impose son UA ignore un éventuel UA persisté (ex. valeur
      // desktop d'une ancienne session → empêcherait Scan-Manga de rester sur `m.`).
      const ua = await invoke<string | null>('get_preference', { key: UA_PREF })
      if (ua && !userAgentOverride) userAgent = ua
    } catch {
      /* prefs indisponibles (tests) */
    }
  }

  async function persistMode(): Promise<void> {
    try {
      await invoke('set_preference', { key: MODE_PREF, value: mode })
    } catch {
      /* ignore */
    }
  }

  async function solve(target: string): Promise<boolean> {
    if (solving) return solving
    solving = (async () => {
      try {
        // On ouvre le solveur sur l'URL réellement bloquée (pas la racine) :
        // certains sites ne posent le challenge que sur certaines pages.
        const res = await invoke<CloudflareClearance>('solve_cloudflare', {
          url: target,
          label,
          userAgent: userAgentOverride,
        })
        cookie = res.cookie
        userAgent = res.userAgent || UA
        try {
          await invoke('set_preference', { key: COOKIE_PREF, value: cookie })
          await invoke('set_preference', { key: UA_PREF, value: userAgent })
        } catch {
          /* ignore */
        }
        return true
      } catch {
        return false
      } finally {
        solving = null
      }
    })()
    return solving
  }

  async function fetchApi(
    url: string,
    opts: ApiOptions = {},
  ): Promise<{ status: number; body: string }> {
    const res = await invoke<FetchResponse>('fetch_via_webview', {
      url,
      method: opts.method ?? 'GET',
      body: opts.body ?? null,
      label,
      headers: opts.headers ?? null,
      referrer: opts.referrer ?? null,
    })
    return { status: res.status, body: res.body }
  }

  async function evalJson(js: string): Promise<string> {
    return invoke<string>('eval_webview', { label, js })
  }

  async function harvestBlobs(expected: number, timeoutMs = 60000): Promise<number> {
    return invoke<number>('harvest_blobs', { label, expected, timeoutMs })
  }

  async function viaWebview(url: string, opts: FetchOptions): Promise<string> {
    const args = { url, method: opts.method ?? 'GET', body: opts.body ?? null, label }
    const run = async () => {
      const res = await invoke<FetchResponse>('fetch_via_webview', args)
      if (res.status !== 200) throw new Error(`${sourceId} HTTP ${res.status} sur ${url}`)
      return res.body
    }
    try {
      return await run()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('CF_NEEDS_SOLVE')) {
        const ok = await solve(url)
        if (!ok) {
          throw new Error(
            `CLOUDFLARE_BLOCKED: ${sourceId} requiert une vérification Cloudflare. ` +
              `Cliquez pour l'ouvrir, résolvez le challenge, puis réessayez.`,
          )
        }
        return await run()
      }
      throw err
    }
  }

  /**
   * Récupère le HTML par **navigation** réelle du WebView (render_via_webview),
   * puis lit le DOM rendu. Reproduit un chargement navigateur (Sec-Fetch-Mode:
   * navigate) que Cloudflare accepte là où un `fetch()` est refusé en 403.
   */
  async function viaRender(url: string): Promise<string> {
    const run = async () => {
      const res = await invoke<FetchResponse>('render_via_webview', { url, label })
      return res.body
    }
    const needsSolve = (b: string) => isCloudflareChallenge(b)
    try {
      const body = await run()
      if (!needsSolve(body)) return body
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('CF_NEEDS_SOLVE')) throw err
    }
    // Challenge présent ou pas de session : on résout puis on rejoue.
    if (!(await solve(url))) {
      throw new Error(
        `CLOUDFLARE_BLOCKED: ${sourceId} requiert une vérification Cloudflare. ` +
          `Cliquez pour l'ouvrir, résolvez le challenge, puis réessayez.`,
      )
    }
    return run()
  }

  function fetchHtmlWebview(url: string, opts: FetchOptions): Promise<string> {
    // Navigation pour les GET HTML quand le WAF refuse le fetch (Scan-Manga) ;
    // fetch() sinon (et toujours pour les POST AJAX).
    if (htmlVia === 'navigate' && (opts.method ?? 'GET') === 'GET') return viaRender(url)
    return viaWebview(url, opts)
  }

  async function viaReqwest(url: string, opts: FetchOptions): Promise<FetchResponse> {
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      Referer: opts.referer ?? baseUrl,
    }
    if (opts.method === 'POST') headers['X-Requested-With'] = 'XMLHttpRequest'
    if (cookie) headers.Cookie = cookie
    return invoke<FetchResponse>('fetch_url', {
      url,
      headers,
      method: opts.method ?? 'GET',
      body: opts.body ?? null,
    })
  }

  async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<string> {
    await load()

    if (mode === 'webview') return fetchHtmlWebview(url, opts)

    // Mode reqwest : tente, et bascule durablement sur WebView si blocage CF.
    const res = await viaReqwest(url, opts)
    const blocked =
      res.status === 403 || res.status === 503 || isCloudflareChallenge(res.body)
    if (blocked) {
      mode = 'webview'
      void persistMode()
      return fetchHtmlWebview(url, opts)
    }
    if (res.status !== 200) throw new Error(`${sourceId} HTTP ${res.status} sur ${url}`)
    return res.body
  }

  return {
    fetchHtml,
    fetchApi,
    evalJson,
    harvestBlobs,
    get cookie() {
      return cookie
    },
    get userAgent() {
      return userAgent
    },
  }
}
