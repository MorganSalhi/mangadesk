// ============================================================================
// Tracking externe (AniList / MAL) + OAuth2 via deep link `mangadesk://`.
//
// ⚠️ Réalité des providers (à connaître avant d'activer le tracking) :
//   • MAL : OAuth2 PKCE supporté, mais UNIQUEMENT `code_challenge_method=plain`
//     (challenge == verifier). Échange code→token via POST /v1/oauth2/token.
//   • AniList : NE supporte PAS PKCE. En desktop on utilise l'« Implicit Grant »
//     (`response_type=token`) : le token arrive directement dans le fragment
//     `#access_token=...` du deep link. `complete_oauth` accepte alors
//     directement le token dans le paramètre `code`.
//
// Les CLIENT_ID ci-dessous sont des emplacements : l'utilisateur doit créer ses
// propres applications OAuth (callback `mangadesk://auth/{provider}`) et coller
// les identifiants ici (ou via la préférence `{provider}_client_id`).
// ============================================================================

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

const ANILIST_CLIENT_ID: &str = ""; // ex. "12345"
const MAL_CLIENT_ID: &str = "cd32e7e912939f353d8e33e2c5eff667";
// Requis si l'app MAL est de type « web » (client confidentiel). Pour un type
// « other » (public PKCE), laisser vide. Lu aussi depuis la préférence
// `mal_client_secret` si la constante est vide.
const MAL_CLIENT_SECRET: &str = "";

/// État OAuth en mémoire : `code_verifier` par provider, le temps du flow.
#[derive(Default)]
pub struct AuthState {
    pub verifiers: Arc<Mutex<HashMap<String, String>>>,
}

