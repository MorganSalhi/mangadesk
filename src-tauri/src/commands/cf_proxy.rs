use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

// ============================================================================
// Proxy Cloudflare — session 6 (suite).
//
// Architecture :
// 1. Quand `fetch_url` reçoit 403/503 sur une origine, on la marque
//    « Cloudflare ». Le frontend remonte ça en `CLOUDFLARE_BLOCKED:` côté JS.
// 2. L'utilisateur clique « Ouvrir la page de défi » → `cf_solve(url)` ouvre
//    une `WebviewWindow` Tauri pointée sur l'origine. Webview2/WKWebView est
//    un vrai navigateur — il exécute le JS du défi Cloudflare et obtient un
//    cookie `cf_clearance` une fois le challenge passé.
// 3. À la réessaye, `fetch_url` lit les cookies de cette webview via
//    `WebviewWindow::cookies_for_url(...)` et les attache au header `Cookie:`
//    avant l'envoi avec `reqwest`. C'est suffisant pour passer la
//    vérification IP+UA+Cookie côté Cloudflare (le fingerprint TLS reste
//    différent ; pour les opérateurs qui le vérifient strictement, ce
//    proxy ne suffira pas — c'est documenté dans `SESSION6-NOTES.md`).
// ============================================================================

#[derive(Default)]
pub struct CfProxyState {
    /// origine ("https://hôte[:port]") → label de la webview proxy
    pub webviews: Mutex<HashMap<String, String>>,
    /// origines déjà identifiées Cloudflare (pour éviter une 1re tentative
    /// reqwest directe qui passera systématiquement par 403 ensuite).
    pub cloudflare_origins: Mutex<HashSet<String>>,
}

/// Extrait `scheme://host[:port]` d'une URL. None si malformée ou sans hôte.
pub fn origin_of(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    let port = parsed
        .port()
        .map(|p| format!(":{}", p))
        .unwrap_or_default();
    Some(format!("{}://{}{}", parsed.scheme(), host, port))
}

/// Renvoie `true` si l'origine de `url` a déjà été marquée Cloudflare.
pub fn is_cloudflare_origin(state: &CfProxyState, url: &str) -> bool {
    let Some(origin) = origin_of(url) else {
        return false;
    };
    state
        .cloudflare_origins
        .lock()
        .ok()
        .map(|s| s.contains(&origin))
        .unwrap_or(false)
}

/// Marque l'origine comme Cloudflare-bloquée pour les requêtes futures.
pub fn mark_cloudflare(state: &CfProxyState, url: &str) {
    if let Some(origin) = origin_of(url) {
        if let Ok(mut set) = state.cloudflare_origins.lock() {
            set.insert(origin);
        }
    }
}

/// Lit les cookies persistés dans la webview proxy pour `url`.
/// Renvoie un header `Cookie: k1=v1; k2=v2; …` prêt à attacher, ou `None`
/// si pas de proxy actif pour cette origine ou erreur d'accès aux cookies.
///
/// L'appel `cookies_for_url` peut deadlocker sur Windows quand il est invoqué
/// dans le contexte direct d'une commande sync ; on est en async, donc
/// `spawn_blocking` isole l'appel sur un thread blocking dédié.
pub async fn cookie_header_for(
    state: &CfProxyState,
    app: &AppHandle,
    url: &str,
) -> Option<String> {
    let origin = origin_of(url)?;
    let label = state
        .webviews
        .lock()
        .ok()?
        .get(&origin)
        .cloned()?;
    let webview = app.get_webview_window(&label)?;
    let url_obj = Url::parse(url).ok()?;
    let cookies = tauri::async_runtime::spawn_blocking(move || {
        webview.cookies_for_url(url_obj)
    })
    .await
    .ok()?
    .ok()?;
    if cookies.is_empty() {
        return None;
    }
    let header = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    Some(header)
}

// ---------------------------------------------------------------------------
// Commandes exposées au frontend
// ---------------------------------------------------------------------------

/// Ouvre (ou ré-affiche) une fenêtre webview pointée sur l'origine de `url`
/// pour que l'utilisateur puisse résoudre un défi Cloudflare. Idempotent.
#[tauri::command]
pub async fn cf_solve(
    app: AppHandle,
    state: tauri::State<'_, CfProxyState>,
    url: String,
) -> Result<(), String> {
    let origin = origin_of(&url).ok_or_else(|| format!("URL invalide : {}", url))?;
    let safe_label = origin
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>();
    let label = format!("cf_{}", safe_label);

    // Idempotent : si la webview existe déjà, on la ré-affiche et on focus.
    {
        let map = state.webviews.lock().map_err(|e| e.to_string())?;
        if let Some(existing_label) = map.get(&origin) {
            if let Some(win) = app.get_webview_window(existing_label) {
                let _ = win.show();
                let _ = win.set_focus();
                return Ok(());
            }
        }
    }

    let url_obj = Url::parse(&url).map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url_obj))
        .title(format!("Résolution Cloudflare — {}", origin))
        .inner_size(900.0, 700.0)
        .visible(true)
        .focused(true)
        .build()
        .map_err(|e| e.to_string())?;

    {
        let mut map = state.webviews.lock().map_err(|e| e.to_string())?;
        map.insert(origin.clone(), label);
    }
    {
        let mut set = state
            .cloudflare_origins
            .lock()
            .map_err(|e| e.to_string())?;
        set.insert(origin);
    }
    Ok(())
}

/// Ferme la webview proxy associée à l'origine de `url`. Les cookies obtenus
/// sont perdus (les webviews Tauri ont une session persistante par défaut sur
/// le profil utilisateur, mais on les considère comme perdus dès qu'on ferme
/// pour rester simple). L'origine reste marquée Cloudflare pour la session.
#[tauri::command]
pub async fn cf_close(
    app: AppHandle,
    state: tauri::State<'_, CfProxyState>,
    url: String,
) -> Result<(), String> {
    let Some(origin) = origin_of(&url) else {
        return Ok(());
    };
    let label = state
        .webviews
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&origin);
    if let Some(label) = label {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
    }
    Ok(())
}

/// Vérifie si une origine a un cookie `cf_clearance` disponible — utilisé
/// par le frontend pour activer le bouton « Réessayer » dès que la résolution
/// est terminée (polling très léger côté UI).
#[tauri::command]
pub async fn cf_has_clearance(
    app: AppHandle,
    state: tauri::State<'_, CfProxyState>,
    url: String,
) -> Result<bool, String> {
    let Some(origin) = origin_of(&url) else {
        return Ok(false);
    };
    let label = state
        .webviews
        .lock()
        .map_err(|e| e.to_string())?
        .get(&origin)
        .cloned();
    let Some(label) = label else { return Ok(false) };
    let Some(webview) = app.get_webview_window(&label) else {
        return Ok(false);
    };
    let url_obj = Url::parse(&url).map_err(|e| e.to_string())?;
    let cookies = tauri::async_runtime::spawn_blocking(move || {
        webview.cookies_for_url(url_obj)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(cookies.iter().any(|c| c.name() == "cf_clearance"))
}
