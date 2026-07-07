use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// User-Agent imposé au WebView du solveur Cloudflare ET rejoué tel quel par
/// `reqwest` dans les requêtes de la source concernée. Les deux DOIVENT être
/// identiques : Cloudflare lie le cookie `cf_clearance` au couple
/// (User-Agent, IP). Si l'UA diffère, le cookie est immédiatement invalidé.
pub const CF_BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Label de la fenêtre solveur. Unique : on ferme l'ancienne avant d'en rouvrir.
const CF_SOLVER_LABEL: &str = "cf-solver";

/// Script d'init injecté dans la fenêtre solveur AVANT les scripts de chaque
/// page. Il intercepte les réponses de l'API `lel` de Scan-Manga (fetch + XHR)
/// faites par le JS du site lui-même et les stocke dans `window.__lel[idc]`.
/// On peut ainsi laisser le lecteur faire son appel signé (tokens à usage
/// unique, Referer/headers exacts) et récupérer la réponse chiffrée à décoder
/// côté source — au lieu de rejouer l'appel (qui échouait en 500).
const LEL_HOOK_JS: &str = r#"(function(){
  if (window.__lelHooked) return;
  window.__lelHooked = true;
  window.__lel = window.__lel || {};
  // Capture des images du lecteur : le site déchiffre chaque page côté client et
  // crée un blob: same-origin. On intercepte URL.createObjectURL pour lire ces
  // blobs (data-URI) dans l'ordre de création → window.__blobs. C'est la seule
  // façon de récupérer les pages (le CDN data2 refuse tout sauf le <img> du site).
  window.__blobs = window.__blobs || [];
  try {
    var oc = URL.createObjectURL;
    if (oc && !URL.__blobHooked) {
      URL.__blobHooked = true;
      URL.createObjectURL = function(obj){
        var u = oc.apply(this, arguments);
        try {
          if (obj instanceof Blob && obj.type && obj.type.indexOf('image') === 0) {
            var idx = window.__blobs.length;
            window.__blobs.push(null); // réserve la place (ordre de création)
            var fr = new FileReader();
            fr.onloadend = function(){ window.__blobs[idx] = String(fr.result); };
            fr.readAsDataURL(obj);
          }
        } catch(e){}
        return u;
      };
    }
  } catch(e){}
  // Shim IntersectionObserver : le lecteur charge ses pages en lazy via IO, qui
  // ne se déclenche que si la fenêtre est rendue (masquée → gelé). On le remplace
  // par un shim qui signale immédiatement « tout est visible » → le lecteur
  // décode TOUTES les pages d'emblée, fenêtre masquée, sans scroll ni popup.
  try {
    var RealIO = window.IntersectionObserver;
    if (RealIO && !window.__ioShimmed) {
      window.__ioShimmed = true;
      window.IntersectionObserver = function(cb){
        var obs = {
          observe: function(el){
            setTimeout(function(){
              try {
                var r = (el && el.getBoundingClientRect) ? el.getBoundingClientRect() : {};
                cb([{ isIntersecting: true, intersectionRatio: 1, target: el,
                      boundingClientRect: r, intersectionRect: r, rootBounds: null,
                      time: Date.now() }], obs);
              } catch(e){}
            }, 0);
          },
          unobserve: function(){},
          disconnect: function(){},
          takeRecords: function(){ return []; },
        };
        return obs;
      };
    }
  } catch(e){}
  function rec(url, text){
    try { var m = String(url).match(/\/lel\/(\d+)\.json/); if (m) { window.__lel[m[1]] = text; window.__lelLast = text; } } catch(e){}
  }
  // Capture réseau « gâchette » : quand window.__netCapture est vrai (posé par la
  // source juste avant de piloter le champ de recherche du site), on enregistre
  // les requêtes JSON/texte dans window.__net. Sert à découvrir et lire la vraie
  // requête de recherche du site sans en deviner l'endpoint ni les paramètres.
  window.__net = window.__net || [];
  function recNet(url, method, status, text){
    try {
      if (!window.__netCapture) return;
      var t = String(text || '');
      if (t.length > 60000) return; // ignore les gros binaires
      window.__net.push({ url: String(url), method: method || 'GET', status: status || 0, text: t.slice(0, 40000) });
      if (window.__net.length > 40) window.__net.shift();
    } catch(e){}
  }
  var of = window.fetch;
  if (of) {
    window.fetch = function(input){
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var pr = of.apply(this, arguments);
      try {
        if (/\/lel\/\d+\.json/.test(url)) {
          return pr.then(function(r){ try { r.clone().text().then(function(t){ rec(url, t); }); } catch(e){} return r; });
        }
        if (window.__netCapture) {
          pr.then(function(r){ try { r.clone().text().then(function(t){ recNet(url, 'GET', r.status, t); }); } catch(e){} });
        }
      } catch(e){}
      return pr;
    };
  }
  try {
    var oOpen = XMLHttpRequest.prototype.open;
    var oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u){ this.__lelUrl = u; this.__lelMethod = m; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(){
      var self = this;
      this.addEventListener('load', function(){
        try { if (/\/lel\/\d+\.json/.test(self.__lelUrl || '')) rec(self.__lelUrl, self.responseText); } catch(e){}
        try { if (window.__netCapture) recNet(self.__lelUrl, self.__lelMethod, self.status, self.responseText); } catch(e){}
      });
      return oSend.apply(this, arguments);
    };
  } catch(e){}
})();"#;