impl AuthState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn gen_verifier() -> String {
    let mut bytes = [0u8; 96]; // → 128 caractères base64url (borne haute RFC 7636).
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Challenge PKCE S256 (= `base64url(SHA256(verifier))`), conforme RFC 7636.
/// Conservé pour un futur provider supportant S256 : MAL n'accepte que `plain`
/// et AniList n'implémente pas PKCE (implicit grant), donc inutilisé pour l'instant.
#[allow(dead_code)]
fn challenge_s256(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

async fn client_id(pool: &SqlitePool, provider: &str, fallback: &str) -> String {
    if !fallback.is_empty() {
        return fallback.to_string();
    }
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM preferences WHERE key = ?")
            .bind(format!("{}_client_id", provider))
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    row.map(|r| r.0).unwrap_or_default()
}

async fn client_secret(pool: &SqlitePool, provider: &str, fallback: &str) -> String {
    if !fallback.is_empty() {
        return fallback.to_string();
    }
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM preferences WHERE key = ?")
        .bind(format!("{}_client_secret", provider))
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    row.map(|r| r.0).unwrap_or_default()
}

// --- OAuth ------------------------------------------------------------------

#[tauri::command]
pub async fn start_oauth(provider: String, app: tauri::AppHandle) -> Result<(), String> {
    let pool = app.state::<SqlitePool>();
    let redirect = format!("mangadesk://auth/{}", provider);

    let url = match provider.as_str() {
        "anilist" => {
            let cid = client_id(&pool, "anilist", ANILIST_CLIENT_ID).await;
            if cid.is_empty() {
                return Err("AniList client_id non configuré".into());
            }
            // Implicit grant : pas de PKCE côté AniList.
            format!(
                "https://anilist.co/api/v2/oauth/authorize?client_id={}&redirect_uri={}&response_type=token",
                cid,
                urlencode(&redirect)
            )
        }
        "mal" => {
            let cid = client_id(&pool, "mal", MAL_CLIENT_ID).await;
            if cid.is_empty() {
                return Err("MAL client_id non configuré".into());
            }
            // MAL : PKCE « plain » (challenge == verifier).
            let verifier = gen_verifier();
            app.state::<AuthState>()
                .verifiers
                .lock()
                .unwrap()
                .insert("mal".into(), verifier.clone());
            format!(
                "https://myanimelist.net/v1/oauth2/authorize?response_type=code&client_id={}&code_challenge={}&code_challenge_method=plain&redirect_uri={}",
                cid,
                urlencode(&verifier),
                urlencode(&redirect)
            )
        }
        other => return Err(format!("provider inconnu : {}", other)),
    };

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn complete_oauth(
    provider: String,
    code: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let pool = app.state::<SqlitePool>();
    let token = match provider.as_str() {
        // AniList implicit : `code` contient déjà l'access_token (fragment).
        "anilist" => code,
        "mal" => {
            let cid = client_id(&pool, "mal", MAL_CLIENT_ID).await;
            let verifier = app
                .state::<AuthState>()
                .verifiers
                .lock()
                .unwrap()
                .remove("mal")
                .ok_or_else(|| "flow OAuth MAL expiré".to_string())?;
            let redirect = "mangadesk://auth/mal";
            let secret = client_secret(&pool, "mal", MAL_CLIENT_SECRET).await;
            let mut params: Vec<(&str, &str)> = vec![
                ("client_id", cid.as_str()),
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", redirect),
            ];
            // Type « web » : MAL exige le client_secret. Type « other » : ignoré.
            if !secret.is_empty() {
                params.push(("client_secret", secret.as_str()));
            }
            let resp = crate::commands::fetch::http_client()
                .post("https://myanimelist.net/v1/oauth2/token")
                .form(&params)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            json.get("access_token")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .ok_or_else(|| format!("réponse token MAL invalide : {}", json))?
        }
        other => return Err(format!("provider inconnu : {}", other)),
    };

    sqlx::query("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)")
        .bind(format!("{}_token", provider))
        .bind(token)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    // Notifie l'UI (l'onglet Comptes rafraîchit son statut).
    let _ = app.emit("oauth:done", &provider);
    Ok(())
}

#[tauri::command]
pub async fn disconnect_tracker(provider: String, app: tauri::AppHandle) -> Result<(), String> {
    let pool = app.state::<SqlitePool>();
    sqlx::query("DELETE FROM preferences WHERE key = ?")
        .bind(format!("{}_token", provider))
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn tracker_connected(provider: String, app: tauri::AppHandle) -> Result<bool, String> {
    let pool = app.state::<SqlitePool>();
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM preferences WHERE key = ?")
        .bind(format!("{}_token", provider))
        .fetch_optional(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| !r.0.is_empty()).unwrap_or(false))
}

async fn token(pool: &SqlitePool, provider: &str) -> Option<String> {
    sqlx::query_as::<_, (String,)>("SELECT value FROM preferences WHERE key = ?")
        .bind(format!("{}_token", provider))
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .map(|r| r.0)
        .filter(|s| !s.is_empty())
}

// --- Recherche / liaison / sync --------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackerSearchResult {
    pub remote_id: String,
    pub title: String,
    pub cover_url: Option<String>,
    pub year: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TrackingRow {
    pub manga_id: String,
    pub provider: String,
    pub remote_id: String,
    pub title: String,
    pub status: Option<String>,
    pub score: Option<i64>,
    pub progress: Option<i64>,
    pub last_synced: Option<i64>,
}

#[tauri::command]
pub async fn search_tracker(
    provider: String,
    query: String,
    app: tauri::AppHandle,
) -> Result<Vec<TrackerSearchResult>, String> {
    match provider.as_str() {
        "anilist" => anilist_search(&query).await,
        "mal" => {
            let pool = app.state::<SqlitePool>();
            let cid = client_id(&pool, "mal", MAL_CLIENT_ID).await;
            mal_search(&query, &cid).await
        }
        other => Err(format!("provider inconnu : {}", other)),
    }
}

#[tauri::command]
pub async fn get_manga_tracking(
    manga_id: String,
    app: tauri::AppHandle,
) -> Result<Vec<TrackingRow>, String> {
    let pool = app.state::<SqlitePool>();
    sqlx::query_as::<_, TrackingRow>(
        "SELECT manga_id, provider, remote_id, title, status, score, progress, last_synced \
         FROM manga_tracking WHERE manga_id = ?",
    )
    .bind(manga_id)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn link_tracker(
    manga_id: String,
    provider: String,
    remote_id: String,
    title: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let pool = app.state::<SqlitePool>();
    sqlx::query(
        "INSERT OR REPLACE INTO manga_tracking \
         (manga_id, provider, remote_id, title, status, score, progress, last_synced) \
         VALUES (?,?,?,?,NULL,NULL,0,?)",
    )
    .bind(&manga_id)
    .bind(&provider)
    .bind(&remote_id)
    .bind(&title)
    .bind(now_millis())
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn unlink_tracker(
    manga_id: String,
    provider: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let pool = app.state::<SqlitePool>();
    sqlx::query("DELETE FROM manga_tracking WHERE manga_id = ? AND provider = ?")
        .bind(manga_id)
        .bind(provider)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sync_tracker_progress(
    manga_id: String,
    provider: String,
    progress: i64,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let pool = app.state::<SqlitePool>();
    let remote: Option<(String,)> =
        sqlx::query_as("SELECT remote_id FROM manga_tracking WHERE manga_id = ? AND provider = ?")
            .bind(&manga_id)
            .bind(&provider)
            .fetch_optional(&*pool)
            .await
            .map_err(|e| e.to_string())?;
    let Some((remote_id,)) = remote else {
        return Err("manga non lié".into());
    };

    // Push distant si un token est présent (sinon on met juste à jour le local).
    if let Some(tok) = token(&pool, &provider).await {
        match provider.as_str() {
            "anilist" => anilist_update_progress(&remote_id, progress, &tok).await?,
            "mal" => {
                let cid = client_id(&pool, "mal", MAL_CLIENT_ID).await;
                mal_update_progress(&remote_id, progress, &tok, &cid).await?
            }
            _ => {}
        }
    }

    sqlx::query(
        "UPDATE manga_tracking SET progress = ?, last_synced = ? WHERE manga_id = ? AND provider = ?",
    )
    .bind(progress)
    .bind(now_millis())
    .bind(&manga_id)
    .bind(&provider)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// --- AniList (GraphQL) ------------------------------------------------------

async fn anilist_search(query: &str) -> Result<Vec<TrackerSearchResult>, String> {
    let gql = r#"query ($q: String) {
      Page(perPage: 15) {
        media(search: $q, type: MANGA) {
          id
          title { romaji english }
          coverImage { medium }
          startDate { year }
        }
      }
    }"#;
    let body = serde_json::json!({ "query": gql, "variables": { "q": query } });
    let resp = crate::commands::fetch::http_client()
        .post("https://graphql.anilist.co")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let media = json
        .pointer("/data/Page/media")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(media
        .into_iter()
        .map(|m| TrackerSearchResult {
            remote_id: m["id"].as_i64().map(|i| i.to_string()).unwrap_or_default(),
            title: m["title"]["english"]
                .as_str()
                .or_else(|| m["title"]["romaji"].as_str())
                .unwrap_or("(sans titre)")
                .to_string(),
            cover_url: m["coverImage"]["medium"].as_str().map(|s| s.to_string()),
            year: m["startDate"]["year"].as_i64(),
        })
        .collect())
}

async fn anilist_update_progress(remote_id: &str, progress: i64, token: &str) -> Result<(), String> {
    let gql = r#"mutation ($id: Int, $p: Int) {
      SaveMediaListEntry(mediaId: $id, progress: $p) { id progress }
    }"#;
    let id: i64 = remote_id.parse().map_err(|_| "remote_id AniList invalide")?;
    let body = serde_json::json!({ "query": gql, "variables": { "id": id, "p": progress } });
    let resp = crate::commands::fetch::http_client()
        .post("https://graphql.anilist.co")
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("AniList sync HTTP {}", resp.status().as_u16()))
    }
}

// --- MyAnimeList (REST v2) --------------------------------------------------

async fn mal_search(query: &str, client_id: &str) -> Result<Vec<TrackerSearchResult>, String> {
    if client_id.is_empty() {
        return Err("MAL client_id non configuré".into());
    }
    let resp = crate::commands::fetch::http_client()
        .get("https://api.myanimelist.net/v2/manga")
        .header("X-MAL-CLIENT-ID", client_id)
        .query(&[
            ("q", query),
            ("limit", "15"),
            ("fields", "id,title,main_picture,start_date"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let data = json["data"].as_array().cloned().unwrap_or_default();
    Ok(data
        .into_iter()
        .map(|entry| {
            let node = &entry["node"];
            TrackerSearchResult {
                remote_id: node["id"].as_i64().map(|i| i.to_string()).unwrap_or_default(),
                title: node["title"].as_str().unwrap_or("(sans titre)").to_string(),
                cover_url: node["main_picture"]["medium"].as_str().map(|s| s.to_string()),
                year: node["start_date"]
                    .as_str()
                    .and_then(|d| d.get(0..4))
                    .and_then(|y| y.parse().ok()),
            }
        })
        .collect())
}

async fn mal_update_progress(
    remote_id: &str,
    progress: i64,
    token: &str,
    _client_id: &str,
) -> Result<(), String> {
    let url = format!(
        "https://api.myanimelist.net/v2/manga/{}/my_list_status",
        remote_id
    );
    let resp = crate::commands::fetch::http_client()
        .patch(url)
        .bearer_auth(token)
        .form(&[("num_chapters_read", progress.to_string())])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("MAL sync HTTP {}", resp.status().as_u16()))
    }
}

fn urlencode(s: &str) -> String {
    // Encodage minimal des caractères réservés présents dans nos URLs.
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
