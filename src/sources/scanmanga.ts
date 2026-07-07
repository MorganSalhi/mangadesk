import type {
  Chapter,
  FilterValues,
  SourceFilterDef,
  Manga,
  MangaListPage,
  MangaPreview,
  Page,
  Source,
} from '../types'
import { createTransport, type Transport } from './engines/cfTransport'
import { DESKTOP_UA } from './engines/scrape'

// ============================================================================
// Scan-Manga (m.scan-manga.com) — moteur 100% custom. Port fidèle de
// l'extension Keiyoushi `eu.kanade.tachiyomi.extension.fr.scanmanga`.
//
// Le HTML passe par le transport CF (Cloudflare). La lecture des pages est le
// morceau dur : script « Hunter » obfusqué → params sml/sme/idc → fingerprint
// WebGL → POST signé vers l'API `lel` → réponse base64+zlib+reverse+base64.
// Cf. SESSION7.
// ============================================================================

const DOMAIN = 'scan-manga.com'
// Le sous-domaine mobile `m.` redirige désormais vers `www.` (et renvoie 500 si
// on le force en UA mobile) : le site vivant est `www.`. On scrape donc `www.`
// en UA desktop, via navigation réelle (render) pour passer Cloudflare.
const BASE_URL = `https://www.${DOMAIN}`
const BASE_IMAGE_URL = `https://static.${DOMAIN}/img/manga`

interface ScanMangaPage {
  f: string // filename
  e: string // extension
}
interface UrlPayload {
  dN: string
  s: string
  v: string
  c: string
  p: Record<string, ScanMangaPage>
}
interface MangaSearchDto {
  title?: { nom_match: string; url: string; image: string }[]
}

// --- base64url pour les ids (les URLs Scan-Manga contiennent des `/`, qui
//     casseraient le routage React Router /manga/:id et /reader/:chapterId). --
function encId(path: string): string {
  return btoa(unescape(encodeURIComponent(path)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}
function decId(id: string): string {
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/')
  return decodeURIComponent(escape(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))))
}

/**
 * Récupère l'URL réelle d'une vignette lazy-loadée. La page d'accueil met un
 * placeholder `lazy_130x45.jpg` dans `src` et la vraie URL dans un attribut
 * `data-*` (tant que la ligne n'a pas défilé dans le viewport). On essaie donc
 * les `data-*` d'abord, en ignorant tout ce qui ressemble à un placeholder.
 */
function pickImgUrl(img: Element | null): string {
  if (!img) return ''
  const attrs = ['data-src', 'data-original', 'data-lazy-src', 'data-echo', 'src']
  for (const a of attrs) {
    const v = img.getAttribute(a)
    if (v && !/lazy/i.test(v)) return v
  }
  return img.getAttribute('src') ?? ''
}

function toPath(href: string): string {
  try {
    return new URL(href, BASE_URL).pathname
  } catch {
    return href.startsWith('/') ? href : `/${href}`
  }
}

function b64ToBytes(b64: string): Uint8Array {
  let s = b64.replace(/\s+/g, '')
  while (s.length % 4 !== 0) s += '='
  const bin = atob(s)
  const a = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
  return a
}

async function zlibInflate(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream('deflate')
  const ab = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer()
  return new TextDecoder().decode(ab)
}

/** Décode la réponse de l'API lel → payload d'URLs d'images. */
async function decodeLel(data: string, idc: number): Promise<UrlPayload> {
  if (data.includes('error')) {
    throw new Error(`Scan-Manga: API lel a renvoyé une erreur (${data.slice(0, 120)})`)
  }
  const inflated = await zlibInflate(b64ToBytes(data))
  const hexIdc = idc.toString(16)
  const cleaned = inflated.endsWith(hexIdc) ? inflated.slice(0, -hexIdc.length) : inflated
  const rev = cleaned.split('').reverse().join('')
  const json = new TextDecoder().decode(b64ToBytes(rev))
  return JSON.parse(json) as UrlPayload
}

export class ScanMangaSource implements Source {
  readonly id = 'scanmanga'
  readonly name = 'Scan-Manga'
  readonly lang = 'fr'
  readonly baseUrl = BASE_URL
  readonly version = '1.0.0'
  readonly isNsfw = true
  readonly supportsLatest = true
  filters: SourceFilterDef[] = []

  private dynamicFiltersPromise: Promise<SourceFilterDef[]> | null = null
  /** Chemins des pages TOP (cache session, pour getRandom). */
  private topPaths: string[] = []