/// User-Agent par défaut quand l'appelant ne précise pas le sien.
/// Pour les sources qui scrapent un site grand public, le passer en
/// `headers["User-Agent"]` côté JS (Mozilla/…) — ce header remplace alors le
/// défaut (cf. boucle dans `fetch_url`).
pub const APP_USER_AGENT: &str = "MangaDesk/0.1.0 (+https://github.com/mangadesk)";

/// Singleton reqwest. `reqwest::Client` est lui-même un `Arc<...>`, donc
/// `clone()` est bon marché. La création est coûteuse (pool de connexions
/// + TLS), donc on la fait une fois pour toute l'app.
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn http_client() -> reqwest::Client {
    HTTP_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // Suit jusqu'à 10 redirections (sites qui basculent www ↔ apex,
                // http → https, etc.).
                .redirect(reqwest::redirect::Policy::limited(10))
                .connect_timeout(Duration::from_secs(30))
                .timeout(Duration::from_secs(60))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new())
        })
        .clone()
}

#[derive(Serialize)]
pub struct FetchResponse {
    pub status: u16,
    pub body: String,
    pub headers: HashMap<String, String>,
}

/// Effectue une requête HTTP GET avec des en-têtes arbitraires et renvoie le
/// corps texte, le statut et les en-têtes de réponse.
/// Si l'appelant ne fournit pas de User-Agent, on en ajoute un par défaut
/// (sinon certains sites — MangaDex notamment — rejettent les requêtes).
#[tauri::command]
pub async fn fetch_url(
    url: String,
    headers: HashMap<String, String>,
    method: Option<String>,
    body: Option<String>,
) -> Result<FetchResponse, String> {
    let client = http_client();
    let is_post = method
        .as_deref()
        .map(|m| m.eq_ignore_ascii_case("post"))
        .unwrap_or(false);
    let mut request = if is_post {
        client.post(&url)
    } else {
        client.get(&url)
    };
    let mut has_user_agent = false;
    let mut has_content_type = false;
    for (key, value) in &headers {
        if key.eq_ignore_ascii_case("user-agent") {
            has_user_agent = true;
        }
        if key.eq_ignore_ascii_case("content-type") {
            has_content_type = true;
        }
        request = request.header(key, value);
    }
    if !has_user_agent {
        request = request.header(reqwest::header::USER_AGENT, APP_USER_AGENT);
    }
    if let Some(b) = body {
        // Défaut form-urlencoded (endpoints admin-ajax Madara) si l'appelant
        // n'a pas précisé de Content-Type.
        if !has_content_type {
            request = request.header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded; charset=UTF-8",
            );
        }
        request = request.body(b);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("fetch_url({}): {}", url, e))?;
    let status = response.status().as_u16();

    let mut out_headers = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(v) = value.to_str() {
            out_headers.insert(name.to_string(), v.to_string());
        }
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("fetch_url({}): body: {}", url, e))?;
    Ok(FetchResponse {
        status,
        body,
        headers: out_headers,
    })
}

/// Télécharge une image et la renvoie sous forme de data URI base64.
/// Le media type est détecté depuis le Content-Type (fallback : image/jpeg).
/// Couvre image/png, image/webp, image/avif, image/gif (cf. valeurs renvoyées
/// par les CDN courants).
///
/// `label` (optionnel) = fenêtre solveur d'une source Cloudflare (`cf-{sourceId}`).
/// Si `reqwest` échoue (403 d'un CDN images derrière Cloudflare, ou erreur de
/// connexion) et qu'une telle fenêtre existe, on récupère l'image DANS cette
/// session WebView (empreinte TLS valide + cookies) via `image_via_webview`.
/// Fonctionne pour les images same-origin de la page courante du solveur (ex.
/// couvertures wp-content). Sans `label` (ou fenêtre absente), comportement
/// inchangé : on renvoie l'erreur et l'appelant retombe sur l'URL directe.
#[tauri::command]
pub async fn fetch_image_as_base64(
    url: String,
    headers: HashMap<String, String>,
    app: AppHandle,
    label: Option<String>,
) -> Result<String, String> {
    let referer = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("referer"))
        .map(|(_, v)| v.clone());

    let client = http_client();
    let mut request = client.get(&url);
    let mut has_user_agent = false;
    for (key, value) in &headers {
        if key.eq_ignore_ascii_case("user-agent") {
            has_user_agent = true;
        }
        request = request.header(key, value);
    }
    if !has_user_agent {
        request = request.header(reqwest::header::USER_AGENT, APP_USER_AGENT);
    }

    let response = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            return image_fallback(&app, &url, referer, label, format!("fetch_image({}): {}", url, e))
                .await
        }
    };

    let status = response.status();
    let ct = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !status.is_success() {
        eprintln!("[img] ÉCHEC {} -> {} ({})", url, status.as_u16(), ct);
        return image_fallback(
            &app,
            &url,
            referer,
            label,
            format!(
                "fetch_image({}): statut {} (content-type: {})",
                url,
                status.as_u16(),
                ct
            ),
        )
        .await;
    }

    let media_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(';').next())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "image/jpeg".to_string());

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("fetch_image({}): bytes: {}", url, e))?;
    let encoded = STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", media_type, encoded))
}

