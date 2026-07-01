// ============================================================================
// Mises à jour automatiques.
//
// Respect du contrat « Rust n'appelle jamais une source directement » :
//   timer Tokio → emit `updater:check` (liste { mangaId, sourceId })
//     → frontend appelle source.getChapterList → `report_chapter_update`
//       → Rust compare/insère en base, notifie, emit `updater:done`.
// ============================================================================

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

/// Intervalle (heures) partagé, modifiable depuis les paramètres. `0` = jamais.
pub struct UpdaterState {
    pub interval_hours: Arc<Mutex<u64>>,
}

impl UpdaterState {
    pub fn new(interval_hours: u64) -> Self {
        Self {
            interval_hours: Arc::new(Mutex::new(interval_hours)),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckTarget {
    manga_id: String,
    source_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoneEvent {
    new_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub new_count: usize,
    pub inserted_ids: Vec<String>,
}

/// Chapitre tel que fourni par le frontend (`source.getChapterList`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingChapter {
    pub id: String,
    pub number: f64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub scanlator: Option<String>,
    #[serde(default)]
    pub date_upload: Option<i64>,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Boucle de fond : émet `updater:check` toutes les `interval_hours` heures.
/// `interval` est le même `Arc` que celui géré dans l'état Tauri, afin que
/// `set_update_interval` (paramètres) modifie la boucle en vol.
pub fn start_update_loop(app: tauri::AppHandle, interval: Arc<Mutex<u64>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let hours = *interval.lock().unwrap();
            // « Jamais » : on dort 1 h et on revérifie le réglage sans émettre.
            let sleep_hours = if hours == 0 { 1 } else { hours };
            tokio::time::sleep(Duration::from_secs(sleep_hours * 3600)).await;
            if *interval.lock().unwrap() == 0 {
                continue;
            }
            emit_check(&app).await;
        }
    });
}

async fn emit_check(app: &tauri::AppHandle) {
    let pool = app.state::<SqlitePool>();
    let targets: Vec<(String, String)> =
        sqlx::query_as("SELECT id, source_id FROM manga WHERE in_library = 1")
            .fetch_all(&*pool)
            .await
            .unwrap_or_default();
    let payload: Vec<CheckTarget> = targets
        .into_iter()
        .map(|(manga_id, source_id)| CheckTarget {
            manga_id,
            source_id,
        })
        .collect();
    let _ = app.emit("updater:check", payload);
}

#[tauri::command]
pub async fn trigger_update_now(app: tauri::AppHandle) -> Result<(), String> {
    emit_check(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn set_update_interval(
    hours: u64,
    state: tauri::State<'_, UpdaterState>,
) -> Result<(), String> {
    *state.interval_hours.lock().unwrap() = hours;
    Ok(())
}

#[tauri::command]
pub async fn report_chapter_update(
    manga_id: String,
    chapters: Vec<IncomingChapter>,
    app: tauri::AppHandle,
) -> Result<UpdateReport, String> {
    let pool = app.state::<SqlitePool>();

    // source_id du manga (les chapitres en base le requièrent).
    let source_id: Option<(String,)> = sqlx::query_as("SELECT source_id FROM manga WHERE id = ?")
        .bind(&manga_id)
        .fetch_optional(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    let source_id = source_id.map(|r| r.0).unwrap_or_default();

    // Chapitres déjà connus.
    let existing: Vec<(String,)> = sqlx::query_as("SELECT id FROM chapters WHERE manga_id = ?")
        .bind(&manga_id)
        .fetch_all(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    let known: std::collections::HashSet<String> = existing.into_iter().map(|r| r.0).collect();

    let mut inserted_ids = Vec::new();
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for ch in &chapters {
        if known.contains(&ch.id) {
            continue;
        }
        sqlx::query(
            "INSERT INTO chapters \
             (id, manga_id, source_id, remote_id, number, title, scanlator, date_upload, \
              is_read, is_bookmarked, last_page_read, pages_count, date_fetch) \
             VALUES (?,?,?,?,?,?,?,?,0,0,0,NULL,?)",
        )
        .bind(&ch.id)
        .bind(&manga_id)
        .bind(&source_id)
        .bind(&ch.id)
        .bind(ch.number)
        .bind(&ch.title)
        .bind(&ch.scanlator)
        .bind(ch.date_upload)
        .bind(now_millis())
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        inserted_ids.push(ch.id.clone());
    }
    // Touche last_updated du manga si nouveautés.
    if !inserted_ids.is_empty() {
        let _ = sqlx::query("UPDATE manga SET last_updated = ? WHERE id = ?")
            .bind(now_millis())
            .bind(&manga_id)
            .execute(&mut *tx)
            .await;
    }
    tx.commit().await.map_err(|e| e.to_string())?;

    let new_count = inserted_ids.len();
    if new_count > 0 {
        let _ = app
            .notification()
            .builder()
            .title("MangaDesk")
            .body(format!("{} nouveau(x) chapitre(s) disponible(s)", new_count))
            .show();
    }
    let _ = app.emit("updater:done", DoneEvent { new_count });

    Ok(UpdateReport {
        new_count,
        inserted_ids,
    })
}
