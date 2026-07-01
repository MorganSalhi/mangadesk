// ============================================================================
// Gestionnaire de téléchargements.
//
// Rust ne peut pas appeler les sources JS : le frontend fournit les URLs de
// pages en réponse à l'event `download:fetch-pages`, puis Rust télécharge les
// images via reqwest et persiste la progression par events.
//
// Écart assumé vs. brief : `DownloadStatus::Error(String)` (variante à payload)
// sérialise mal pour le store frontend (union de chaînes). On utilise donc un
// enum « plat » (sérialisé en minuscules) + un champ `error: Option<String>`
// sur la tâche. Idem : le brief montre `queue: VecDeque` + `active: Vec` ; on
// préfère une `HashMap<chapterId, DownloadTask>` (pause/reprise/annulation et
// `get_download_queue` plus simples) + un `Semaphore` Tokio pour la concurrence.
// ============================================================================

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadStatus {
    Queued,
    Downloading,
    Paused,
    Completed,
    Error,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub chapter_id: String,
    pub manga_id: String,
    pub source_id: String,
    pub status: DownloadStatus,
    pub progress: usize,
    pub total: usize,
    pub local_path: Option<String>,
    pub error: Option<String>,
}

/// Page fournie par le frontend (`source.getPageList` mappé en `{ index, url }`).
#[derive(Clone, Deserialize)]
pub struct PageInfo {
    pub index: usize,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

pub struct Downloader {
    pub tasks: Arc<Mutex<HashMap<String, DownloadTask>>>,
    /// Concurrence max, modifiable à chaud (cf. `set_max_concurrent`).
    pub max_concurrent: Arc<Mutex<usize>>,
    /// Nombre de téléchargements actuellement en cours.
    pub active: Arc<Mutex<usize>>,
}

impl Downloader {
    pub fn new(max_concurrent: usize) -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            max_concurrent: Arc::new(Mutex::new(max_concurrent.max(1))),
            active: Arc::new(Mutex::new(0)),
        }
    }
}

/// Garde RAII : libère un créneau de concurrence à la fin du téléchargement
/// (succès, erreur ou annulation), quel que soit le chemin de sortie.
struct Slot {
    active: Arc<Mutex<usize>>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut a = self.active.lock().unwrap();
        *a = a.saturating_sub(1);
    }
}