  // htmlVia='navigate' : Scan-Manga refuse en 403 le fetch() programmatique des
  // pages HTML (Sec-Fetch-Mode: cors). On passe par une navigation réelle.
  private readonly transport: Transport = createTransport('scanmanga', BASE_URL, 'auto', {
    userAgent: DESKTOP_UA,
    htmlVia: 'navigate',
  })

  /**
   * Filtres : le site n'a pas de recherche paramétrable scrapable (formulaire
   * avancé 100% AJAX obfusqué), mais publie des pages « TOP » par catégorie
   * (/TOP-Shonen-53.html…, 100 titres classés par popularité). On les découvre
   * dynamiquement depuis la page « liste des séries » — les numéros dans les
   * URLs changent, d'où le parsing plutôt que des chemins codés en dur.
   */
  async getFilters(): Promise<SourceFilterDef[]> {
    this.dynamicFiltersPromise ??= (async () => {
      const html = await this.transport.fetchHtml(`${BASE_URL}/scanlation/liste_series.html`)
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const seen = new Set<string>()
      const options: { value: string; label: string }[] = [
        { value: '', label: 'Dernières sorties (défaut)' },
      ]
      doc.querySelectorAll<HTMLAnchorElement>('a[href*="/TOP-"]').forEach((a) => {
        const path = toPath(a.getAttribute('href') ?? '')
        const m = path.match(/\/TOP-(.+)-\d+\.html$/)
        if (!m || seen.has(path)) return
        seen.add(path)
        const label = (a.textContent?.trim() || m[1].replace(/-/g, ' ')).trim()
        options.push({ value: path, label: `TOP ${label}` })
      })
      this.topPaths = options.map((o) => o.value).filter(Boolean)
      const defs: SourceFilterDef[] =
        options.length > 1
          ? [{ id: 'top', name: 'Classement par catégorie', type: 'select', default: '', options }]
          : []
      this.filters = defs
      return defs
    })()
    try {
      return await this.dynamicFiltersPromise
    } catch (err) {
      this.dynamicFiltersPromise = null
      throw err
    }
  }

