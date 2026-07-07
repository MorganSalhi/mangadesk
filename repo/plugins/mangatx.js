// MangaTX v1.0.1 — plugin MangaDesk (généré par scripts/build-plugins.mjs, ne pas éditer)
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

// plugins/mangatx/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => MangatxSource
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

// src/sources/engines/mangathemesia.ts
function imgAttr(el) {
  if (!el) return "";
  const srcset = el.getAttribute("srcset") ?? el.getAttribute("data-srcset");
  return (el.getAttribute("data-lazy-src") ?? el.getAttribute("data-src") ?? (srcset ? srcset.split(",").pop()?.trim().split(" ")[0] : null) ?? el.getAttribute("src") ?? "").trim();
}
function seriesInfoValue(doc, labels) {
  const needles = labels.map((l) => l.toLowerCase());
  const matches = (text) => {
    const t = text.toLowerCase();
    return needles.some((n) => t.includes(n));
  };
  for (const tr of Array.from(doc.querySelectorAll(".infotable tr"))) {
    if (matches(tr.textContent ?? "")) {
      const cells = tr.querySelectorAll("td");
      const last = cells[cells.length - 1];
      if (last) return last.textContent?.trim() ?? "";
    }
  }
  for (const el of Array.from(doc.querySelectorAll(".imptdt"))) {
    if (matches(el.textContent ?? "")) {
      const value = el.querySelector("i, a")?.textContent?.trim();
      if (value) return value;
    }
  }
  for (const el of Array.from(doc.querySelectorAll(".fmed"))) {
    if (matches(el.querySelector("b")?.textContent ?? "")) {
      const value = el.querySelector("span")?.textContent?.trim();
      if (value) return value;
    }
  }
  return "";
}
function lastSegment(href) {
  return href.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
}
var THEMESIA_SORT_OPTIONS = [
  { value: "popular", label: "Popularit\xE9" },
  { value: "update", label: "Derni\xE8res mises \xE0 jour" },
  { value: "latest", label: "Ajout le plus r\xE9cent" },
  { value: "title", label: "Titre (A\u2192Z)" },
  { value: "titlereverse", label: "Titre (Z\u2192A)" }
];
var MangaThemesiaSource = class {
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
    __publicField(this, "dir");
    __publicField(this, "authorLabel");
    __publicField(this, "statusLabel");
    __publicField(this, "transport");
    this.id = config.id;
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.lang = config.lang ?? "fr";
    this.version = config.version ?? "1.0.0";
    this.isNsfw = config.isNsfw ?? false;
    this.supportsLatest = config.supportsLatest ?? true;
    this.dir = config.mangaUrlDirectory ?? "/manga";
    this.authorLabel = config.authorLabel ?? "Auteur";
    this.statusLabel = config.statusLabel ?? "Statut";
    this.transport = createTransport(this.id, this.baseUrl, config.cloudflare ?? "auto", {
      htmlVia: config.htmlVia,
      userAgent: config.userAgent
    });
    this.filters = this.staticFilterDefs();
  }
  // --- Filtres ---------------------------------------------------------------
  /** Définitions disponibles sans requête réseau (le tri seul). */
  staticFilterDefs() {
    return [
      {
        id: "sort",
        name: "Trier par",
        type: "select",
        default: "popular",
        options: THEMESIA_SORT_OPTIONS
      }
    ];
  }
  /**
   * Complète les définitions depuis le formulaire de filtres de l'archive
   * (`{dir}/`) : genres (`genre[]`, ids propres au site), statut, type.
   * ⚠️ Limitation MangaThemesia : ces filtres ne s'appliquent qu'au listing,
   * pas à la recherche textuelle (`?s=`) — géré dans `search()`.
   */
  async getFilters() {
    this.dynamicFiltersPromise ?? (this.dynamicFiltersPromise = (async () => {
      const html = await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/`);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const defs = [];
      const orders = inputOptions(doc, "order", { keepEmptyValue: true });
      defs.push({
        id: "sort",
        name: "Trier par",
        type: "select",
        default: "popular",
        options: orders.length > 1 ? orders : THEMESIA_SORT_OPTIONS
      });
      const genres = inputOptions(doc, "genre[]");
      if (genres.length > 0) {
        defs.push({ id: "genres", name: "Genres", type: "multiselect", options: genres });
      }
      const statuses = inputOptions(doc, "status", { keepEmptyValue: true });
      if (statuses.length > 1) {
        defs.push({
          id: "status",
          name: "Statut",
          type: "select",
          default: "",
          options: statuses
        });
      }
      const types = inputOptions(doc, "type", { keepEmptyValue: true });
      if (types.length > 1) {
        defs.push({ id: "type", name: "Type", type: "select", default: "", options: types });
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
    if (q) {
      const html2 = await this.transport.fetchHtml(
        `${this.baseUrl}/page/${page}?s=${encodeURIComponent(q)}`
      );
      return this.parseMangaList(html2, page);
    }
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("order", str(filters.sort) || "popular");
    const status = str(filters.status);
    if (status) params.set("status", status);
    const type = str(filters.type);
    if (type) params.set("type", type);
    let url = `${this.baseUrl}${this.dir}/?${params.toString()}`;
    for (const g of strList(filters.genres)) {
      url += `&genre%5B%5D=${encodeURIComponent(g)}`;
    }
    const html = await this.transport.fetchHtml(url);
    return this.parseMangaList(html, page);
  }
  /**
   * Manga aléatoire : page aléatoire du catalogue, puis entrée aléatoire.
   * Le nombre de pages vient de la pagination (Themesia lie la dernière page,
   * ex. « 1 2 … 8 ») ; si elle n'expose pas de numéros mais qu'une page
   * suivante existe, on sonde (cf. randomCatalog) pour couvrir TOUT le
   * catalogue et pas seulement les têtes d'affiche.
   */
  async getRandom() {
    if (this.catalogPageCount == null) {
      const html = await this.transport.fetchHtml(
        `${this.baseUrl}${this.dir}/?page=1&order=popular`
      );
      const doc = new DOMParser().parseFromString(html, "text/html");
      let max = 1;
      doc.querySelectorAll(".pagination a.page-numbers, .pagination a, .hpage a").forEach((a) => {
        const n = parseInt((a.textContent ?? "").replace(/[^\d]/g, ""), 10);
        if (Number.isFinite(n) && n > max) max = n;
      });
      const hasNext = !!doc.querySelector(".pagination .next, .hpage .r");
      if (max === 1 && hasNext) {
        max = await probeMaxPage(
          async (page2) => this.parseMangaList(
            await this.transport.fetchHtml(
              `${this.baseUrl}${this.dir}/?page=${page2}&order=popular`
            ),
            page2
          ).mangas.length,
          { knownMax: 1 }
        );
      }
      this.catalogPageCount = max;
    }
    const total = Math.max(1, this.catalogPageCount);
    const page = 1 + Math.floor(Math.random() * total);
    let list = this.parseMangaList(
      await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/?page=${page}&order=popular`),
      page
    );
    if (list.mangas.length === 0 && page !== 1) {
      this.catalogPageCount = null;
      list = this.parseMangaList(
        await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/?page=1&order=popular`),
        1
      );
    }
    if (list.mangas.length === 0) {
      throw new Error(`${this.name}: catalogue vide ou inaccessible.`);
    }
    return list.mangas[Math.floor(Math.random() * list.mangas.length)];
  }
  async getLatest(page) {
    const html = await this.transport.fetchHtml(`${this.baseUrl}${this.dir}/?page=${page}&order=update`);
    return this.parseMangaList(html, page);
  }
  parseMangaList(html, page) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items = Array.from(
      doc.querySelectorAll(".utao .uta .imgu, .listupd .bs .bsx, .listo .bs .bsx")
    );
    const seen = /* @__PURE__ */ new Set();
    const mangas = [];
    for (const item of items) {
      const a = item.querySelector("a");
      if (!a) continue;
      const href = a.getAttribute("href") ?? "";
      const slug = href.split(`${this.dir}/`)[1]?.split("/")[0]?.split(/[?#]/)[0] ?? lastSegment(href);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      mangas.push({
        id: slug,
        title: a.getAttribute("title")?.trim() || a.textContent?.trim() || slug,
        coverUrl: imgAttr(item.querySelector("img")),
        sourceId: this.id
      });
    }
    if (mangas.length === 0) {
      console.warn(
        `[${this.id}] 0 r\xE9sultat \u2014 html len=${html.length}, items=${items.length}, ancres ${this.dir}/=` + doc.querySelectorAll(`a[href*="${this.dir}/"]`).length
      );
    }
    const hasNextPage = mangas.length > 0 && !!doc.querySelector("div.pagination .next, div.hpage .r");
    return { mangas, hasNextPage, currentPage: page };
  }
  async getMangaDetails(mangaId) {
    const html = await this.fichePage.fetch(
      `${this.baseUrl}${this.dir}/${mangaId}/`,
      (u) => this.transport.fetchHtml(u)
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const title = doc.querySelector("h1.entry-title, .ts-breadcrumb li:last-child span")?.textContent?.trim() ?? doc.querySelector("h1")?.textContent?.trim() ?? mangaId;
    const coverUrl = imgAttr(
      doc.querySelector(".infomanga > div[itemprop=image] img, .thumb img, .ime img")
    );
    const description = Array.from(
      doc.querySelectorAll(".desc, .entry-content[itemprop=description]")
    ).map((el) => el.textContent?.trim() ?? "").join("\n").trim();
    const genres = Array.from(doc.querySelectorAll("div.gnr a, .mgen a, .seriestugenre a")).map((el) => el.textContent?.trim() ?? "").filter(Boolean);
    const author = seriesInfoValue(doc, [this.authorLabel, "Author", "Auteur"]);
    const statusText = seriesInfoValue(doc, [this.statusLabel, "Status", "Statut"]);
    return {
      id: mangaId,
      title,
      coverUrl,
      sourceId: this.id,
      description,
      author,
      artist: author,
      status: parseScanStatus(statusText),
      genres,
      inLibrary: false
    };
  }
  async getChapterList(mangaId) {
    const html = await this.fichePage.fetch(
      `${this.baseUrl}${this.dir}/${mangaId}/`,
      (u) => this.transport.fetchHtml(u)
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const items = Array.from(doc.querySelectorAll("#chapterlist li, div.bxcl li, div.cl li"));
    const chapters = [];
    items.forEach((item, idx) => {
      const a = item.querySelector("a");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      const chapterSlug = lastSegment(href) || `ch-${idx}`;
      const name = item.querySelector(".lch a, .chapternum")?.textContent?.trim() || a.textContent?.trim() || "";
      const dateText = item.querySelector(".chapterdate")?.textContent?.trim() ?? "";
      const dataNum = item.getAttribute("data-num") ?? "";
      const numMatch = dataNum.match(/([\d]+(?:[.,][\d]+)?)/) ?? (name || chapterSlug).match(/([\d]+(?:[.,][\d]+)?)/);
      const number = numMatch ? parseFloat(numMatch[1].replace(",", ".")) : items.length - idx;
      chapters.push({
        id: `${mangaId}:${chapterSlug}`,
        mangaId,
        number,
        title: name || `Chapitre ${number}`,
        scanlator: "",
        dateUpload: dateText ? Date.parse(dateText) || 0 : 0,
        isRead: false,
        lastPageRead: 0
      });
    });
    return chapters.sort((a, b) => a.number - b.number);
  }
  async getPageList(chapterId) {
    const sep = chapterId.indexOf(":");
    const chapterSlug = sep >= 0 ? chapterId.slice(sep + 1) : chapterId;
    const url = `${this.baseUrl}/${chapterSlug}/`;
    const html = await this.transport.fetchHtml(url);
    const headers = {
      Referer: url,
      "User-Agent": this.transport.cookie ? this.transport.userAgent : DESKTOP_UA
    };
    if (this.transport.cookie) headers.Cookie = this.transport.cookie;
    const m = html.match(/ts_reader\.run\((\{[\s\S]*?\})\);/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const images = data.sources?.[0]?.images ?? [];
        if (images.length > 0) {
          return images.map((imageUrl, index) => ({
            index,
            imageUrl: imageUrl.replace(/^http:\/\//, "https://"),
            headers
          }));
        }
      } catch {
      }
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const pages = [];
    doc.querySelectorAll("div#readerarea img").forEach((img, index) => {
      const src = imgAttr(img);
      if (src && !src.endsWith(".svg")) pages.push({ index, imageUrl: src, headers });
    });
    return pages;
  }
};

// plugins/mangatx/plugin.json
var plugin_default = {
  id: "mangatx",
  name: "MangaTX",
  lang: "en",
  baseUrl: "https://mangatx.cc",
  version: "1.0.1",
  nsfw: true
};

// plugins/mangatx/index.ts
var MangatxSource = class extends MangaThemesiaSource {
  constructor() {
    super({
      id: plugin_default.id,
      name: plugin_default.name,
      baseUrl: plugin_default.baseUrl,
      lang: plugin_default.lang,
      isNsfw: plugin_default.nsfw,
      version: plugin_default.version,
      mangaUrlDirectory: "/manga-list"
    });
  }
};