/// Repli image : tente `image_via_webview` si une fenêtre solveur `label` existe ;
/// sinon renvoie l'erreur reqwest d'origine.
async fn image_fallback(
    app: &AppHandle,
    url: &str,
    referer: Option<String>,
    label: Option<String>,
    orig_err: String,
) -> Result<String, String> {
    if let Some(label) = label {
        if app.get_webview_window(&label).is_some() {
            return image_via_webview(app, url, referer, Some(label)).await;
        }
    }
    Err(orig_err)
}

/// Clearance Cloudflare obtenue par l'utilisateur dans le WebView solveur.
/// `cookie` est prêt à être renvoyé tel quel dans l'en-tête HTTP `Cookie`,
/// `user_agent` est l'UA qu'il FAUT réutiliser dans les requêtes suivantes.
#[derive(Serialize)]
pub struct CloudflareClearance {
    pub cookie: String,
    pub user_agent: String,
}

/// Ouvre une fenêtre WebView (vrai navigateur Chromium/WebView2, capable
/// d'exécuter le challenge JS de Cloudflare) pointée sur `url`, attend que
/// l'utilisateur passe la vérification, puis récupère le cookie `cf_clearance`.
///
/// Le WebView utilise `CF_BROWSER_UA` ; la source appelante doit rejouer le
/// même UA dans `fetch_url`/`fetch_image_as_base64` pour que le cookie reste
/// valide.
///
/// Retours d'erreur (préfixés, reconnus côté front) :
/// - `CF_SOLVE_CANCELLED:` — l'utilisateur a fermé la fenêtre avant la fin.
/// - `CF_SOLVE_TIMEOUT:`   — challenge non résolu dans le délai (120 s).
#[tauri::command]
pub async fn solve_cloudflare(
    app: AppHandle,
    url: String,
    label: Option<String>,
    user_agent: Option<String>,
) -> Result<CloudflareClearance, String> {
    let label = label.unwrap_or_else(|| CF_SOLVER_LABEL.to_string());
    // UA de la fenêtre solveur. Par défaut desktop (CF_BROWSER_UA), mais une
    // source peut imposer le sien (ex. Scan-Manga : le site mobile `m.` redirige
    // les navigateurs desktop vers `www.`, ce qui casse le fetch same-origin).
    let ua = user_agent.unwrap_or_else(|| CF_BROWSER_UA.to_string());
    let parsed: Url = url
        .parse()
        .map_err(|e| format!("solve_cloudflare: URL invalide ({}): {}", url, e))?;

    // On réutilise la fenêtre existante si elle est là (elle détient déjà le
    // profil/les cookies WebView2) : on la ré-affiche et on recharge pour
    // re-déclencher le challenge. Sinon on en crée une neuve.
    let window = match app.get_webview_window(&label) {
        Some(w) => {
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.eval("location.reload()");
            w
        }
        None => WebviewWindowBuilder::new(
            &app,
            label.clone(),
            WebviewUrl::External(parsed.clone()),
        )
        .title("Vérification Cloudflare — résolvez le challenge puis fermez cette fenêtre")
        .inner_size(1000.0, 800.0)
        .user_agent(&ua)
        .initialization_script(LEL_HOOK_JS)
        .build()
        .map_err(|e| format!("solve_cloudflare: création de la fenêtre: {}", e))?,
    };

    // Sonde le cookie cf_clearance jusqu'à 120 s.
    let deadline = Instant::now() + Duration::from_secs(120);
    // Garde anti-race : juste après `build()`, `get_webview_window` peut
    // renvoyer None une fraction de seconde avant l'enregistrement dans la map.
    // On ne considère la fenêtre « fermée par l'utilisateur » qu'APRÈS l'avoir
    // vue présente au moins une fois.
    let mut window_was_seen = false;
    // Diagnostic : derniers noms de cookies observés + dernière erreur de
    // lecture, remontés dans le message d'erreur en cas d'échec.
    let mut last_names: Vec<String> = Vec::new();
    let mut last_read_error: Option<String> = None;

    loop {
        let present = app.get_webview_window(&label).is_some();
        if present {
            window_was_seen = true;
        } else if window_was_seen {
            // La fenêtre a existé puis a disparu → fermée par l'utilisateur.
            return Err(format!(
                "CF_SOLVE_CANCELLED: fenêtre fermée avant résolution. \
                 Cookies vus: [{}].",
                last_names.join(", ")
            ));
        }

        if Instant::now() > deadline {
            let _ = window.close();
            return Err(format!(
                "CF_SOLVE_TIMEOUT: cf_clearance introuvable après 120 s. \
                 Derniers cookies vus pour {}: [{}].{}",
                parsed,
                last_names.join(", "),
                last_read_error
                    .map(|e| format!(" Dernière erreur lecture: {}", e))
                    .unwrap_or_default(),
            ));
        }

        // 1) cookies ciblés sur l'URL ; 2) repli sur tout le store si vide, MAIS
        //    filtré par domaine cible — sinon on récupère le cf_clearance d'un
        //    AUTRE site (profil WebView2 partagé) → faux positif inter-domaines.
        let host = parsed.host_str().unwrap_or("").to_string();
        let domain_filtered = || -> Vec<_> {
            window
                .cookies()
                .unwrap_or_default()
                .into_iter()
                .filter(|c| {
                    c.domain()
                        .map(|d| {
                            let d = d.trim_start_matches('.');
                            !d.is_empty() && (host == d || host.ends_with(&format!(".{d}")))
                        })
                        .unwrap_or(false)
                })
                .collect()
        };
        let cookies = match window.cookies_for_url(parsed.clone()) {
            Ok(c) if !c.is_empty() => c,
            Ok(_) => domain_filtered(),
            Err(e) => {
                last_read_error = Some(e.to_string());
                domain_filtered()
            }
        };

        if !cookies.is_empty() {
            last_names = cookies.iter().map(|c| c.name().to_string()).collect();
            eprintln!("[cf-solver] cookies vus: {:?}", last_names);
        }

        if cookies.iter().any(|c| c.name() == "cf_clearance") {
            // On renvoie TOUS les cookies (cf_clearance + éventuels __cf_bm,
            // cf_chl_*) : Cloudflare peut en exiger plusieurs.
            let cookie_header = cookies
                .iter()
                .map(|c| format!("{}={}", c.name(), c.value()))
                .collect::<Vec<_>>()
                .join("; ");
            // On NE FERME PAS : la fenêtre devient le moteur de fetch (plan B,
            // `fetch_via_webview`). On la masque simplement.
            let _ = window.hide();
            return Ok(CloudflareClearance {
                cookie: cookie_header,
                user_agent: ua.clone(),
            });
        }

        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
}

static WEBVIEW_REQ_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct WebviewFetchResponse {
    pub status: u16,
    pub body: String,
}

/// Résultat intermédiaire stocké dans `window.__cf[id]` côté JS et relu par
/// polling (ExecuteScript ne sait pas attendre une promesse).
#[derive(Deserialize, Default)]
struct JsFetchResult {
    done: bool,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    status: u16,
    #[serde(default)]
    body: String,
    #[serde(default)]
    error: String,
    #[serde(default)]
    href: String,
}

/// Évalue `js` dans le WebView et renvoie la valeur (sérialisée JSON par
/// ExecuteScript). Marshalé sur le thread UI par Tauri ; on attend le callback
/// via un canal pour ne pas bloquer le thread async.
async fn eval_json(window: &WebviewWindow, js: String) -> Result<String, String> {
    eval_json_timeout(window, js, Duration::from_secs(30)).await
}

async fn eval_json_timeout(
    window: &WebviewWindow,
    js: String,
    timeout: Duration,
) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    window
        .eval_with_callback(js, move |res| {
            if let Ok(mut guard) = tx.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(res);
                }
            }
        })
        .map_err(|e| format!("eval_with_callback: {}", e))?;

    tokio::task::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|e| format!("eval join: {}", e))?
        .map_err(|_| "eval: timeout d'attente du résultat JS".to_string())
}