/// Attend qu'un créneau se libère (polling 200 ms — robuste, pas de
/// lost-wakeup), puis le réserve. Cohérent avec le polling de pause.
async fn acquire_slot(state: &tauri::State<'_, Downloader>) -> Slot {
    loop {
        {
            let mut active = state.active.lock().unwrap();
            let max = *state.max_concurrent.lock().unwrap();
            if *active < max {
                *active += 1;
                return Slot {
                    active: state.active.clone(),
                };
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

// --- Events (typés pour rester cohérents avec le frontend) ------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChapterEvent {
    chapter_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchPagesEvent {
    chapter_id: String,
    manga_id: String,
    source_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    chapter_id: String,
    progress: usize,
    total: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompletedEvent {
    chapter_id: String,
    local_path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorEvent {
    chapter_id: String,
    error: String,
}

// --- Commandes Tauri --------------------------------------------------------

#[tauri::command]
pub async fn enqueue_download(
    chapter_id: String,
    manga_id: String,
    source_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Downloader>,
) -> Result<(), String> {
    {
        let mut tasks = state.tasks.lock().unwrap();
        // Idempotent : ne pas réenfiler un téléchargement déjà terminé/en cours.
        if let Some(existing) = tasks.get(&chapter_id) {
            if existing.status != DownloadStatus::Error {
                return Ok(());
            }
        }
        tasks.insert(
            chapter_id.clone(),
            DownloadTask {
                chapter_id: chapter_id.clone(),
                manga_id: manga_id.clone(),
                source_id: source_id.clone(),
                status: DownloadStatus::Queued,
                progress: 0,
                total: 0,
                local_path: None,
                error: None,
            },
        );
    }

    let _ = app.emit(
        "download:queued",
        ChapterEvent {
            chapter_id: chapter_id.clone(),
        },
    );
    // Demande au frontend de résoudre les URLs de pages via la source JS.
    let _ = app.emit(
        "download:fetch-pages",
        FetchPagesEvent {
            chapter_id,
            manga_id,
            source_id,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn provide_download_pages(
    chapter_id: String,
    pages: Vec<PageInfo>,
    app: tauri::AppHandle,
    state: tauri::State<'_, Downloader>,
) -> Result<(), String> {
    let (manga_id, source_id) = {
        let tasks = state.tasks.lock().unwrap();
        match tasks.get(&chapter_id) {
            Some(t) => (t.manga_id.clone(), t.source_id.clone()),
            None => return Err("tâche de téléchargement inconnue".into()),
        }
    };

    let total = pages.len();
    set_status(&state, &chapter_id, DownloadStatus::Downloading, |t| {
        t.total = total;
        t.progress = 0;
        t.error = None;
    });

    let base = chapter_dir(&downloads_root(&app).await?, &source_id, &manga_id, &chapter_id);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    // Limite de concurrence : on attend un créneau libre. Le garde RAII le
    // libère automatiquement à la fin (succès / erreur / annulation).
    let _slot = acquire_slot(&state).await;

    let client = crate::commands::fetch::http_client();
    let tasks = state.tasks.clone();
    let mut downloaded = 0usize;

    for page in &pages {
        // Contrôle pause / annulation entre chaque page.
        loop {
            let status = tasks
                .lock()
                .unwrap()
                .get(&chapter_id)
                .map(|t| t.status.clone());
            match status {
                None => {
                    // Tâche annulée : on nettoie le dossier partiel.
                    let _ = std::fs::remove_dir_all(&base);
                    return Ok(());
                }
                Some(DownloadStatus::Paused) => {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    continue;
                }
                _ => break,
            }
        }

        match download_page(&app, &client, page, &base).await {
            Ok(()) => {
                downloaded += 1;
                set_status(&state, &chapter_id, DownloadStatus::Downloading, |t| {
                    t.progress = downloaded;
                });
                let _ = app.emit(
                    "download:progress",
                    ProgressEvent {
                        chapter_id: chapter_id.clone(),
                        progress: downloaded,
                        total,
                    },
                );
            }
            Err(e) => {
                set_status(&state, &chapter_id, DownloadStatus::Error, |t| {
                    t.error = Some(e.clone());
                });
                let _ = app.emit(
                    "download:error",
                    ErrorEvent {
                        chapter_id: chapter_id.clone(),
                        error: e.clone(),
                    },
                );
                return Err(e);
            }
        }
    }

    // meta.json
    let meta = serde_json::json!({
        "chapterId": chapter_id,
        "mangaId": manga_id,
        "sourceId": source_id,
        "pagesCount": total,
        "downloadedAt": now_secs(),
    });
    let _ = std::fs::write(
        base.join("meta.json"),
        serde_json::to_vec_pretty(&meta).unwrap_or_default(),
    );

    let local_path = base.to_string_lossy().to_string();
    set_status(&state, &chapter_id, DownloadStatus::Completed, |t| {
        t.local_path = Some(local_path.clone());
    });
    let _ = app.emit(
        "download:completed",
        CompletedEvent {
            chapter_id: chapter_id.clone(),
            local_path,
        },
    );

    Ok(())
}

/// Modifie la concurrence max de téléchargement à chaud (paramètres).
#[tauri::command]
pub async fn set_max_concurrent(
    value: usize,
    state: tauri::State<'_, Downloader>,
) -> Result<(), String> {
    *state.max_concurrent.lock().unwrap() = value.max(1);
    Ok(())
}

#[tauri::command]
pub async fn pause_download(
    chapter_id: String,
    state: tauri::State<'_, Downloader>,
) -> Result<(), String> {
    set_status(&state, &chapter_id, DownloadStatus::Paused, |_| {});
    Ok(())
}

#[tauri::command]
pub async fn resume_download(
    chapter_id: String,
    state: tauri::State<'_, Downloader>,
) -> Result<(), String> {
    set_status(&state, &chapter_id, DownloadStatus::Downloading, |_| {});
    Ok(())
}

#[tauri::command]
pub async fn cancel_download(
    chapter_id: String,
    state: tauri::State<'_, Downloader>,
) -> Result<(), String> {
    // Retirer la tâche suffit : la boucle de téléchargement détecte l'absence
    // et s'arrête (puis purge le dossier partiel).
    state.tasks.lock().unwrap().remove(&chapter_id);
    Ok(())
}

#[tauri::command]
pub async fn get_download_queue(
    state: tauri::State<'_, Downloader>,
) -> Result<Vec<DownloadTask>, String> {
    Ok(state.tasks.lock().unwrap().values().cloned().collect())
}

/// Renvoie le chemin local d'une page téléchargée si elle existe (sinon `None`).
/// Sert au lecteur pour servir l'image via le protocole asset au lieu du réseau.
#[tauri::command]
pub async fn get_local_page_path(
    source_id: String,
    manga_id: String,
    chapter_id: String,
    index: usize,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let Some(dir) = find_chapter_dir(&app, &source_id, &manga_id, &chapter_id).await else {
        return Ok(None);
    };
    let prefix = format!("{:03}.", index + 1);
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && !name.ends_with(".json") {
            return Ok(Some(entry.path().to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

/// Crée un fichier CBZ (ZIP renommé) des images du chapitre, dans l'ordre.
/// Écart vs. brief : ajout de `app`/`pool` pour localiser le dossier du
/// chapitre (le brief ne passait que `chapter_id` + `output_path`).
#[tauri::command]
pub async fn export_chapter_cbz(
    chapter_id: String,
    output_path: String,
    app: tauri::AppHandle,
    pool: tauri::State<'_, sqlx::SqlitePool>,
) -> Result<(), String> {
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT source_id, manga_id FROM chapters WHERE id = ?")
            .bind(&chapter_id)
            .fetch_optional(&*pool)
            .await
            .map_err(|e| e.to_string())?;
    let (source_id, manga_id) = row.ok_or_else(|| "chapitre introuvable".to_string())?;

    let dir = find_chapter_dir(&app, &source_id, &manga_id, &chapter_id)
        .await
        .ok_or_else(|| "chapitre non téléchargé".to_string())?;

    // Trie les images par nom (001, 002, …), ignore meta.json.
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .map(|x| x.to_string_lossy().to_lowercase() != "json")
                .unwrap_or(false)
        })
        .collect();
    files.sort();

    let file = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    use std::io::Write;
    for path in files {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// --- Chemins de stockage ----------------------------------------------------

/// Racine par défaut : `{APPDATA}/mangadesk/downloads`.
fn default_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("mangadesk")
        .join("downloads"))
}

/// Racine personnalisée (préférence `download_path`) si définie et non vide.
async fn custom_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    let pool = app.state::<sqlx::SqlitePool>();
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM preferences WHERE key = 'download_path'")
            .fetch_optional(&*pool)
            .await
            .ok()
            .flatten();
    row.map(|r| r.0)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
}

/// Racine où ÉCRIRE les nouveaux téléchargements (personnalisée sinon défaut).
async fn downloads_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(custom) = custom_root(app).await {
        return Ok(custom);
    }
    default_root(app)
}

/// Localise le dossier d'un chapitre pour la LECTURE : on teste la racine
/// personnalisée puis celle par défaut (robuste si le réglage a changé après
/// des téléchargements existants).
async fn find_chapter_dir(
    app: &tauri::AppHandle,
    source_id: &str,
    manga_id: &str,
    chapter_id: &str,
) -> Option<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(custom) = custom_root(app).await {
        roots.push(custom);
    }
    if let Ok(def) = default_root(app) {
        if !roots.contains(&def) {
            roots.push(def);
        }
    }
    for root in roots {
        let dir = chapter_dir(&root, source_id, manga_id, chapter_id);
        if dir.exists() {
            return Some(dir);
        }
    }
    None
}

/// Construit le dossier d'un chapitre en assainissant chaque composant. Les IDs
/// de source/manga/chapitre sont souvent des URLs ou slugs (Scan-Manga, www…)
/// contenant ':' '/' '?' etc., interdits dans un nom de dossier Windows (erreur
/// 267). Le MÊME assainissement sert à l'écriture et à la lecture, donc les
/// chapitres téléchargés restent retrouvables.
fn chapter_dir(root: &std::path::Path, source_id: &str, manga_id: &str, chapter_id: &str) -> PathBuf {
    root.join(sanitize_component(source_id))
        .join(sanitize_component(manga_id))
        .join(sanitize_component(chapter_id))
}

/// Rend une chaîne utilisable comme nom de dossier/fichier : remplace les
/// caractères interdits (`< > : " / \\ | ? *` et caractères de contrôle) par
/// '_', retire les points/espaces de fin (interdits par Windows), et borne la
/// longueur (suffixe de hachage pour rester unique sous la limite de chemin).
fn sanitize_component(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    if out.is_empty() {
        out.push('_');
    }
    if out.chars().count() > 80 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        s.hash(&mut h);
        let prefix: String = out.chars().take(48).collect();
        out = format!("{}_{:016x}", prefix, h.finish());
    }
    out
}

/// Autorise un dossier dans le scope du protocole asset, afin que le lecteur
/// puisse servir des images stockées hors `$APPDATA` (chemin personnalisé).
pub fn allow_download_dir(app: &tauri::AppHandle, path: &str) {
    if path.is_empty() {
        return;
    }
    let _ = app.asset_protocol_scope().allow_directory(path, true);
}

/// Définit le dossier de stockage : persiste la préférence et élargit le scope
/// asset (sinon le lecteur ne pourrait pas servir les images locales hors APPDATA).
#[tauri::command]
pub async fn set_download_path(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let pool = app.state::<sqlx::SqlitePool>();
    sqlx::query("INSERT OR REPLACE INTO preferences (key, value) VALUES ('download_path', ?)")
        .bind(&path)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    allow_download_dir(&app, &path);
    Ok(())
}

// --- Helpers ----------------------------------------------------------------

fn set_status(
    state: &tauri::State<'_, Downloader>,
    chapter_id: &str,
    status: DownloadStatus,
    mutate: impl FnOnce(&mut DownloadTask),
) {
    let mut tasks = state.tasks.lock().unwrap();
    if let Some(task) = tasks.get_mut(chapter_id) {
        task.status = status;
        mutate(task);
    }
}

/// Télécharge une page : d'abord `reqwest` (rapide), puis repli WebView (vrai
/// Chrome) si la requête directe échoue. Le repli couvre les CDN images derrière
/// Cloudflare (empreinte TLS), où `reqwest` est coupé au niveau connexion
/// (« error sending request ») — c'est exactement le chemin par lequel le lecteur
/// affiche déjà ces images (balise `<img>` servie par WebView2). Cf. mangasorigines.ts.
async fn download_page(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    page: &PageInfo,
    base: &std::path::Path,
) -> Result<(), String> {
    match download_page_direct(client, page, base).await {
        Ok(()) => Ok(()),
        Err(direct_err) => {
            // `Referer` interdit comme en-tête `fetch` → passé via l'option referrer.
            let referrer = page
                .headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("referer"))
                .map(|(_, v)| v.clone());
            let data_url = crate::commands::fetch::image_via_webview(app, &page.url, referrer, None)
                .await
                .map_err(|wv_err| format!("{} | repli WebView: {}", direct_err, wv_err))?;
            let (ext, bytes) = decode_data_url(&data_url)?;
            let filename = format!("{:03}.{}", page.index + 1, ext);
            std::fs::write(base.join(filename), &bytes).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

/// Téléchargement direct via `reqwest` (un User-Agent par défaut est ajouté si la
/// source n'en fournit pas, comme pour `fetch_image_as_base64`).
async fn download_page_direct(
    client: &reqwest::Client,
    page: &PageInfo,
    base: &std::path::Path,
) -> Result<(), String> {
    let mut req = client.get(&page.url);
    let mut has_ua = false;
    for (k, v) in &page.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            has_ua = true;
        }
        req = req.header(k, v);
    }
    if !has_ua {
        req = req.header(
            reqwest::header::USER_AGENT,
            crate::commands::fetch::APP_USER_AGENT,
        );
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let ext = ext_from_content_type(
        resp.headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        &page.url,
    );
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let filename = format!("{:03}.{}", page.index + 1, ext);
    std::fs::write(base.join(filename), &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

/// Décompose une data URL `data:<mime>;base64,<payload>` en (extension, octets).
fn decode_data_url(d: &str) -> Result<(&'static str, Vec<u8>), String> {
    use base64::Engine as _;
    let comma = d.find(',').ok_or("data URL invalide (pas de virgule)")?;
    let mime = d[..comma]
        .strip_prefix("data:")
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("");
    let ext = ext_from_content_type(Some(mime), "");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&d[comma + 1..])
        .map_err(|e| e.to_string())?;
    Ok((ext, bytes))
}

fn ext_from_content_type(content_type: Option<&str>, url: &str) -> &'static str {
    let ct = content_type.unwrap_or("").to_lowercase();
    if ct.contains("png") || url.to_lowercase().contains(".png") {
        "png"
    } else if ct.contains("webp") || url.to_lowercase().contains(".webp") {
        "webp"
    } else if ct.contains("gif") || url.to_lowercase().contains(".gif") {
        "gif"
    } else if ct.contains("avif") || url.to_lowercase().contains(".avif") {
        "avif"
    } else {
        "jpg"
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
