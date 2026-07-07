# Dépôt de sources MangaDesk

Équivalent MangaDesk du `index.min.json` de Keiyoushi, **avec le même procédé
que Tachiyomi** : chaque source est un artefact de code téléchargeable. Chez
Tachiyomi c'est un APK (Kotlin compilé + lib multisrc embarquée) ; ici c'est un
bundle JavaScript autonome (`repo/plugins/<id>.js`, moteur + transport inclus),
chargé par l'app via le mécanisme de plugins (session 5B/14).

L'app consomme le dépôt depuis **Réglages → Sources → Dépôts** : coller l'URL
de l'index, parcourir, installer en un clic, mettre à jour quand la version de
l'index dépasse celle installée.

## Hébergement

⚠️ `MorganSalhi/mangadesk-dev` est **privé** : l'URL raw GitHub renvoie 404
pour l'app (téléchargement non authentifié). Deux options :

- **Repo public** (ou dépôt séparé public ne contenant que `repo/`) → l'URL
  à coller devient :
  `https://raw.githubusercontent.com/MorganSalhi/mangadesk-dev/main/repo/index.json`
- **Rester privé** → servir le dépôt en local depuis le clone :
  `node scripts/serve-repo.mjs` → `http://127.0.0.1:8000/index.json`
  (127.0.0.1, pas localhost).

Les `url` des plugins sont **relatives à l'index** (comme les APK Keiyoushi) :
le dépôt fonctionne depuis n'importe quel hébergement sans réécrire l'index.
Test local : `python -m http.server -d repo` → `http://localhost:8000/index.json`.

## Développer une source (procédé Keiyoushi)

1. Créer `plugins/<id>/plugin.json` (métadonnées) et `plugins/<id>/index.ts`
   (la classe). Pour un site Madara/MangaThemesia, c'est ~15 lignes :

   ```ts
   import { MadaraSource } from '../../src/sources/engines/madara'
   import meta from './plugin.json'

   export default class MonSiteSource extends MadaraSource {
     constructor() {
       super({
         id: meta.id, name: meta.name, baseUrl: meta.baseUrl,
         lang: meta.lang, isNsfw: meta.nsfw, version: meta.version,
         useNewChapterEndpoint: true, // …surcharges du moteur
       })
     }
   }
   ```

   Une source entièrement custom implémente l'interface `Source` directement
   (elle peut importer `createTransport` et les helpers de `scrape.ts`).

2. `pnpm build:plugins` — bundle chaque plugin en CJS autonome dans
   `repo/plugins/` et régénère `repo/index.json`.

3. Publier une mise à jour = bumper `version` dans `plugin.json`, rebuilder,
   pousser. L'app propose « Mettre à jour » quand la version de l'index dépasse
   celle installée. (Comme chez Keiyoushi, le moteur est dupliqué dans chaque
   bundle : un fix moteur ⇒ rebuild de tous les plugins — le script le fait.)

### Contrat runtime d'un plugin

- Évalué via `new Function('exports', 'module', code)` : la classe doit
  atterrir sur `module.exports.default` (esbuild CJS) ou `exports.default`.
- Pas d'imports à l'exécution : l'API Tauri passe par `window.__TAURI__`
  (`withGlobalTauri` activé), aliasé au build sur `plugins/shims/tauri-core.ts`.
- `DOMParser` et les autres API navigateur sont disponibles (le plugin tourne
  dans la WebView de l'app).

## Format de l'index (`mangadesk-repo/1`)

```jsonc
{
  "format": "mangadesk-repo/1",
  "name": "Nom du dépôt",
  "sources": [
    {
      "id": "monsite",            // unique, [a-z0-9_-] ; = nom du dossier plugin
      "name": "Mon Site",
      "lang": "fr",
      "baseUrl": "https://monsite.fr",
      "version": "1.0.0",
      "nsfw": false,
      "engine": "js",
      "url": "plugins/monsite.js" // relative à l'index (ou absolue)
    }
  ]
}
```

Deux moteurs « config pure » restent acceptés par l'app (`engine: "madara"` /
`"mangathemesia"` + champ `config`) : aucune ligne de code téléchargée, l'app
instancie son moteur intégré avec la config. Utile pour un dépôt minimaliste,
mais le procédé principal est `js`.

