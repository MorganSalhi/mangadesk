import { MangaThemesiaSource } from './engines/mangathemesia'

// ============================================================================
// Source LelManga (https://www.lelmanga.com) — thème MangaThemesia.
//
// Session 13 : la classe historique (scraping custom avec sélecteurs Madara en
// repli) a été remplacée par une sous-classe du moteur MangaThemesia partagé :
// le site est un Themesia standard (listing `.listupd .bsx`, fiche
// `entry-title`/`imptdt`, chapitres `#chapterlist .eplister` avec `data-num`,
// pages via `ts_reader.run` avec repli `#readerarea img`). Filtres dynamiques
// (genres/statut/type/tri) et manga aléatoire hérités du moteur.
//
// Libellés d'infos de fiche en ANGLAIS sur ce site (Status/Author), gérés par
// les candidats multiples de `seriesInfoValue`. Pas de Cloudflare bloquant :
// transport en mode 'auto' (reqwest direct, bascule WebView si besoin).
// ============================================================================

export class LelMangaSource extends MangaThemesiaSource {
  constructor() {
    super({
      id: 'lelmanga',
      name: 'LelManga',
      baseUrl: 'https://www.lelmanga.com',
      lang: 'fr',
      isNsfw: false,
      authorLabel: 'Author',
      statusLabel: 'Status',
    })
  }
}
