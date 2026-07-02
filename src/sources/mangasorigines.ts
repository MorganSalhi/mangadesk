import { MadaraSource } from './engines/madara'

// ============================================================================
// Source Mangas Origines (https://mangas-origines.fr) — moteur WordPress/Madara.
//
// Spécificités (calquées sur l'extension Keiyoushi/Tachiyomi
// `eu.kanade.tachiyomi.extension.fr.mangasoriginesfr`, themePkg=madara) :
//   - archive/listing sous `/catalogues/`, permaliens fiche+chapitres sous
//     `/oeuvre/{slug}/` (archiveSub ≠ mangaSub)
//   - tri populaire : m_orderby=views ; récents : m_orderby=latest
//   - useNewChapterEndpoint : chapitres via POST {mangaUrl}/ajax/chapters
//
// Cloudflare : le site vérifie l'empreinte TLS, donc `reqwest` est rejeté (403)
// même avec le cookie cf_clearance → `cloudflare: 'always'` : tout le HTML
// passe par le WebView (fetch_via_webview, vrai Chrome) via cfTransport, qui
// gère aussi le solveur (`CF_NEEDS_SOLVE` → solve_cloudflare). Cf. SESSION7.
//
// Session 13 : la classe historique autonome (transport maison dupliqué) a été
// remplacée par cette sous-classe du moteur Madara partagé — mêmes sélecteurs,
// même flux Cloudflare, et en prime filtres dynamiques + manga aléatoire.
// Effet de bord accepté : la clearance persiste désormais sous les clés
// `cf_*_mangasorigines` (celles du transport partagé) — au premier lancement,
// le solveur peut se rouvrir une fois.
// ============================================================================

export class MangasOriginesSource extends MadaraSource {
  constructor() {
    super({
      id: 'mangasorigines',
      name: 'Mangas Origines',
      baseUrl: 'https://mangas-origines.fr',
      lang: 'fr',
      isNsfw: false,
      archiveSub: 'catalogues',
      mangaSub: 'oeuvre',
      useNewChapterEndpoint: true,
      cloudflare: 'always',
    })
  }
}