/// Récupère le HTML d'une URL en effectuant le `fetch` **dans le WebView**
/// solveur (vrai moteur Chrome : empreinte TLS valide + cookie cf_clearance
/// same-origin). Contourne le rejet de Cloudflare sur `reqwest`.
///
/// Erreur `CF_NEEDS_SOLVE:` → pas de session navigateur valide (à résoudre via
/// `solve_cloudflare` puis réessayer).
#[tauri::command]
pub async fn fetch_via_webview(
    app: AppHandle,
    url: String,
    method: Option<String>,
    body: Option<String>,
    label: Option<String>,
    headers: Option<HashMap<String, String>>,
    referrer: Option<String>,
) -> Result<WebviewFetchResponse, String> {
    let label = label.unwrap_or_else(|| CF_SOLVER_LABEL.to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "CF_NEEDS_SOLVE: aucune session navigateur active.".to_string())?;

    let id = WEBVIEW_REQ_ID.fetch_add(1, Ordering::Relaxed);
    let url_json = serde_json::to_string(&url).map_err(|e| e.to_string())?;
    let method_json = serde_json::to_string(method.as_deref().unwrap_or("GET")).unwrap();
    // Referer explicite : `fetch` n'autorise à le poser que via l'option
    // `referrer` (en-tête `Referer` interdit). `referrerPolicy: 'unsafe-url'`
    // force l'URL complète même cross-origin (ex. www → bqj pour l'API lel).
    let referrer_json = match &referrer {
        Some(r) => serde_json::to_string(r).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };
    // `null` si pas de corps ; sinon la chaîne (ex. form-urlencoded pour l'AJAX
    // chapitres de Madara).
    let body_json = match &body {
        Some(b) => serde_json::to_string(b).unwrap(),
        None => "null".to_string(),
    };
    // En-têtes explicites (ex. API lel de Scan-Manga : Content-Type JSON + Token).
    // Si fournis, ils sont utilisés tels quels ; sinon on garde le comportement
    // par défaut ci-dessous (form-urlencoded + X-Requested-With pour un corps).
    let headers_json = match &headers {
        Some(h) => serde_json::to_string(h).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };

    // Démarre le fetch en tâche de fond ; le résultat atterrit dans window.__cf[id].
    // Sans en-têtes explicites : `X-Requested-With` + form-urlencoded ne sont
    // ajoutés QUE pour les requêtes à corps (POST admin-ajax Madara). Sur un GET
    // HTML, X-Requested-With fait passer la requête pour de l'AJAX et certains
    // WAF (Scan-Manga) répondent 403 — un vrai navigateur ne l'envoie pas.
    let start_js = format!(
        r#"(function(){{
            window.__cf = window.__cf || {{}};
            window.__cf[{id}] = {{done:false}};
            var opts = {{credentials:'include', method:{method}, headers:{{}}}};
            var ref = {referrer};
            if (ref !== null) {{ opts.referrer = ref; opts.referrerPolicy = 'unsafe-url'; }}
            var b = {body};
            var hdrs = {headers};
            if (hdrs !== null) {{
                for (var k in hdrs) opts.headers[k] = hdrs[k];
                if (b !== null) opts.body = b;
            }} else if (b !== null) {{
                opts.headers['X-Requested-With']='XMLHttpRequest';
                opts.headers['Content-Type']='application/x-www-form-urlencoded; charset=UTF-8';
                opts.body = b;
            }}
            fetch({url}, opts)
              .then(function(r){{ return r.text().then(function(t){{
                  window.__cf[{id}] = {{done:true, ok:true, status:r.status, body:t}};
              }}); }})
              .catch(function(e){{ window.__cf[{id}] = {{done:true, ok:false, error:String(e), href:String(location.href)}}; }});
        }})()"#,
        id = id,
        url = url_json,
        method = method_json,
        body = body_json,
        headers = headers_json,
        referrer = referrer_json,
    );
    window
        .eval(start_js)
        .map_err(|e| format!("fetch_via_webview: démarrage: {}", e))?;

    let poll_js = format!(
        "(function(){{var r=window.__cf&&window.__cf[{id}];return r?r:{{done:false}};}})()",
        id = id,
    );

    let deadline = Instant::now() + Duration::from_secs(60);
    // Polling adaptatif : premier passage rapide (la plupart des fetch webview
    // aboutissent en < 200 ms — un pas fixe de 250 ms les taxait tous), puis
    // on relâche progressivement jusqu'à 250 ms.
    let mut poll_ms = 50u64;
    loop {
        if Instant::now() > deadline {
            return Err("fetch_via_webview: délai dépassé (60 s).".into());
        }
        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
        poll_ms = (poll_ms * 2).min(250);

        let raw = eval_json(&window, poll_js.clone()).await?;
        let parsed: JsFetchResult = serde_json::from_str(&raw).map_err(|e| {
            let preview: String = raw.chars().take(160).collect();
            format!("fetch_via_webview: parse ({}): {}", e, preview)
        })?;
        if !parsed.done {
            continue;
        }

        // Nettoie l'entrée pour ne pas faire grossir window.__cf.
        let _ = window.eval(format!("delete window.__cf[{}];", id));

        if !parsed.ok {
            return Err(format!(
                "fetch_via_webview: échec fetch JS: {} (page sur: {})",
                parsed.error, parsed.href
            ));
        }
        if parsed.status == 403 || parsed.status == 503 {
            return Err(format!(
                "CF_NEEDS_SOLVE: HTTP {} via webview (clearance expirée).",
                parsed.status
            ));
        }
        return Ok(WebviewFetchResponse {
            status: parsed.status,
            body: parsed.body,
        });
    }
}