  /** Parse une page TOP : entrées `.image_manga a` (+ titre/cover lazy). */
  private parseTopPage(html: string): MangaPreview[] {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const mangas: MangaPreview[] = []
    const seen = new Set<string>()
    doc.querySelectorAll('.image_manga a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? ''
      if (!/\.html$/.test(href)) return
      const id = encId(toPath(href))
      if (seen.has(id)) return
      const img = a.querySelector('img')
      const title = img?.getAttribute('title')?.trim() || img?.getAttribute('alt')?.trim() || ''
      if (!title) return
      seen.add(id)
      mangas.push({ id, title, coverUrl: pickImgUrl(img), sourceId: this.id })
    })
    return mangas
  }

  /** Manga aléatoire : catégorie TOP aléatoire, puis entrée aléatoire (~100/page). */
  async getRandom(): Promise<MangaPreview> {
    if (this.topPaths.length === 0) {
      await this.getFilters().catch(() => {})
    }
    if (this.topPaths.length === 0) {
      // Repli : dernières sorties de la page d'accueil.
      const latest = await this.getLatest(1)
      if (latest.mangas.length === 0) throw new Error('Scan-Manga: catalogue inaccessible.')
      return latest.mangas[Math.floor(Math.random() * latest.mangas.length)]
    }
    const path = this.topPaths[Math.floor(Math.random() * this.topPaths.length)]
    const mangas = this.parseTopPage(await this.transport.fetchHtml(`${BASE_URL}${path}`))
    if (mangas.length === 0) throw new Error('Scan-Manga: page TOP vide ou inaccessible.')
    return mangas[Math.floor(Math.random() * mangas.length)]
  }

  async search(query: string, page: number, filters: FilterValues): Promise<MangaListPage> {
    const q = query.trim()
    if (!q) {
      // Filtre « TOP catégorie » actif → page de classement correspondante.
      const top = typeof filters.top === 'string' ? filters.top : ''
      if (top && /^\/TOP-[\w-]+\.html$/.test(top)) {
        if (page > 1) return { mangas: [], hasNextPage: false, currentPage: page }
        const mangas = this.parseTopPage(await this.transport.fetchHtml(`${BASE_URL}${top}`))
        return { mangas, hasNextPage: false, currentPage: page }
      }
      // Pas de recherche → nouveautés de la page d'accueil (la page « TOP »
      // dépend d'un numéro magique fragile et n'existe pas sur le sous-domaine m.).
      return this.getLatest(page)
    }

    // L'endpoint deviné renvoie du vide : on PILOTE le vrai champ de recherche du
    // site (autocomplete) et on capte SA requête/réponse via le hook réseau
    // (window.__net), sans deviner endpoint ni paramètres.
    await this.transport.fetchHtml(`${BASE_URL}/`) // garantit la fenêtre sur le site

    // Active la capture, saisit la requête dans <input type=search> et déclenche
    // les events que l'autocomplete écoute.
    const qJson = JSON.stringify(q)
    const trigger =
      '(function(){try{' +
      'window.__netCapture=true; window.__net=[];' +
      "var i=document.querySelector('input[type=search]')||document.querySelector('input[placeholder*=echerch i]');" +
      "if(!i) return 'no-input';" +
      'i.focus();' +
      "var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i," +
      qJson +
      ');' +
      "['keydown','keyup','input','change'].forEach(function(t){i.dispatchEvent(new Event(t,{bubbles:true}));});" +
      "i.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'a',keyCode:65,which:65}));" +
      "return 'ok';}catch(e){return 'err '+e}})()"
    try {
      await this.transport.evalJson(trigger)
    } catch {
      /* ignore */
    }

    // Attend la réponse captée.
    type Net = { url: string; method: string; status: number; text: string }
    let net: Net[] = []
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 300))
      try {
        net = JSON.parse(JSON.parse(await this.transport.evalJson('JSON.stringify(window.__net||[])')) as string) as Net[]
      } catch {
        net = []
      }
      if (net.some((e) => e.text && e.text.length > 2)) break
    }
    try {
      await this.transport.evalJson('window.__netCapture=false')
    } catch {
      /* ignore */
    }

    // Parse chaque réponse captée selon le format quick.json connu.
    const mangas: MangaPreview[] = []
    for (const e of net) {
      try {
        const dto = JSON.parse(e.text) as MangaSearchDto
        for (const it of dto.title ?? []) {
          mangas.push({
            id: encId(toPath(it.url)),
            title: it.nom_match,
            coverUrl: `${BASE_IMAGE_URL}/${it.image}`,
            sourceId: this.id,
          })
        }
      } catch {
        /* pas ce format */
      }
    }
    // mangas peut être vide = recherche sans résultat (cas normal).
    return { mangas, hasNextPage: false, currentPage: page }
  }

  async getLatest(page: number): Promise<MangaListPage> {
    const html = await this.transport.fetchHtml(`${BASE_URL}/`)
    const doc = new DOMParser().parseFromString(html, 'text/html')
    // Page d'accueil www. : « Dernières publications » = lignes `div.listing`.
    // Manga : `a.nom_manga` ; couverture : `.logo_manga img` (URL absolue).
    const mangas: MangaPreview[] = []
    const seen = new Set<string>()
    doc.querySelectorAll('div.listing').forEach((el) => {
      const a = el.querySelector<HTMLAnchorElement>('a.nom_manga')
      if (!a) return
      const id = encId(toPath(a.getAttribute('href') ?? ''))
      if (seen.has(id)) return
      seen.add(id)
      mangas.push({
        id,
        title: a.textContent?.trim() ?? '',
        coverUrl: pickImgUrl(el.querySelector('.logo_manga img')),
        sourceId: this.id,
      })
    })
    return { mangas, hasNextPage: false, currentPage: page }
  }

  async getMangaDetails(mangaId: string): Promise<Manga> {
    const html = await this.transport.fetchHtml(`${BASE_URL}${decId(mangaId)}`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // Site desktop www. : les infos fiables sont dans les balises Open Graph.
    // og:title = "Lire {Titre} VF - {types} ({année} - {auteur})".
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? ''
    const title = ogTitle.match(/^Lire\s+(.+?)\s+VF\b/i)?.[1]?.trim() ||
      doc.querySelector('h1')?.textContent?.trim() ||
      mangaId
    // Partie après " VF - " : "{types} ({année} - {auteur})".
    const after = ogTitle.split(/\sVF\s*-\s*/i)[1] ?? ''
    const genres = (after.split('(')[0] ?? '')
      .split(/[/,]/)
      .map((g) => g.trim())
      .filter(Boolean)
    const paren = after.match(/\(([^)]*)\)/)?.[1] ?? '' // "2026 - 울엄마"
    const author = paren.includes('-') ? paren.split('-').slice(1).join('-').trim() : ''

    return {
      id: mangaId,
      title,
      coverUrl: doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? '',
      sourceId: this.id,
      description:
        doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ?? '',
      author,
      artist: '',
      status: 'unknown',
      genres,
      inLibrary: false,
    }
  }

  async getChapterList(mangaId: string): Promise<Chapter[]> {
    const html = await this.transport.fetchHtml(`${BASE_URL}${decId(mangaId)}`)
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // Site desktop www. : chaque chapitre est un `li.chapitre`, le lien dans
    // `div.chapitre_nom a` (repli : 1er lien /lecture-en-ligne/ du <li>).
    const items = Array.from(doc.querySelectorAll('li.chapitre'))
    const chapters: Chapter[] = []
    items.forEach((el, idx) => {
      const a =
        el.querySelector<HTMLAnchorElement>('div.chapitre_nom a[href*="lecture-en-ligne"]') ??
        el.querySelector<HTMLAnchorElement>('a[href*="lecture-en-ligne"]')
      if (!a) return
      const href = a.getAttribute('href') ?? ''
      const name = a.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      const numMatch = name.match(/([\d]+(?:[.,][\d]+)?)/)
      const number = numMatch ? parseFloat(numMatch[1].replace(',', '.')) : items.length - idx
      chapters.push({
        id: encId(toPath(href)),
        mangaId,
        number,
        title: name || `Chapitre ${number}`,
        scanlator: this.name,
        dateUpload: 0,
        isRead: false,
        lastPageRead: 0,
      })
    })
    return chapters.sort((a, b) => a.number - b.number)
  }

  async getPageList(chapterId: string): Promise<Page[]> {
    const chapterPath = decId(chapterId)
    const chapterUrl = `${BASE_URL}${chapterPath}`

    // Stratégie « capture » : plutôt que de rejouer l'appel signé `lel` (tokens
    // à usage unique, Referer/empreinte exacts → 500 hors navigateur), on REND
    // la page de lecture : le JS du site fait lui-même son appel `lel`, et le
    // hook injecté dans le WebView (LEL_HOOK_JS) en stocke la réponse chiffrée
    // dans `window.__lel[idc]`. On la lit puis on la décode nous-mêmes.
    await this.transport.fetchHtml(chapterUrl) // render → le lecteur appelle lel

    // Récupère la réponse lel capturée (peut arriver un peu après le rendu).
    let lelEntry: { idc: number; data: string } | null = null
    for (let i = 0; i < 40 && !lelEntry; i++) {
      const raw = await this.transport.evalJson('JSON.stringify(window.__lel||{})')
      let map: Record<string, string> = {}
      try {
        map = JSON.parse(JSON.parse(raw) as string) as Record<string, string>
      } catch {
        try {
          map = JSON.parse(raw) as Record<string, string>
        } catch {
          map = {}
        }
      }
      const entries = Object.entries(map).filter(([, v]) => typeof v === 'string' && v.length > 0)
      if (entries.length) {
        const [k, v] = entries[entries.length - 1]
        lelEntry = { idc: parseInt(k, 10), data: v }
      } else {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
    if (!lelEntry) {
      throw new Error(
        'Scan-Manga: réponse lel non capturée (le lecteur ne l’a pas appelée ou hook absent).',
      )
    }

    // Le CDN d'images (data2.scan-manga.com) refuse TOUT sauf le <img> du lecteur
    // (Cloudflare : reqwest 403/TLS, fetch CORS, nav top-level bloquée). MAIS le
    // lecteur déchiffre chaque page côté client et l'expose en blob: same-origin.
    // On décode donc lel UNIQUEMENT pour connaître le nombre de pages attendu,
    // puis on récolte les blobs produits par le lecteur (window.__blobs, rempli
    // par le hook createObjectURL) en le faisant défiler pour vaincre le lazy-load.
    const payload = await decodeLel(lelEntry.data, lelEntry.idc)
    const expected = Object.keys(payload.p).filter((k) => /^\d+$/.test(k)).length

    // Force le lecteur à décoder toutes les pages (fenêtre affichée + scroll côté
    // Rust : le lazy-load est gelé tant que la fenêtre est masquée) et renvoie le
    // nombre de blobs prêts.
    const ready = await this.transport.harvestBlobs(expected, 90000)
    const total = expected ? Math.min(ready, expected) : ready
    if (total === 0) {
      throw new Error('Scan-Manga: aucune page capturée (lecteur non chargé ou bloqué).')
    }

    // Lit chaque data-URI capturée (ordre de création = ordre des pages).
    const pages: Page[] = []
    for (let i = 0; i < total; i++) {
      const raw = await this.transport.evalJson(
        `JSON.stringify((window.__blobs&&window.__blobs[${i}])||'')`,
      )
      let dataUri = ''
      try {
        dataUri = JSON.parse(JSON.parse(raw) as string) as string
      } catch {
        try {
          dataUri = JSON.parse(raw) as string
        } catch {
          dataUri = ''
        }
      }
      if (dataUri.startsWith('data:')) {
        pages.push({ index: pages.length, imageUrl: dataUri })
      }
    }
    if (pages.length === 0) {
      throw new Error(`Scan-Manga: ${total} blobs capturés mais illisibles.`)
    }
    return pages
  }
}
