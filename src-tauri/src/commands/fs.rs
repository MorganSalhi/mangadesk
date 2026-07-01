use base64::{engine::general_purpose::STANDARD, Engine as _};
use sqlx::SqlitePool;
use tauri::{Manager, State};

/// Renvoie le chemin absolu du dossier de données de l'application.
#[tauri::command]
pub async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Crée le dossier `path` (et ses parents) s'il n'existe pas.
#[tauri::command]
pub async fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

/// Indique si un fichier (ou dossier) existe.
#[tauri::command]
pub async fn file_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

/// Lit un fichier image local et le renvoie sous forme de data URI base64.
#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let media_type = guess_media_type(&path);
    Ok(format!("data:{};base64,{}", media_type, STANDARD.encode(&bytes)))
}

/// Vide le dossier `{APPDATA}/mangadesk/cache/` (recréé vide ensuite).
#[tauri::command]
pub async fn clear_cache(app: tauri::AppHandle) -> Result<(), String> {
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mangadesk")
        .join("cache");
    if cache.exists() {
        std::fs::remove_dir_all(&cache).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    Ok(())
}

/// Renvoie les 500 dernières lignes de `{APPDATA}/mangadesk/mangadesk.log`.
#[tauri::command]
pub async fn read_logs(app: tauri::AppHandle) -> Result<String, String> {
    let log = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mangadesk")
        .join("mangadesk.log");
    if !log.exists() {
        return Ok(String::new());
    }
    let content = std::fs::read_to_string(&log).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(500);
    Ok(lines[start..].join("\n"))
}

// ---------------------------------------------------------------------------
// Sources externes (session 5B)
// ---------------------------------------------------------------------------

/// Renvoie `{APPDATA}/mangadesk/sources/` et garantit son existence.
/// C'est l'unique dossier scanné par `loadExternalSources()` côté JS.
#[tauri::command]
pub async fn get_sources_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mangadesk")
        .join("sources");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Liste tous les fichiers `.js` (non récursif) dans `dir`.
#[tauri::command]
pub async fn list_js_files(dir: String) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(&dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("js") {
            out.push(p.to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// Lit un fichier texte (UTF-8). Utilisé pour récupérer le source des plugins
/// avant injection dans `new Function(...)` côté JS.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Écrit `content` dans `path` (crée le fichier ou écrase). Utilisé pour
/// installer une source téléchargée depuis une URL ou copiée depuis un disque.
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Supprime un fichier source (utilisé par l'UI Settings — désinstallation).
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| e.to_string())
}

/// Enregistre une source dans la table `sources` (INSERT OR IGNORE) — appelé
/// au chargement d'une source dynamique pour que la FK `manga.source_id` soit
/// satisfaite lors d'ajouts en bibliothèque. Idempotent.
#[tauri::command]
pub async fn register_source(
    pool: State<'_, SqlitePool>,
    id: String,
    name: String,
    lang: String,
    base_url: String,
    version: String,
    is_nsfw: bool,
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    sqlx::query(
        "INSERT INTO sources (id, name, lang, base_url, version, is_nsfw, installed_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           name = excluded.name, \
           lang = excluded.lang, \
           base_url = excluded.base_url, \
           version = excluded.version, \
           is_nsfw = excluded.is_nsfw",
    )
    .bind(id)
    .bind(name)
    .bind(lang)
    .bind(base_url)
    .bind(version)
    .bind(if is_nsfw { 1 } else { 0 })
    .bind(now)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn guess_media_type(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".avif") {
        "image/avif"
    } else {
        "image/jpeg"
    }
}