/// Résultat d'un fetch image dans le WebView : data URL base64 (`data`) ou erreur.
#[derive(Deserialize, Default)]
struct JsImageResult {
    done: bool,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    data: String,
    #[serde(default)]
    error: String,
}

/// Télécharge les octets d'une image **dans le WebView** solveur (vrai Chrome :
/// empreinte TLS valide + cookies same-origin) et renvoie une data URL
/// `data:<mime>;base64,…`. Indispensable pour les CDN images derrière Cloudflare
/// (mangas-origines) où `reqwest` est coupé au niveau connexion (« error sending
/// request »). `referrer` couvre la protection anti-hotlink (`Referer` interdit
/// comme en-tête `fetch`, posé via l'option `referrer` + `referrerPolicy`).
pub async fn image_via_webview(
    app: &AppHandle,
    url: &str,
    referrer: Option<String>,
    label: Option<String>,
) -> Result<String, String> {
    let label = label.unwrap_or_else(|| CF_SOLVER_LABEL.to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "CF_NEEDS_SOLVE: aucune session navigateur active.".to_string())?;

    let id = WEBVIEW_REQ_ID.fetch_add(1, Ordering::Relaxed);
    let url_json = serde_json::to_string(url).map_err(|e| e.to_string())?;
    let referrer_json = match &referrer {
        Some(r) => serde_json::to_string(r).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };
    // Deux voies, la 2ᵉ en repli de la 1ʳᵉ :
    //  1) fetch() → blob → data URL (base64). Rapide et sans perte, mais échoue
    //     si le CDN images est sur un hôte cross-origin séparément protégé par
    //     Cloudflare (ex. c.sushiscan.net) : la requête `fetch` (Sec-Fetch-Dest:
    //     empty) est challengée / bloquée par CORS.
    //  2) <img crossOrigin=anonymous> → <canvas> → toDataURL. La requête image
    //     (Sec-Fetch-Dest: image) est servie par Cloudflare comme les <img> du
    //     site ; le canvas n'est pas « teinté » si le CDN renvoie un en-tête CORS
    //     (fréquent). Ré-encode en PNG (un peu plus lourd, mais fiable).
    let start_js = format!(
        r#"(function(){{
            window.__img = window.__img || {{}};
            window.__img[{id}] = {{done:false}};
            var url = {url};
            var ref = {referrer};
            function viaImg(){{
              return new Promise(function(res, rej){{
                var im = new Image();
                im.crossOrigin = 'anonymous';
                im.referrerPolicy = 'unsafe-url';
                im.onload = function(){{
                  try {{
                    var c = document.createElement('canvas');
                    c.width = im.naturalWidth; c.height = im.naturalHeight;
                    c.getContext('2d').drawImage(im, 0, 0);
                    res(c.toDataURL('image/png'));
                  }} catch(e){{ rej(e); }}
                }};
                im.onerror = function(){{ rej(new Error('img load failed')); }};
                im.src = url;
              }});
            }}
            var opts = {{credentials:'include'}};
            if (ref !== null) {{ opts.referrer = ref; opts.referrerPolicy = 'unsafe-url'; }}
            fetch(url, opts)
              .then(function(r){{ if(!r.ok) throw new Error('HTTP '+r.status); return r.blob(); }})
              .then(function(b){{ return new Promise(function(res, rej){{
                  var fr = new FileReader();
                  fr.onloadend = function(){{ res(String(fr.result)); }};
                  fr.onerror = function(){{ rej(fr.error || new Error('FileReader')); }};
                  fr.readAsDataURL(b);
              }}); }})
              .catch(function(){{ return viaImg(); }})
              .then(function(d){{ window.__img[{id}] = {{done:true, ok:true, data:d}}; }})
              .catch(function(e){{ window.__img[{id}] = {{done:true, ok:false, error:String(e)}}; }});
        }})()"#,
        id = id,
        url = url_json,
        referrer = referrer_json,
    );
    window
        .eval(start_js)
        .map_err(|e| format!("image_via_webview: démarrage: {}", e))?;

    let poll_js = format!(
        "(function(){{var r=window.__img&&window.__img[{id}];return r?r:{{done:false}};}})()",
        id = id,
    );
    let deadline = Instant::now() + Duration::from_secs(60);
    // Même polling adaptatif que fetch_via_webview (50 → 250 ms).
    let mut poll_ms = 50u64;
    loop {
        if Instant::now() > deadline {
            return Err("image_via_webview: délai dépassé (60 s).".into());
        }
        tokio::time::sleep(Duration::from_millis(poll_ms)).await;
        poll_ms = (poll_ms * 2).min(250);
        let raw = eval_json(&window, poll_js.clone()).await?;
        let parsed: JsImageResult = serde_json::from_str(&raw).map_err(|e| {
            let preview: String = raw.chars().take(120).collect();
            format!("image_via_webview: parse ({}): {}", e, preview)
        })?;
        if !parsed.done {
            continue;
        }
        let _ = window.eval(format!("delete window.__img[{}];", id));
        if !parsed.ok {
            return Err(format!("image_via_webview: échec fetch JS: {}", parsed.error));
        }
        return Ok(parsed.data);
    }
}

