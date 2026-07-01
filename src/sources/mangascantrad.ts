import { MadaraSource } from './engines/madara'

// Manga-Scantrad — Madara (themePkg=madara, useNewChapterEndpoint=true).
// Cf. Keiyoushi src/fr/mangascantrad. Base /manga/ par défaut.
//
// Le site est passé en challenge Cloudflare Turnstile permanent sur tout le
// domaine (cf-mitigated: challenge, 403 même pour reqwest). Le `fetch()`
// programmatique dans le WebView est aussi refusé (403) ; seule une vraie
// navigation passe le challenge → `htmlVia: 'navigate'` + `cloudflare: 'always'`
// (on saute la tentative reqwest vouée à l'échec). Même approche que Scan-Manga.
export class MangaScantradSource extends MadaraSource {
  constructor() {
    super({
      id: 'mangascantrad',
      name: 'Manga-Scantrad',
      baseUrl: 'https://manga-scantrad.io',
      lang: 'fr',
      isNsfw: true,
      useNewChapterEndpoint: true,
      cloudflare: 'always',
      htmlVia: 'navigate',
    })
  }
}
