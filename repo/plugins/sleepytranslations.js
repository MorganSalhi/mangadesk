// Sleepy Translations v1.0.1 — plugin MangaDesk (généré par scripts/build-plugins.mjs, ne pas éditer)
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// plugins/sleepytranslations/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => SleepytranslationsSource
});
module.exports = __toCommonJS(index_exports);

// plugins/shims/tauri-core.ts
var invoke = (cmd, args) => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) {
    return Promise.reject(
      new Error("API Tauri globale absente \u2014 `app.withGlobalTauri` doit \xEAtre activ\xE9.")
    );
  }
  return tauri.core.invoke(cmd, args);
};

// src/sources/engines/scrape.ts
var DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
function createPageMicroCache(ttlMs = 2e4) {
  let entry = null;
  return {
    async fetch(url, fetcher) {
      if (entry && entry.url === url && Date.now() - entry.at < ttlMs) return entry.html;
      const html = await fetcher(url);
      entry = { url, html, at: Date.now() };
      return html;
    }
  };
}
function strList(v) {
  return Array.isArray(v) ? v : [];
}
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}
function inputLabel(doc, input) {
  const id = input.getAttribute("id");
  const label = id ? doc.querySelector(`label[for="${id}"]`) : null;
  return label?.textContent?.trim() || input.parentElement?.textContent?.trim() || input.getAttribute("value") || "";
}
function inputOptions(doc, name, opts = {}) {
  const seen = /* @__PURE__ */ new Set();
  const options = [];
  doc.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
    const value = input.getAttribute("value") ?? "";
    if (!value && !opts.keepEmptyValue) return;
    if (seen.has(value)) return;
    seen.add(value);
    options.push({ value, label: inputLabel(doc, input) || value || "Tous" });
  });
  return options;
}
function parseRelativeDate(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const direct = Date.parse(trimmed);
  if (!Number.isNaN(direct)) return direct;
  const rel = trimmed.toLowerCase().match(
    /(\d+)\s*(seconde?|second|minute|min|heure|hour|jour|day|semaine|week|mois|month|année|an|year)/
  );
  if (!rel) return 0;
  const n = parseInt(rel[1], 10);
  const unit = rel[2];
  const factor = unit.startsWith("second") || unit.startsWith("seconde") ? 1e3 : unit.startsWith("min") ? 6e4 : unit.startsWith("heure") || unit.startsWith("hour") ? 36e5 : unit.startsWith("jour") || unit.startsWith("day") ? 864e5 : unit.startsWith("semaine") || unit.startsWith("week") ? 7 * 864e5 : unit.startsWith("mois") || unit.startsWith("month") ? 30 * 864e5 : 365 * 864e5;
  return Date.now() - n * factor;
}
function parseScanStatus(text) {
  const t = text.toLowerCase();
  if (!t) return "unknown";
  if (t.includes("en cours") || t.includes("ongoing") || t.includes("publishing")) {
    return "ongoing";
  }
  if (t.includes("termin\xE9") || t.includes("completed") || t.includes("fini") || t.includes("finished")) {
    return "completed";
  }
  if (t.includes("hiatus") || t.includes("pause")) return "hiatus";
  if (t.includes("annul") || t.includes("cancelled") || t.includes("abandonn") || t.includes("dropped")) {
    return "cancelled";
  }
  return "unknown";
}