/// Commande Tauri exposant `image_via_webview` (repli image pour le lecteur).
#[tauri::command]
pub async fn fetch_image_via_webview(
    app: AppHandle,
    url: String,
    referrer: Option<String>,
    label: Option<String>,
) -> Result<String, String> {
    image_via_webview(&app, &url, referrer, label).await
}

/// Attend que le lecteur Scan-Manga ait décodé toutes ses pages, puis renvoie le
/// nombre de blobs images prêts (`window.__blobs`).
///
/// La fenêtre reste **masquée** : le shim d'IntersectionObserver injecté par
/// `LEL_HOOK_JS` fait croire au lecteur que toutes les pages sont visibles, donc
/// il les décode toutes d'emblée sans dépendre du rendu ni d'un scroll (pas de
/// popup). Ici on se contente de sonder `window.__blobs` jusqu'à `expected`
/// (ou stabilisation/timeout).
#[tauri::command]
pub async fn harvest_blobs(
    app: AppHandle,
    label: Option<String>,
    expected: u32,
    timeout_ms: u64,
) -> Result<u32, String> {
    let label = label.unwrap_or_else(|| CF_SOLVER_LABEL.to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "CF_NEEDS_SOLVE: aucune session navigateur active.".to_string())?;

    let count_js =
        "(function(){return window.__blobs?window.__blobs.filter(function(x){return !!x}).length:-1;})()";

    let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(5000));
    let mut last = -1i64;
    let mut stable = 0;
    let mut count = 0i64;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let raw = match eval_json_timeout(&window, count_js.into(), Duration::from_secs(5)).await {
            Ok(r) => r,
            Err(_) => continue,
        };
        count = serde_json::from_str::<i64>(&raw).unwrap_or(-1);
        if expected > 0 && count >= expected as i64 {
            break;
        }
        // ~12 s sans progression → on s'arrête (fallback si `expected` inatteignable).
        if count > 0 && count == last {
            stable += 1;
            if stable >= 30 {
                break;
            }
        } else {
            stable = 0;
        }
        last = count;
    }

    eprintln!("[harvest] {} blobs (attendu {})", count.max(0), expected);
    Ok(count.max(0) as u32)
}