## Couverture Keiyoushi (juillet 2026)

**94 sources dans l'index : 7 FR + 87 EN** (Madara et MangaThemesia).

- FR (7) : Harmony-Scan, MangaHub.fr, Toon FR, Kiwiya Scans, Mangas Scans,
  Sushiscan.fr, YaoiScan. Les 6 autres sources FR Madara/Themesia de Keiyoushi
  sont déjà intégrées à l'app (Mangas Origines, LelManga, Pantheon Scan,
  Manga-Scantrad, Sushi-Scan, + Scan-Manga maison).
- EN (87) : générées par `scripts/scaffold-from-keiyoushi.mjs` (voir ci-après).
  `yaoiscan-en` est suffixé (collision d'id avec le plugin FR homonyme).
- **Exclusion éditoriale** : les sources au nom explicite (hentai, porn, milf…
  — `EXPLICIT_NAME_RE` du scaffoldeur, testé sur id + nom + baseUrl + module
  Keiyoushi) ne sont PAS dans le dépôt, indépendamment du flag `nsfw` qui
  reste géré par le réglage « Afficher les sources 18+ ». 12 retirées
  (dont X-Manga, module Keiyoushi `scanhentaimenu`).

### Régénérer / importer depuis Keiyoushi

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/keiyoushi/extensions-source
git -C extensions-source sparse-checkout set src/en src/fr        # + core.longpaths true sous Windows
node scripts/scaffold-from-keiyoushi.mjs ./extensions-source en
pnpm build:plugins
```

Le scaffoldeur ne prend que les modules Madara/MangaThemesia SANS logique
custom (`override fun`, factories multi-sources, baseUrl dynamique → écartés :
mieux vaut une source absente qu'une source cassée). Sur les 422 modules EN :
92 retenus, 68 écartés pour logique custom, 261 sur des thèmes non portés.
Un dossier `plugins/<id>` existant n'est jamais réécrit.

### Contenu 18+

Le champ `nsfw` de `plugin.json` reprend le `contentWarning` du gradle
Keiyoushi (tout sauf `SAFE` → `nsfw: true`, y compris `MIXED`). L'app expose
« Afficher les sources 18+ » (Réglages → Sources) : désactivé, les sources
NSFW disparaissent du sélecteur Parcourir et des dépôts (y compris « Tout
installer ») — même principe que Tachiyomi.

Non couvertes (moteur absent) :

| Moteur Keiyoushi | Sources FR concernées |
|---|---|
| `HttpSource` custom (code spécifique par site) | Anime-Sama, AralosBD, AstralManga, BigSolo, ChaosTrad, DassouScan, FuryoSquad, HanaBook, Japscan, LanorTrad, Lelscan, Les Poroïniens, MangaKawaii, MangaMoins, MangaNova, Ono, Ortega Scans, Perf Scan, Phenix Scans, Poseidon Scans, Raijin Scans, Rimu Scans, ScansFR, ScanR, Scantrad Union, Twatt |
| `PizzaReader` | BlueSolo, FMTEAM, Manga Corporation |
| `Pam` | Epsilon Scan, Soft Epsilon Scan |
| `ScanReaderTheme` | Hentai Scan Reader, ScanReader |
| `FuzzyDoodle` | LelscanVF |
| `MMRCMS` | ScanVF |
| `Keyoapp` | Siren Scans FR |

Grâce au procédé plugin, ces moteurs peuvent désormais être portés **sans
toucher à l'app** : écrire le moteur en TS dans un plugin (ou un module partagé
importé par plusieurs plugins), builder, pousser. Prochain plus rentable :
`PizzaReader` (simple API JSON, 3 sources).