// src/sources/engines/cfTransport.ts
function isCloudflareChallenge(body) {
  if (/_cf_chl_opt|cf-turnstile-response|cf-chl-widget|__cf_chl|challenge-platform/i.test(body)) {
    return true;
  }
  if (body.length > 6e3) return false;
  return /just a moment|un instant|cf-mitigated|Attention Required|enable javascript and cookies/i.test(
    body
  );
}
function createTransport(sourceId, baseUrl, cloudflare = "auto", config = {}) {
  const label = `cf-${sourceId}`;
  const MODE_PREF = `cf_mode_${sourceId}`;
  const COOKIE_PREF = `cf_cookie_${sourceId}`;
  const UA_PREF = `cf_ua_${sourceId}`;
  const userAgentOverride = config.userAgent;
  const htmlVia = config.htmlVia ?? "fetch";
  const baseUA = userAgentOverride ?? DESKTOP_UA;
  let mode = cloudflare === "always" ? "webview" : "reqwest";
  let cookie = null;
  let userAgent = baseUA;
  let loaded = false;
  let solving = null;
  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const m = await invoke("get_preference", { key: MODE_PREF });
      if (m === "webview") mode = "webview";
      cookie = await invoke("get_preference", { key: COOKIE_PREF }) ?? null;
      const ua = await invoke("get_preference", { key: UA_PREF });
      if (ua && !userAgentOverride) userAgent = ua;
    } catch {
    }
  }
  async function persistMode() {
    try {
      await invoke("set_preference", { key: MODE_PREF, value: mode });
    } catch {
    }
  }
  async function solve(target) {
    if (solving) return solving;
    solving = (async () => {
      try {
        const res = await invoke("solve_cloudflare", {
          url: target,
          label,
          userAgent: userAgentOverride
        });
        cookie = res.cookie;
        userAgent = res.userAgent || DESKTOP_UA;
        try {
          await invoke("set_preference", { key: COOKIE_PREF, value: cookie });
          await invoke("set_preference", { key: UA_PREF, value: userAgent });
        } catch {
        }
        return true;
      } catch {
        return false;
      } finally {
        solving = null;
      }
    })();
    return solving;
  }
  async function fetchApi(url, opts = {}) {
    const res = await invoke("fetch_via_webview", {
      url,
      method: opts.method ?? "GET",
      body: opts.body ?? null,
      label,
      headers: opts.headers ?? null,
      referrer: opts.referrer ?? null
    });
    return { status: res.status, body: res.body };
  }
  async function evalJson(js) {
    return invoke("eval_webview", { label, js });
  }
  async function harvestBlobs(expected, timeoutMs = 6e4) {
    return invoke("harvest_blobs", { label, expected, timeoutMs });
  }
  async function viaWebview(url, opts) {
    const args = { url, method: opts.method ?? "GET", body: opts.body ?? null, label };
    const run = async () => {
      const res = await invoke("fetch_via_webview", args);
      if (res.status !== 200) throw new Error(`${sourceId} HTTP ${res.status} sur ${url}`);
      return res.body;
    };
    try {
      return await run();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("CF_NEEDS_SOLVE")) {
        const ok = await solve(url);
        if (!ok) {
          throw new Error(
            `CLOUDFLARE_BLOCKED: ${sourceId} requiert une v\xE9rification Cloudflare. Cliquez pour l'ouvrir, r\xE9solvez le challenge, puis r\xE9essayez.`
          );
        }
        return await run();
      }
      throw err;
    }
  }
  async function viaRender(url) {
    const run = async () => {
      const res = await invoke("render_via_webview", { url, label });
      return res.body;
    };
    const needsSolve = (b) => isCloudflareChallenge(b);
    try {
      const body = await run();
      if (!needsSolve(body)) return body;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("CF_NEEDS_SOLVE")) throw err;
    }
    if (!await solve(url)) {
      throw new Error(
        `CLOUDFLARE_BLOCKED: ${sourceId} requiert une v\xE9rification Cloudflare. Cliquez pour l'ouvrir, r\xE9solvez le challenge, puis r\xE9essayez.`
      );
    }
    return run();
  }
  function fetchHtmlWebview(url, opts) {
    if (htmlVia === "navigate" && (opts.method ?? "GET") === "GET") return viaRender(url);
    return viaWebview(url, opts);
  }
  async function viaReqwest(url, opts) {
    const headers = {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      Referer: opts.referer ?? baseUrl
    };
    if (opts.method === "POST") headers["X-Requested-With"] = "XMLHttpRequest";
    if (cookie) headers.Cookie = cookie;
    return invoke("fetch_url", {
      url,
      headers,
      method: opts.method ?? "GET",
      body: opts.body ?? null
    });
  }
  async function fetchHtml(url, opts = {}) {
    await load();
    if (mode === "webview") return fetchHtmlWebview(url, opts);
    const res = await viaReqwest(url, opts);
    const blocked = res.status === 403 || res.status === 503 || isCloudflareChallenge(res.body);
    if (blocked) {
      mode = "webview";
      void persistMode();
      return fetchHtmlWebview(url, opts);
    }
    if (res.status !== 200) throw new Error(`${sourceId} HTTP ${res.status} sur ${url}`);
    return res.body;
  }
  return {
    fetchHtml,
    fetchApi,
    evalJson,
    harvestBlobs,
    get cookie() {
      return cookie;
    },
    get userAgent() {
      return userAgent;
    }
  };
}