#[derive(Deserialize, Default)]
struct NavProbe {
    #[serde(default)]
    href: String,
    #[serde(default)]
    ready: String,
    /// true si le DOM courant est une page de challenge Cloudflare (Turnstile,
    /// « Un instant… »). On attend qu'elle se dissipe avant de lire le contenu.
    #[serde(default)]
    challenge: bool,
}

/// Deux URLs désignent-elles la même page ? Host + chemin (slash final
/// ignoré) ET query — sans la query, `/catalogue/?order=popular` et
/// `/catalogue/?order=popular&genre[]=3` passaient pour identiques et les
/// filtres/pagination des sources en mode `navigate` ne re-naviguaient
/// jamais (bug S13). Les paramètres injectés par un challenge Cloudflare
/// (`?__cf_chl_rt_tk=…`) sont ignorés, et la query est triée (ordre stable).
fn same_page(a: &str, b: &str) -> bool {
    let norm = |s: &str| -> String {
        let no_frag = s.split('#').next().unwrap_or("");
        let mut parts = no_frag.splitn(2, '?');
        let base = parts.next().unwrap_or("").trim_end_matches('/');
        let mut params: Vec<&str> = parts
            .next()
            .unwrap_or("")
            .split('&')
            .filter(|p| !p.is_empty() && !p.starts_with("__cf_"))
            .collect();
        params.sort_unstable();
        format!("{}?{}", base, params.join("&"))
    };
    !a.is_empty() && norm(a) == norm(b)
}

