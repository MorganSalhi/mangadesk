import { MangaThemesiaSource } from './engines/mangathemesia'

// Sushi-Scan — moteur MangaThemesia (themePkg=mangathemesia).
// Cf. Keiyoushi src/fr/sushiscan : mangaUrlDirectory=/catalogue, infotable
// FR (Auteur/Statut), images via ts_reader.run({...}).
//
// Challenge Cloudflare Turnstile permanent (cf-mitigated: challenge, 403) sur
// tout le domaine → `cloudflare: 'always'` + `htmlVia: 'navigate'` (vraie
// navigation du WebView, le `fetch()` programmatique étant refusé). Même
// approche que Manga-Scantrad / Scan-Manga. Les images (couvertures + pages)
// passent par le repli WebView de `fetch_image_as_base64`.
export class SushiScanSource extends MangaThemesiaSource {
  constructor() {
    super({
      id: 'sushiscan',
      name: 'Sushi-Scan',
      baseUrl: 'https://sushiscan.net',
      lang: 'fr',
      isNsfw: true,
      mangaUrlDirectory: '/catalogue',
      authorLabel: 'Auteur',
      statusLabel: 'Statut',
      cloudflare: 'always',
      htmlVia: 'navigate',
    })
  }
}