// src/sources/engines/randomCatalog.ts
async function probeMaxPage(countAt, opts = {}) {
  const cap = Math.max(1, opts.cap ?? 128);
  let lo = Math.max(1, opts.knownMax ?? 1);
  let hi = null;
  let probe = Math.max(2, lo * 2);
  for (let i = 0; i < 6 && probe <= cap; i++) {
    if (await countAt(probe) > 0) {
      lo = probe;
      probe *= 2;
    } else {
      hi = probe;
      break;
    }
  }
  if (hi == null) return lo;
  for (let i = 0; i < 2 && hi - lo > 1; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (await countAt(mid) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}
function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// src/sources/engines/madara.ts
function imgSrc(el) {
  if (!el) return "";
  const srcset = el.getAttribute("srcset") ?? el.getAttribute("data-srcset");
  return (el.getAttribute("data-src") ?? el.getAttribute("data-lazy-src") ?? (srcset ? srcset.split(",")[0]?.trim().split(" ")[0] : null) ?? el.getAttribute("src") ?? "").trim();
}
var MADARA_SORT_OPTIONS = [
  { value: "views", label: "Popularit\xE9 (vues)" },
  { value: "trending", label: "Tendance" },
  { value: "latest", label: "Derni\xE8res mises \xE0 jour" },
  { value: "new-manga", label: "Nouveaut\xE9s" },
  { value: "rating", label: "Note" },
  { value: "alphabet", label: "Titre (A\u2192Z)" },
  { value: "", label: "Pertinence (recherche)" }
];
var MADARA_STATUS_FALLBACK = [
  { value: "on-going", label: "En cours" },
  { value: "end", label: "Termin\xE9" },
  { value: "on-hold", label: "En pause" },
  { value: "canceled", label: "Annul\xE9" }
];
var MadaraSource = class {
  constructor(config) {
    __publicField(this, "id");
    __publicField(this, "name");
    __publicField(this, "lang");
    __publicField(this, "baseUrl");
    __publicField(this, "version");
    __publicField(this, "isNsfw");
    __publicField(this, "supportsLatest");
    __publicField(this, "filters");
    /** Promesse mémoïsée de chargement des filtres dynamiques (genres du site). */
    __publicField(this, "dynamicFiltersPromise", null);
    /** Nombre de pages du catalogue (cache session, pour getRandom). */
    __publicField(this, "catalogPageCount", null);
    /** Micro-cache de la fiche : getMangaDetails + getChapterList = même page. */
    __publicField(this, "fichePage", createPageMicroCache());
    __publicField(this, "cfg");
    __publicField(this, "transport");
    this.id = config.id;
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.lang = config.lang ?? "fr";
    this.version = config.version ?? "1.0.0";
    this.isNsfw = config.isNsfw ?? false;
    this.supportsLatest = config.supportsLatest ?? true;
    const archiveSub = config.archiveSub ?? "manga";
    this.cfg = {
      archiveSub,
      mangaSub: config.mangaSub ?? archiveSub,
      popularOrderby: config.popularOrderby ?? "views",
      latestOrderby: config.latestOrderby ?? "latest",
      useNewChapterEndpoint: config.useNewChapterEndpoint ?? false
    };
    this.transport = createTransport(this.id, this.baseUrl, config.cloudflare ?? "auto", {
      htmlVia: config.htmlVia,
      userAgent: config.userAgent
    });
    this.filters = this.staticFilterDefs();
  }
  archiveUrl(page, orderby) {
    const base = page === 1 ? `${this.baseUrl}/${this.cfg.archiveSub}/` : `${this.baseUrl}/${this.cfg.archiveSub}/page/${page}/`;
    return `${base}?m_orderby=${orderby}`;
  }
  // --- Filtres ---------------------------------------------------------------
  /** Définitions disponibles sans requête réseau (le tri seul). */
  staticFilterDefs() {
    return [
      {
        id: "sort",
        name: "Trier par",
        type: "select",
        default: this.cfg.popularOrderby,
        options: MADARA_SORT_OPTIONS
      }
    ];
  }
  /**
   * Complète les définitions depuis le formulaire de recherche avancée du site
   * (`/?s=&post_type=wp-manga`) : genres, statuts, contenu adulte, auteur…
   * Chaque site Madara a sa propre taxonomie de genres — d'où le parsing
   * dynamique plutôt qu'une liste codée en dur.
   */
  async getFilters() {
    this.dynamicFiltersPromise ?? (this.dynamicFiltersPromise = (async () => {
      const html = await this.transport.fetchHtml(
        `${this.baseUrl}/?s=&post_type=wp-manga`
      );
      const doc = new DOMParser().parseFromString(html, "text/html");
      const defs = [...this.staticFilterDefs()];
      const genres = inputOptions(doc, "genre[]");
      if (genres.length > 0) {
        defs.push({ id: "genres", name: "Genres", type: "multiselect", options: genres });
        defs.push({
          id: "genresAnd",
          name: "Cumuler les genres (ET)",
          type: "checkbox",
          default: false
        });
      }
      const statuses = inputOptions(doc, "status[]");
      defs.push({
        id: "status",
        name: "Statut",
        type: "multiselect",
        options: statuses.length > 0 ? statuses : MADARA_STATUS_FALLBACK
      });
      if (doc.querySelector('select[name="adult"]')) {
        defs.push({
          id: "adult",
          name: "Contenu adulte",
          type: "select",
          default: "",
          options: [
            { value: "", label: "Tout afficher" },
            { value: "0", label: "Masquer le contenu adulte" },
            { value: "1", label: "Contenu adulte uniquement" }
          ]
        });
      }
      const releases = inputOptions(doc, "release[]");
      if (releases.length > 0) {
        defs.push({
          id: "release",
          name: "Ann\xE9e de sortie",
          type: "multiselect",
          options: releases
        });
      }
      if (doc.querySelector('input[name="author"]')) {
        defs.push({ id: "author", name: "Auteur", type: "text", placeholder: "Nom d\u2019auteur" });
      }
      if (doc.querySelector('input[name="artist"]')) {
        defs.push({ id: "artist", name: "Artiste", type: "text", placeholder: "Nom d\u2019artiste" });
      }
      this.filters = defs;
      return defs;
    })());
    try {
      return await this.dynamicFiltersPromise;
    } catch (err) {
      this.dynamicFiltersPromise = null;
      throw err;
    }
  }
  async search(query, page, filters) {
    const q = query.trim();
    const genres = strList(filters.genres);
    const statuses = strList(filters.status);
    const releases = strList(filters.release);
    const adult = str(filters.adult);
    const author = str(filters.author);
    const artist = str(filters.artist);
    const sort = typeof filters.sort === "string" ? filters.sort : this.cfg.popularOrderby;
    const hasAdvanced = !!q || genres.length > 0 || statuses.length > 0 || releases.length > 0 || adult !== "" || !!author || !!artist;
    if (!hasAdvanced) {
      const html2 = await this.transport.fetchHtml(
        this.archiveUrl(page, sort || this.cfg.popularOrderby)
      );
      return this.parseMangaList(html2, page, false);
    }
    const params = new URLSearchParams();
    params.set("s", q);
    params.set("post_type", "wp-manga");
    if (sort) params.set("m_orderby", sort);
    for (const g of genres) params.append("genre[]", g);
    if (genres.length > 0 && filters.genresAnd === true) params.set("op", "1");
    for (const s of statuses) params.append("status[]", s);
    for (const r of releases) params.append("release[]", r);
    if (adult) params.set("adult", adult);
    if (author) params.set("author", author);
    if (artist) params.set("artist", artist);
    const base = page === 1 ? `${this.baseUrl}/` : `${this.baseUrl}/page/${page}/`;
    const html = await this.transport.fetchHtml(`${base}?${params.toString()}`);
    return this.parseMangaList(html, page, true);
  }
  /** URL de la recherche vide (mode search, paginable, avec compteur total). */
  emptySearchUrl(page) {
    const base = page === 1 ? `${this.baseUrl}/` : `${this.baseUrl}/page/${page}/`;
    return `${base}?s=&post_type=wp-manga`;
  }
  /**
   * Nombre de pages du catalogue. L'archive Madara ne lie que « page
   * suivante » (pas de dernier numéro) — mais la page de RECHERCHE vide
   * affiche le total (« 418 results » / « résultats ») : total ÷ taille de la
   * page 1 = nombre de pages. Repli : sonde exponentielle (cf. randomCatalog).
   */
  async resolveCatalogPageCount() {
    const html = await this.transport.fetchHtml(this.emptySearchUrl(1));
    const list = this.parseMangaList(html, 1, true);
    const perPage = list.mangas.length;
    if (perPage === 0) throw new Error(`${this.name}: catalogue vide ou inaccessible.`);
    if (this.catalogPageCount == null) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const headerText = doc.querySelector(".search-wrap h1, .c-blog__heading h1, h1.h4")?.textContent ?? "";
      const counter = headerText.match(/([\d][\d\s.,]*)\s*(?:results?|r[ée]sultats?)/i);
      if (counter) {
        const total = parseInt(counter[1].replace(/[\s.,]/g, ""), 10);
        if (Number.isFinite(total) && total > 0) {
          this.catalogPageCount = Math.max(1, Math.ceil(total / perPage));
        }
      }
      if (this.catalogPageCount == null) {
        this.catalogPageCount = await probeMaxPage(
          async (page) => this.parseMangaList(
            await this.transport.fetchHtml(this.emptySearchUrl(page)),
            page,
            true
          ).mangas.length,
          { knownMax: 1 }
        );
      }
    }
    return { pages: this.catalogPageCount, firstPage: list.mangas };
  }
  /**
   * Manga aléatoire : page aléatoire de la recherche vide (= catalogue
   * complet, pas seulement les têtes d'affiche), puis entrée aléatoire.
   */
  async getRandom() {
    const { pages, firstPage } = await this.resolveCatalogPageCount();
    const page = 1 + Math.floor(Math.random() * pages);
    if (page === 1) return pickRandom(firstPage);
    let list = this.parseMangaList(
      await this.transport.fetchHtml(this.emptySearchUrl(page)),
      page,
      true
    );
    if (list.mangas.length === 0) {
      this.catalogPageCount = null;
      list = { mangas: firstPage, hasNextPage: false, currentPage: 1 };
    }
    return pickRandom(list.mangas);
  }
  async getLatest(page) {
    const html = await this.transport.fetchHtml(this.archiveUrl(page, this.cfg.latestOrderby));
    return this.parseMangaList(html, page, false);
  }
  parseMangaList(html, page, isSearch) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const sub = this.cfg.mangaSub;
    const selector = isSearch ? "div.c-tabs-item__content, .manga__item" : "div.page-item-detail, .manga__item";
    const items = Array.from(doc.querySelectorAll(selector));
    const seen = /* @__PURE__ */ new Set();
    const mangas = [];
    for (const item of items) {
      const linkEl = item.querySelector(`a[href*="/${sub}/"]:not(.btn-link)`) ?? item.querySelector("div.post-title a") ?? item.querySelector(`a[href*="/${sub}/"]`);
      if (!linkEl) continue;
      const href = linkEl.getAttribute("href") ?? "";
      const slug = href.split(`/${sub}/`)[1]?.split("/")[0]?.split(/[?#]/)[0];
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const title = item.querySelector(".post-title")?.textContent?.trim() || (linkEl.textContent ?? "").trim() || slug;
      mangas.push({ id: slug, title, coverUrl: imgSrc(item.querySelector("img")), sourceId: this.id });
    }
    if (mangas.length === 0) {
      console.warn(
        `[${this.id}] 0 r\xE9sultat (search=${isSearch}) \u2014 html len=${html.length}, items(${selector})=${items.length}, ancres /${sub}/=` + doc.querySelectorAll(`a[href*="/${sub}/"]`).length
      );
    }
    const hasNextPage = mangas.length > 0 && !!doc.querySelector(".nav-previous, .next.page-numbers, a.nextpostslink");
    return { mangas, hasNextPage, currentPage: page };
  }
  async getMangaDetails(mangaId) {
    const html = await this.fichePage.fetch(
      `${this.baseUrl}/${this.cfg.mangaSub}/${mangaId}/`,
      (u) => this.transport.fetchHtml(u)
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const title = doc.querySelector("div.post-title h3, div.post-title h1, #manga-title > h1")?.textContent?.trim() ?? doc.querySelector("h1")?.textContent?.trim() ?? mangaId;
    const coverUrl = imgSrc(doc.querySelector("div.summary_image img"));
    const description = doc.querySelector("div.summary__content > p, div.summary__content, .description-summary")?.textContent?.trim() ?? "";
    const statusText = doc.querySelector(".post-status .summary-content, div.summary-content")?.textContent?.trim() ?? "";
    const author = doc.querySelector("div.author-content > a, .author-content")?.textContent?.trim() ?? "";
    const artist = doc.querySelector("div.artist-content > a, .artist-content")?.textContent?.trim() ?? author;
    const genres = Array.from(doc.querySelectorAll(".genres-content a")).map((el) => el.textContent?.trim() ?? "").filter(Boolean);
    return {
      id: mangaId,
      title,
      coverUrl,
      sourceId: this.id,
      description,
      author,
      artist,
      status: parseScanStatus(statusText),
      genres,
      inLibrary: false
    };
  }
  async getChapterList(mangaId) {
    const mangaUrl = `${this.baseUrl}/${this.cfg.mangaSub}/${mangaId}`;
    let doc;
    if (this.cfg.useNewChapterEndpoint) {
      const html = await this.transport.fetchHtml(`${mangaUrl}/ajax/chapters`, {
        method: "POST",
        body: "",
        referer: `${mangaUrl}/`
      });
      doc = new DOMParser().parseFromString(html, "text/html");
      if (doc.querySelectorAll("li.wp-manga-chapter").length === 0) {
        const page = await this.fichePage.fetch(
          `${mangaUrl}/`,
          (u) => this.transport.fetchHtml(u)
        );
        doc = new DOMParser().parseFromString(page, "text/html");
      }
    } else {
      const html = await this.fichePage.fetch(
        `${mangaUrl}/`,
        (u) => this.transport.fetchHtml(u)
      );
      doc = new DOMParser().parseFromString(html, "text/html");
    }
    const items = Array.from(doc.querySelectorAll("li.wp-manga-chapter"));
    const chapters = [];
    items.forEach((item, idx) => {
      const linkEl = item.querySelector("a");
      if (!linkEl) return;
      const href = linkEl.getAttribute("href") ?? "";
      const chapterSlug = href.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? `ch-${idx}`;
      const dateText = item.querySelector("span.chapter-release-date")?.textContent?.trim() ?? "";
      const numMatch = (linkEl.textContent ?? "").match(/([\d]+(?:[.,][\d]+)?)/);
      const number = numMatch ? parseFloat(numMatch[1].replace(",", ".")) : items.length - idx;
      chapters.push({
        id: `${mangaId}:${chapterSlug}`,
        mangaId,
        number,
        title: (linkEl.textContent ?? "").trim() || `Chapitre ${number}`,
        scanlator: "",
        dateUpload: parseRelativeDate(dateText),
        isRead: false,
        lastPageRead: 0
      });
    });
    return chapters.sort((a, b) => a.number - b.number);
  }
  async getPageList(chapterId) {
    const sep = chapterId.indexOf(":");
    const mangaSlug = sep >= 0 ? chapterId.slice(0, sep) : "";
    const chapterSlug = sep >= 0 ? chapterId.slice(sep + 1) : chapterId;
    const url = `${this.baseUrl}/${this.cfg.mangaSub}/${mangaSlug}/${chapterSlug}/`;
    const html = await this.transport.fetchHtml(url);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const imgs = doc.querySelectorAll(
      "div.page-break img, li.blocks-gallery-item img, .reading-content img"
    );
    const pages = [];
    imgs.forEach((img, index) => {
      const cleaned = imgSrc(img);
      if (cleaned && !cleaned.endsWith(".svg")) {
        const headers = {
          Referer: url,
          "User-Agent": this.transport.cookie ? this.transport.userAgent : DESKTOP_UA
        };
        if (this.transport.cookie) headers.Cookie = this.transport.cookie;
        pages.push({ index, imageUrl: cleaned, headers });
      }
    });
    return pages;
  }
};

// plugins/sleepytranslations/plugin.json
var plugin_default = {
  id: "sleepytranslations",
  name: "Sleepy Translations",
  lang: "en",
  baseUrl: "https://sleepytranslations.com",
  version: "1.0.1",
  nsfw: false
};

// plugins/sleepytranslations/index.ts
var SleepytranslationsSource = class extends MadaraSource {
  constructor() {
    super({
      id: plugin_default.id,
      name: plugin_default.name,
      baseUrl: plugin_default.baseUrl,
      lang: plugin_default.lang,
      isNsfw: plugin_default.nsfw,
      version: plugin_default.version
    });
  }
};