/// Fait **naviguer** le WebView vers `url`, attend le rendu complet (le contenu
/// de mangas-origines est injecté par JS/AJAX, absent du HTML brut), puis
/// renvoie le DOM rendu (`document.documentElement.outerHTML`).
///
/// `CF_NEEDS_SOLVE:` si pas de session navigateur active.
#[tauri::command]
pub async fn render_via_webview(
    app: AppHandle,
    url: String,
    label: Option<String>,
) -> Result<WebviewFetchResponse, String> {
    let label = label.unwrap_or_else(|| CF_SOLVER_LABEL.to_string());
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "CF_NEEDS_SOLVE: aucune session navigateur active.".to_string())?;

    let url_json = serde_json::to_string(&url).map_err(|e| e.to_string())?;
    // Host de la cible : le site redirige (ex. /manga/page/1/ → /manga/), donc
    // on ne vérifie PAS le chemin, seulement qu'on est bien sur le bon domaine.
    let target_host = Url::parse(&url)
        .ok()
        .and_then(|u| u.host_str().map(|s| s.to_string()))
        .unwrap_or_default();

    // URL courante de la fenêtre. Si elle est DÉJÀ sur la page cible (cas typique
    // juste après un solve : le solveur a ouvert cette URL et le challenge vient
    // d'être passé), on NE re-navigue PAS : re-naviguer re-déclenche un challenge
    // Cloudflare dont la complétion peut renvoyer un 500. On lit le DOM en place.
    let current = match eval_json_timeout(
        &window,
        "String(location.href)".into(),
        Duration::from_secs(5),
    )
    .await
    {
        Ok(raw) => serde_json::from_str::<String>(&raw).unwrap_or_default(),
        Err(_) => String::new(),
    };
    let already_on_target = same_page(&current, &url);

    if already_on_target {
        eprintln!("[render] déjà sur la cible, pas de re-navigation: {}", current);
    } else {
        // Lance la navigation (détruit le contexte JS courant).
        window
            .eval(format!("window.location.href = {};", url_json))
            .map_err(|e| format!("render_via_webview: navigation: {}", e))?;
    }

    // Attend la fin de chargement ET la dissipation d'un éventuel challenge
    // Cloudflare. On exige d'avoir observé la navigation démarrer (un état
    // non-"complete") OU un délai mini, pour ne pas capter le "complete"
    // résiduel de la page précédente.
    //
    // Détection du challenge : `window._cf_chl_opt`, widget Turnstile, ou titre
    // « Un instant… ». Tant qu'il est là, on AFFICHE la fenêtre — masquée, son JS
    // (rAF/timers) est throttlé par WebView2 et le Turnstile ne s'auto-résout pas.
    let probe_js = "(function(){var t=document.title||'';\
        var ch=!!window._cf_chl_opt\
          ||!!document.querySelector('[name=cf-turnstile-response],#challenge-error-text,#challenge-running,#cf-chl-widget')\
          ||/just a moment|un instant|v.rification de s.curit/i.test(t);\
        return {href:String(location.href),ready:String(document.readyState),challenge:ch};})()";

    let start = Instant::now();
    let deadline = start + Duration::from_secs(60);
    // Si on n'a pas re-navigué, la page est déjà chargée : on autorise une sortie
    // immédiate (sinon on attendrait d'observer un état non-"complete").
    let mut nav_started = already_on_target;
    let mut loaded = false;
    let mut shown = false;
    // Rechargement de secours : voir plus bas. Une seule fois.
    let mut reloaded = false;
    let mut last_dbg = String::new();
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let raw = match eval_json_timeout(&window, probe_js.into(), Duration::from_secs(5)).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[render] sonde erreur: {}", e);
                continue; // page en cours de navigation → on réessaie
            }
        };
        eprintln!("[render] sonde: {}", raw);
        last_dbg = raw.clone();
        let probe: NavProbe = serde_json::from_str(&raw).unwrap_or_default();
        if probe.ready != "complete" {
            nav_started = true;
        }

        if probe.challenge {
            // Affiche la fenêtre pour débloquer le challenge (après un court délai,
            // pour éviter un flash si Turnstile passe instantanément).
            if !shown && start.elapsed() > Duration::from_millis(1200) {
                let _ = window.show();
                let _ = window.set_focus();
                shown = true;
            }
            // Challenge persistant : un rechargement avec le cookie cf_clearance
            // déjà obtenu (par solve_cloudflare) laisse en général passer CF, là où
            // la page interstitielle reste figée (son JS de redirection est throttlé
            // quand la fenêtre était masquée, et ne repart pas une fois ré-affichée).
            // Une seule fois, après un délai laissant la chance à un passage auto.
            if !reloaded && start.elapsed() > Duration::from_secs(8) {
                eprintln!("[render] challenge figé → rechargement avec clearance");
                let _ = window.eval("location.reload()");
                reloaded = true;
                nav_started = true;
            }
            continue;
        }

        let on_target = target_host.is_empty() || probe.href.contains(&target_host);
        if probe.ready == "complete"
            && on_target
            && (nav_started || start.elapsed() > Duration::from_secs(2))
        {
            loaded = true;
            break;
        }
    }
    // Re-masque la fenêtre si on l'avait affichée pour le challenge.
    if shown {
        let _ = window.hide();
    }
    if !loaded {
        // Préfixe CF_NEEDS_SOLVE : le transport déclenchera le solveur interactif.
        return Err(format!(
            "CF_NEEDS_SOLVE: render: challenge Cloudflare non résolu (45 s). \
             Host attendu: '{}'. Dernière sonde: {}",
            target_host, last_dbg
        ));
    }

    // Laisse l'AJAX (grille de mangas, liste de chapitres) se peupler.
    tokio::time::sleep(Duration::from_millis(2500)).await;

    // Lit le DOM rendu. ExecuteScript renvoie la valeur JS sérialisée en JSON,
    // donc une string JS revient encadrée de guillemets → on la dé-sérialise.
    let raw = eval_json(&window, "document.documentElement.outerHTML".into()).await?;
    let body: String = serde_json::from_str(&raw)
        .map_err(|e| format!("render_via_webview: lecture DOM: {}", e))?;

    Ok(WebviewFetchResponse { status: 200, body })
}

/// Évalue `js` dans la fenêtre WebView `label` et renvoie le résultat sérialisé
/// JSON par ExecuteScript (une string JS revient encadrée de guillemets). Sert
/// à lire des valeurs posées par le JS de la page (ex. `window.__lel[idc]`
/// capturé par le hook `lel` de Scan-Manga).
#[tauri::command]
pub async fn eval_webview(app: AppHandle, label: String, js: String) -> Result<String, String> {
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| "CF_NEEDS_SOLVE: aucune session navigateur active.".to_string())?;
    eval_json(&window, js).await
}
