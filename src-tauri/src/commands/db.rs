use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use tauri::State;

// ============================================================================
// CRUD typé sur la base SQLite via sqlx (requêtes préparées, pas de
// concaténation SQL). Le pool est injecté depuis l'état Tauri (cf. main.rs).
// ============================================================================

#[derive(Serialize, Deserialize, FromRow)]
pub struct MangaRow {
    pub id: String,
    pub source_id: String,
    pub remote_id: String,
    pub title: String,
    pub cover_url: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub artist: Option<String>,
    pub status: Option<String>,
    pub genres: Option<String>,
    pub in_library: i64,
    pub date_added: Option<i64>,
    pub last_updated: Option<i64>,
}

#[derive(Serialize, Deserialize, FromRow)]
pub struct ChapterRow {
    pub id: String,
    pub manga_id: String,
    pub source_id: String,
    pub remote_id: String,
    pub number: f64,
    pub title: Option<String>,
    pub scanlator: Option<String>,
    pub date_upload: Option<i64>,
    pub is_read: i64,
    pub is_bookmarked: i64,
    pub last_page_read: i64,
    pub pages_count: Option<i64>,
    pub date_fetch: Option<i64>,
}

#[derive(Serialize, Deserialize, FromRow)]
pub struct CategoryRow {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub flags: i64,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Manga
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_library(pool: State<'_, SqlitePool>) -> Result<Vec<MangaRow>, String> {
    sqlx::query_as::<_, MangaRow>(
        "SELECT id, source_id, remote_id, title, cover_url, description, author, artist, \
         status, genres, in_library, date_added, last_updated \
         FROM manga WHERE in_library = 1 ORDER BY title COLLATE NOCASE",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_to_library(
    pool: State<'_, SqlitePool>,
    manga: MangaRow,
) -> Result<(), String> {
    // UPSERT plutôt que INSERT OR REPLACE : ce dernier fait DELETE + INSERT et
    // casse les FK des chapitres déjà liés. On force `in_library = 1` et on
    // préserve `date_added` si la ligne existait déjà (re-ajout sans reset).
    sqlx::query(
        "INSERT INTO manga \
         (id, source_id, remote_id, title, cover_url, description, author, artist, status, \
          genres, in_library, date_added, last_updated) \
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?) \
         ON CONFLICT(id) DO UPDATE SET \
           source_id = excluded.source_id, \
           remote_id = excluded.remote_id, \
           title = excluded.title, \
           cover_url = excluded.cover_url, \
           description = excluded.description, \
           author = excluded.author, \
           artist = excluded.artist, \
           status = excluded.status, \
           genres = excluded.genres, \
           in_library = 1, \
           date_added = COALESCE(manga.date_added, excluded.date_added), \
           last_updated = excluded.last_updated",
    )
    .bind(manga.id)
    .bind(manga.source_id)
    .bind(manga.remote_id)
    .bind(manga.title)
    .bind(manga.cover_url)
    .bind(manga.description)
    .bind(manga.author)
    .bind(manga.artist)
    .bind(manga.status)
    .bind(manga.genres)
    .bind(manga.date_added.unwrap_or_else(now_millis))
    .bind(manga.last_updated.unwrap_or_else(now_millis))
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persiste les métadonnées d'un manga sans changer `in_library`.
/// Appelé à l'ouverture de la fiche manga pour que `chapters` (FK manga_id) et
/// `history` (FK manga_id) puissent être insérés sans violer les FK, même si
/// l'utilisateur n'a pas (encore) ajouté le manga à sa bibliothèque.
#[tauri::command]
pub async fn upsert_manga(
    pool: State<'_, SqlitePool>,
    manga: MangaRow,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO manga \
         (id, source_id, remote_id, title, cover_url, description, author, artist, status, \
          genres, in_library, date_added, last_updated) \
         VALUES (?,?,?,?,?,?,?,?,?,?,0,NULL,?) \
         ON CONFLICT(id) DO UPDATE SET \
           source_id = excluded.source_id, \
           remote_id = excluded.remote_id, \
           title = excluded.title, \
           cover_url = excluded.cover_url, \
           description = excluded.description, \
           author = excluded.author, \
           artist = excluded.artist, \
           status = excluded.status, \
           genres = excluded.genres, \
           last_updated = excluded.last_updated",
    )
    .bind(manga.id)
    .bind(manga.source_id)
    .bind(manga.remote_id)
    .bind(manga.title)
    .bind(manga.cover_url)
    .bind(manga.description)
    .bind(manga.author)
    .bind(manga.artist)
    .bind(manga.status)
    .bind(manga.genres)
    .bind(manga.last_updated.unwrap_or_else(now_millis))
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn remove_from_library(
    pool: State<'_, SqlitePool>,
    manga_id: String,
) -> Result<(), String> {
    sqlx::query("UPDATE manga SET in_library = 0 WHERE id = ?")
        .bind(manga_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn update_manga(
    pool: State<'_, SqlitePool>,
    manga: MangaRow,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE manga SET source_id = ?, remote_id = ?, title = ?, cover_url = ?, \
         description = ?, author = ?, artist = ?, status = ?, genres = ?, in_library = ?, \
         date_added = ?, last_updated = ? WHERE id = ?",
    )
    .bind(manga.source_id)
    .bind(manga.remote_id)
    .bind(manga.title)
    .bind(manga.cover_url)
    .bind(manga.description)
    .bind(manga.author)
    .bind(manga.artist)
    .bind(manga.status)
    .bind(manga.genres)
    .bind(manga.in_library)
    .bind(manga.date_added)
    .bind(manga.last_updated)
    .bind(manga.id)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_chapters(
    pool: State<'_, SqlitePool>,
    manga_id: String,
) -> Result<Vec<ChapterRow>, String> {
    sqlx::query_as::<_, ChapterRow>(
        "SELECT id, manga_id, source_id, remote_id, number, title, scanlator, date_upload, \
         is_read, is_bookmarked, last_page_read, pages_count, date_fetch \
         FROM chapters WHERE manga_id = ? ORDER BY number DESC",
    )
    .bind(manga_id)
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

/// Insère les chapitres MANQUANTS d'un manga. NE TOUCHE PAS aux chapitres déjà
/// présents — c'est délibéré : un `INSERT OR REPLACE` écraserait `is_read`,
/// `last_page_read` et `is_bookmarked` à chaque rafraîchissement de la liste de
/// chapitres, ce qui ferait perdre la progression de lecture. Pour modifier un
/// chapitre déjà connu, utiliser `mark_chapter_read` / `update_chapter_progress`.
#[tauri::command]
pub async fn upsert_chapters(
    pool: State<'_, SqlitePool>,
    chapters: Vec<ChapterRow>,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for ch in chapters {
        sqlx::query(
            "INSERT OR IGNORE INTO chapters \
             (id, manga_id, source_id, remote_id, number, title, scanlator, date_upload, \
              is_read, is_bookmarked, last_page_read, pages_count, date_fetch) \
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(ch.id)
        .bind(ch.manga_id)
        .bind(ch.source_id)
        .bind(ch.remote_id)
        .bind(ch.number)
        .bind(ch.title)
        .bind(ch.scanlator)
        .bind(ch.date_upload)
        .bind(ch.is_read)
        .bind(ch.is_bookmarked)
        .bind(ch.last_page_read)
        .bind(ch.pages_count)
        .bind(ch.date_fetch)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn mark_chapter_read(
    pool: State<'_, SqlitePool>,
    chapter_id: String,
    last_page: i32,
) -> Result<(), String> {
    sqlx::query("UPDATE chapters SET is_read = 1, last_page_read = ? WHERE id = ?")
        .bind(last_page)
        .bind(chapter_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Sauvegarde la position de lecture SANS marquer le chapitre comme lu.
/// Permet la reprise (`is_read = 0` + `last_page_read > 0`) tant que la fin
/// n'est pas atteinte (cf. `mark_chapter_read` pour la complétion).
#[tauri::command]
pub async fn update_chapter_progress(
    pool: State<'_, SqlitePool>,
    chapter_id: String,
    last_page: i32,
) -> Result<(), String> {
    sqlx::query("UPDATE chapters SET last_page_read = ? WHERE id = ?")
        .bind(last_page)
        .bind(chapter_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_categories(pool: State<'_, SqlitePool>) -> Result<Vec<CategoryRow>, String> {
    sqlx::query_as::<_, CategoryRow>(
        "SELECT id, name, sort_order, flags FROM categories ORDER BY sort_order, name COLLATE NOCASE",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_category(
    pool: State<'_, SqlitePool>,
    name: String,
) -> Result<CategoryRow, String> {
    let result = sqlx::query("INSERT INTO categories (name) VALUES (?)")
        .bind(&name)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    let id = result.last_insert_rowid();
    sqlx::query_as::<_, CategoryRow>(
        "SELECT id, name, sort_order, flags FROM categories WHERE id = ?",
    )
    .bind(id)
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_category(pool: State<'_, SqlitePool>, id: i32) -> Result<(), String> {
    sqlx::query("DELETE FROM categories WHERE id = ?")
        .bind(id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MangaCategoryAssoc {
    pub manga_id: String,
    pub category_id: i64,
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct UnreadCount {
    pub manga_id: String,
    pub unread: i64,
}

/// Nombre de chapitres non lus par manga (in_library = 1 uniquement).
/// Le store frontend construit la Map<mangaId, count> à partir de ce résultat
/// pour afficher le badge de chaque carte de bibliothèque.
#[tauri::command]
pub async fn get_unread_counts(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<UnreadCount>, String> {
    sqlx::query_as::<_, UnreadCount>(
        "SELECT c.manga_id AS manga_id, COUNT(*) AS unread \
         FROM chapters c JOIN manga m ON c.manga_id = m.id \
         WHERE m.in_library = 1 AND c.is_read = 0 \
         GROUP BY c.manga_id",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

/// Toutes les associations manga ↔ catégorie. Le store frontend construit la
/// Map<mangaId, categoryIds[]> à partir de ce résultat (cf. bug 2 :
/// `mangaCategories` n'était jamais peuplée → filtrage par catégorie vide).
#[tauri::command]
pub async fn get_manga_categories(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MangaCategoryAssoc>, String> {
    sqlx::query_as::<_, MangaCategoryAssoc>(
        "SELECT manga_id, category_id FROM manga_categories",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_manga_categories(
    pool: State<'_, SqlitePool>,
    manga_id: String,
    category_ids: Vec<i32>,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM manga_categories WHERE manga_id = ?")
        .bind(&manga_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    for category_id in category_ids {
        sqlx::query(
            "INSERT OR IGNORE INTO manga_categories (manga_id, category_id) VALUES (?, ?)",
        )
        .bind(&manga_id)
        .bind(category_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Réordonne les catégories : `sort_order` = position dans `ids` (0-indexé).
#[tauri::command]
pub async fn reorder_categories(
    pool: State<'_, SqlitePool>,
    ids: Vec<i32>,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    for (index, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE categories SET sort_order = ? WHERE id = ?")
            .bind(index as i64)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn add_history_entry(
    pool: State<'_, SqlitePool>,
    chapter_id: String,
    manga_id: String,
    duration: Option<i32>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO history (chapter_id, manga_id, last_read, read_duration) VALUES (?,?,?,?)",
    )
    .bind(chapter_id)
    .bind(manga_id)
    .bind(now_millis())
    .bind(duration)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub chapter_id: String,
    pub manga_id: String,
    pub last_read: i64,
    pub number: f64,
    pub chapter_title: Option<String>,
    pub manga_title: String,
    pub cover_url: Option<String>,
    pub source_id: String,
}

/// Historique de lecture (dédoublonné par chapitre, plus récent d'abord).
#[tauri::command]
pub async fn get_history(
    pool: State<'_, SqlitePool>,
    limit: Option<i64>,
) -> Result<Vec<HistoryRow>, String> {
    sqlx::query_as::<_, HistoryRow>(
        "SELECT h.chapter_id, h.manga_id, MAX(h.last_read) AS last_read, \
         c.number, c.title AS chapter_title, m.title AS manga_title, m.cover_url, m.source_id \
         FROM history h \
         JOIN chapters c ON h.chapter_id = c.id \
         JOIN manga m ON h.manga_id = m.id \
         GROUP BY h.chapter_id ORDER BY last_read DESC LIMIT ?",
    )
    .bind(limit.unwrap_or(200))
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MangaHistoryEntry {
    pub manga_id: String,
    pub manga_title: String,
    pub cover_url: Option<String>,
    pub source_id: String,
    pub last_read: i64,
    pub last_chapter_number: Option<f64>,
    pub total_seconds: i64,
}

/// Historique agrégé par manga (session 5A — bug 5). Une entrée = un manga,
/// avec son dernier chapitre lu, le temps total cumulé (depuis reading_stats)
/// et la date du dernier accès. Plus récent d'abord.
#[tauri::command]
pub async fn get_history_by_manga(
    pool: State<'_, SqlitePool>,
    limit: Option<i64>,
) -> Result<Vec<MangaHistoryEntry>, String> {
    sqlx::query_as::<_, MangaHistoryEntry>(
        "SELECT \
           m.id AS manga_id, \
           m.title AS manga_title, \
           m.cover_url AS cover_url, \
           m.source_id AS source_id, \
           MAX(h.last_read) AS last_read, \
           ( \
             SELECT c.number FROM chapters c \
             JOIN history h2 ON h2.chapter_id = c.id \
             WHERE h2.manga_id = m.id \
             ORDER BY h2.last_read DESC LIMIT 1 \
           ) AS last_chapter_number, \
           COALESCE(rs.total_seconds, 0) AS total_seconds \
         FROM history h \
         JOIN manga m ON h.manga_id = m.id \
         LEFT JOIN reading_stats rs ON rs.manga_id = m.id \
         GROUP BY m.id \
         ORDER BY last_read DESC LIMIT ?",
    )
    .bind(limit.unwrap_or(500))
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

/// Réinitialise toutes les traces de lecture d'un manga (history, stats, état
/// des chapitres) SANS le retirer de la bibliothèque (cf. bug 5). Atomique.
#[tauri::command]
pub async fn reset_manga_reading_data(
    pool: State<'_, SqlitePool>,
    manga_id: String,
) -> Result<(), String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM history WHERE manga_id = ?")
        .bind(&manga_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM reading_stats WHERE manga_id = ?")
        .bind(&manga_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE chapters SET is_read = 0, last_page_read = 0 WHERE manga_id = ?",
    )
    .bind(&manga_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_preference(
    pool: State<'_, SqlitePool>,
    key: String,
) -> Result<Option<String>, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM preferences WHERE key = ?")
        .bind(key)
        .fetch_optional(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.map(|r| r.0))
}

#[tauri::command]
pub async fn set_preference(
    pool: State<'_, SqlitePool>,
    key: String,
    value: String,
) -> Result<(), String> {
    sqlx::query("INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)")
        .bind(key)
        .bind(value)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Mises à jour (page Updates) + badge sidebar
// ---------------------------------------------------------------------------

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RecentUpdateRow {
    pub id: String,
    pub manga_id: String,
    pub number: f64,
    pub title: Option<String>,
    pub is_read: i64,
    pub date_fetch: Option<i64>,
    pub manga_title: String,
    pub cover_url: Option<String>,
    pub source_id: String,
}

#[tauri::command]
pub async fn get_recent_updates(
    pool: State<'_, SqlitePool>,
    limit: Option<i64>,
) -> Result<Vec<RecentUpdateRow>, String> {
    // Bug 3 : on n'affiche QUE les chapitres apparus APRÈS la date d'ajout du
    // manga à la bibliothèque. Tous les chapitres déjà présents au moment de
    // l'ajout (peuplés en masse par MangaDetail.upsert_chapters) ne sont PAS
    // des « nouveautés » du point de vue de l'utilisateur.
    sqlx::query_as::<_, RecentUpdateRow>(
        "SELECT c.id, c.manga_id, c.number, c.title, c.is_read, c.date_fetch, \
         m.title AS manga_title, m.cover_url, c.source_id \
         FROM chapters c JOIN manga m ON c.manga_id = m.id \
         WHERE m.in_library = 1 \
           AND c.date_fetch IS NOT NULL \
           AND COALESCE(m.date_added, 0) < c.date_fetch \
         ORDER BY c.date_fetch DESC LIMIT ?",
    )
    .bind(limit.unwrap_or(200))
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

/// Nombre de chapitres non lus récupérés depuis un timestamp (badge sidebar).
/// Filtre cohérent avec `get_recent_updates` : on ne compte que les chapitres
/// apparus APRÈS l'ajout du manga (bug 3).
#[tauri::command]
pub async fn get_new_chapter_count(
    pool: State<'_, SqlitePool>,
    since: i64,
) -> Result<i64, String> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM chapters c JOIN manga m ON c.manga_id = m.id \
         WHERE m.in_library = 1 AND c.is_read = 0 \
           AND COALESCE(c.date_fetch, 0) >= ? \
           AND COALESCE(m.date_added, 0) < c.date_fetch",
    )
    .bind(since)
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.0)
}

// ---------------------------------------------------------------------------
// Téléchargements (persistance des états + badges bibliothèque)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn record_download(
    pool: State<'_, SqlitePool>,
    chapter_id: String,
    manga_id: String,
    status: String,
    total_pages: Option<i64>,
    local_path: Option<String>,
) -> Result<(), String> {
    sqlx::query(
        "INSERT INTO downloads \
         (chapter_id, manga_id, status, progress, total_pages, local_path, created_at, updated_at) \
         VALUES (?,?,?,0,?,?,?,?) \
         ON CONFLICT DO NOTHING",
    )
    .bind(&chapter_id)
    .bind(&manga_id)
    .bind(&status)
    .bind(total_pages)
    .bind(&local_path)
    .bind(now_millis())
    .bind(now_millis())
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    // Met à jour si déjà présent (l'INSERT ci-dessus n'écrase pas).
    sqlx::query(
        "UPDATE downloads SET status = ?, local_path = COALESCE(?, local_path), updated_at = ? \
         WHERE chapter_id = ?",
    )
    .bind(&status)
    .bind(&local_path)
    .bind(now_millis())
    .bind(&chapter_id)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_downloaded_chapter_ids(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<String>, String> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT chapter_id FROM downloads WHERE status = 'completed'")
            .fetch_all(&*pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

#[tauri::command]
pub async fn get_downloaded_manga_ids(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<String>, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT manga_id FROM downloads WHERE status = 'completed'",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}

#[tauri::command]
pub async fn delete_download(
    pool: State<'_, SqlitePool>,
    chapter_id: String,
) -> Result<(), String> {
    sqlx::query("DELETE FROM downloads WHERE chapter_id = ?")
        .bind(chapter_id)
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Sauvegarde / restauration (JSON)
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, FromRow)]
struct PrefRow {
    key: String,
    value: String,
}

#[derive(Serialize, Deserialize, FromRow)]
struct MangaCategoryRow {
    manga_id: String,
    category_id: i64,
}

#[derive(Serialize, Deserialize)]
struct BackupData {
    manga: Vec<MangaRow>,
    chapters: Vec<ChapterRow>,
    categories: Vec<CategoryRow>,
    manga_categories: Vec<MangaCategoryRow>,
    preferences: Vec<PrefRow>,
}

#[derive(Serialize, Deserialize)]
struct Backup {
    version: String,
    exported_at: i64,
    data: BackupData,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub mangas_imported: usize,
    pub chapters_updated: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn export_backup(
    pool: State<'_, SqlitePool>,
    output_path: String,
) -> Result<(), String> {
    let manga = sqlx::query_as::<_, MangaRow>(
        "SELECT id, source_id, remote_id, title, cover_url, description, author, artist, \
         status, genres, in_library, date_added, last_updated FROM manga WHERE in_library = 1",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    let chapters = sqlx::query_as::<_, ChapterRow>(
        "SELECT id, manga_id, source_id, remote_id, number, title, scanlator, date_upload, \
         is_read, is_bookmarked, last_page_read, pages_count, date_fetch FROM chapters",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    let categories = sqlx::query_as::<_, CategoryRow>(
        "SELECT id, name, sort_order, flags FROM categories",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    let manga_categories = sqlx::query_as::<_, MangaCategoryRow>(
        "SELECT manga_id, category_id FROM manga_categories",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())?;

    let preferences =
        sqlx::query_as::<_, PrefRow>("SELECT key, value FROM preferences")
            .fetch_all(&*pool)
            .await
            .map_err(|e| e.to_string())?;

    let backup = Backup {
        version: "1.0".into(),
        exported_at: now_millis(),
        data: BackupData {
            manga,
            chapters,
            categories,
            manga_categories,
            preferences,
        },
    };
    let json = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
    std::fs::write(&output_path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn import_backup(
    pool: State<'_, SqlitePool>,
    file_path: String,
) -> Result<ImportResult, String> {
    let raw = std::fs::read_to_string(&file_path).map_err(|e| e.to_string())?;
    let backup: Backup = serde_json::from_str(&raw).map_err(|e| e.to_string())?;

    let mut result = ImportResult {
        mangas_imported: 0,
        chapters_updated: 0,
        errors: Vec::new(),
    };

    for m in backup.data.manga {
        // Ne pas écraser un manga déjà en bibliothèque localement.
        let local: Option<(i64,)> =
            sqlx::query_as("SELECT in_library FROM manga WHERE id = ?")
                .bind(&m.id)
                .fetch_optional(&*pool)
                .await
                .map_err(|e| e.to_string())?;
        if matches!(local, Some((1,))) {
            continue;
        }
        let res = sqlx::query(
            "INSERT OR REPLACE INTO manga \
             (id, source_id, remote_id, title, cover_url, description, author, artist, status, \
              genres, in_library, date_added, last_updated) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)",
        )
        .bind(&m.id)
        .bind(&m.source_id)
        .bind(&m.remote_id)
        .bind(&m.title)
        .bind(&m.cover_url)
        .bind(&m.description)
        .bind(&m.author)
        .bind(&m.artist)
        .bind(&m.status)
        .bind(&m.genres)
        .bind(m.date_added)
        .bind(m.last_updated)
        .execute(&*pool)
        .await;
        match res {
            Ok(_) => result.mangas_imported += 1,
            Err(e) => result.errors.push(format!("manga {}: {}", m.id, e)),
        }
    }

    for c in backup.data.chapters {
        // is_read / last_page_read seulement si la valeur importée est supérieure.
        let res = sqlx::query(
            "UPDATE chapters SET \
             is_read = MAX(is_read, ?), \
             last_page_read = MAX(last_page_read, ?) WHERE id = ?",
        )
        .bind(c.is_read)
        .bind(c.last_page_read)
        .bind(&c.id)
        .execute(&*pool)
        .await;
        match res {
            Ok(r) if r.rows_affected() > 0 => result.chapters_updated += 1,
            Ok(_) => {}
            Err(e) => result.errors.push(format!("chapitre {}: {}", c.id, e)),
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------------------
// Statistiques de lecture (session 4B)
// ---------------------------------------------------------------------------

/// Met à jour les stats cumulées pour un manga : durée additionnelle + 1 chapitre.
/// Crée la ligne au premier appel (`INSERT … ON CONFLICT DO UPDATE`).
#[tauri::command]
pub async fn update_reading_stats(
    pool: State<'_, SqlitePool>,
    manga_id: String,
    seconds: i64,
) -> Result<(), String> {
    let now = now_millis();
    sqlx::query(
        "INSERT INTO reading_stats (manga_id, total_seconds, chapters_read, last_read) \
         VALUES (?, ?, 1, ?) \
         ON CONFLICT(manga_id) DO UPDATE SET \
           total_seconds = reading_stats.total_seconds + excluded.total_seconds, \
           chapters_read = reading_stats.chapters_read + 1, \
           last_read = excluded.last_read",
    )
    .bind(&manga_id)
    .bind(seconds.max(0))
    .bind(now)
    .execute(&*pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct MangaReadingStats {
    pub id: String,
    pub title: String,
    pub cover_url: Option<String>,
    pub source_id: String,
    pub total_seconds: i64,
    pub chapters_read: i64,
    pub last_read: Option<i64>,
}

/// Classement par temps de lecture (toujours sur la bibliothèque active).
#[tauri::command]
pub async fn get_reading_stats(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<MangaReadingStats>, String> {
    sqlx::query_as::<_, MangaReadingStats>(
        // Tout manga réellement lu (ligne reading_stats présente), qu'il soit
        // en bibliothèque ou simplement lu depuis Browse. On part de
        // reading_stats pour ne pas dépendre de in_library.
        "SELECT m.id, m.title, m.cover_url, m.source_id, \
                COALESCE(rs.total_seconds, 0) AS total_seconds, \
                COALESCE(rs.chapters_read, 0) AS chapters_read, \
                rs.last_read \
         FROM reading_stats rs JOIN manga m ON m.id = rs.manga_id \
         ORDER BY total_seconds DESC, m.title COLLATE NOCASE",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct GlobalStats {
    pub active_mangas: i64,
    pub total_chapters: i64,
    pub total_seconds: i64,
}

#[tauri::command]
pub async fn get_global_stats(pool: State<'_, SqlitePool>) -> Result<GlobalStats, String> {
    sqlx::query_as::<_, GlobalStats>(
        "SELECT \
           COUNT(DISTINCT manga_id) AS active_mangas, \
           COALESCE(SUM(chapters_read), 0) AS total_chapters, \
           COALESCE(SUM(total_seconds), 0) AS total_seconds \
         FROM reading_stats",
    )
    .fetch_one(&*pool)
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Migration de manga entre sources (session 4B)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterMapping {
    pub source_chapter_id: String,
    pub target_chapter_id: Option<String>,
    pub is_read: i64,
    pub last_page_read: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub chapters_migrated: usize,
    pub chapters_not_found: usize,
    pub history_entries_migrated: usize,
}

/// Migre un manga vers une autre source : insère le manga cible (in_library = 1),
/// transfère lu/last_page_read par numéro de chapitre, copie history,
/// reading_stats et manga_categories, puis retire la source de la bibliothèque
/// (in_library = 0 sans DELETE pour ne pas casser les FK des chapitres existants).
/// Le tout dans une transaction unique : rollback automatique si une étape échoue.
#[tauri::command]
pub async fn migrate_manga(
    pool: State<'_, SqlitePool>,
    source_manga_id: String,
    target_manga: MangaRow,
    chapter_mapping: Vec<ChapterMapping>,
    reading_stats: bool,
) -> Result<MigrationResult, String> {
    let mut tx = pool.begin().await.map_err(|e| e.to_string())?;
    let now = now_millis();
    let target_id = target_manga.id.clone();

    // 1. Upsert du manga cible (in_library = 1, préserve date_added si déjà là).
    sqlx::query(
        "INSERT INTO manga \
         (id, source_id, remote_id, title, cover_url, description, author, artist, status, \
          genres, in_library, date_added, last_updated) \
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?) \
         ON CONFLICT(id) DO UPDATE SET \
           source_id = excluded.source_id, \
           remote_id = excluded.remote_id, \
           title = excluded.title, \
           cover_url = excluded.cover_url, \
           description = excluded.description, \
           author = excluded.author, \
           artist = excluded.artist, \
           status = excluded.status, \
           genres = excluded.genres, \
           in_library = 1, \
           date_added = COALESCE(manga.date_added, excluded.date_added), \
           last_updated = excluded.last_updated",
    )
    .bind(&target_manga.id)
    .bind(&target_manga.source_id)
    .bind(&target_manga.remote_id)
    .bind(&target_manga.title)
    .bind(&target_manga.cover_url)
    .bind(&target_manga.description)
    .bind(&target_manga.author)
    .bind(&target_manga.artist)
    .bind(&target_manga.status)
    .bind(&target_manga.genres)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    // 2. Transfert des chapitres mappés (lu + page) via UPSERT sur la cible.
    let mut chapters_migrated = 0usize;
    let mut chapters_not_found = 0usize;
    let mut source_to_target: Vec<(String, String)> = Vec::new();
    for m in &chapter_mapping {
        match &m.target_chapter_id {
            None => chapters_not_found += 1,
            Some(target_chapter_id) => {
                sqlx::query(
                    "UPDATE chapters SET \
                       is_read = MAX(is_read, ?), \
                       last_page_read = MAX(last_page_read, ?) \
                     WHERE id = ?",
                )
                .bind(m.is_read)
                .bind(m.last_page_read)
                .bind(target_chapter_id)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;
                chapters_migrated += 1;
                source_to_target.push((m.source_chapter_id.clone(), target_chapter_id.clone()));
            }
        }
    }

    // 3. reading_stats : addition (le manga cible peut déjà en avoir).
    if reading_stats {
        sqlx::query(
            "INSERT INTO reading_stats (manga_id, total_seconds, chapters_read, last_read) \
             SELECT ?, total_seconds, chapters_read, last_read FROM reading_stats WHERE manga_id = ? \
             ON CONFLICT(manga_id) DO UPDATE SET \
               total_seconds = reading_stats.total_seconds + excluded.total_seconds, \
               chapters_read = reading_stats.chapters_read + excluded.chapters_read, \
               last_read = MAX(COALESCE(reading_stats.last_read, 0), COALESCE(excluded.last_read, 0))",
        )
        .bind(&target_id)
        .bind(&source_manga_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    // 4. history : duplique chaque entrée source avec les ids cibles.
    let mut history_entries_migrated = 0usize;
    for (src_ch, tgt_ch) in &source_to_target {
        let res = sqlx::query(
            "INSERT INTO history (chapter_id, manga_id, last_read, read_duration) \
             SELECT ?, ?, last_read, read_duration FROM history \
             WHERE chapter_id = ? AND manga_id = ?",
        )
        .bind(tgt_ch)
        .bind(&target_id)
        .bind(src_ch)
        .bind(&source_manga_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        history_entries_migrated += res.rows_affected() as usize;
    }

    // 5. manga_categories : recopie sur le manga cible.
    sqlx::query(
        "INSERT OR IGNORE INTO manga_categories (manga_id, category_id) \
         SELECT ?, category_id FROM manga_categories WHERE manga_id = ?",
    )
    .bind(&target_id)
    .bind(&source_manga_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    // 6. Retire le manga source de la bibliothèque (pas de DELETE → FK chapitres).
    sqlx::query("UPDATE manga SET in_library = 0 WHERE id = ?")
        .bind(&source_manga_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(MigrationResult {
        chapters_migrated,
        chapters_not_found,
        history_entries_migrated,
    })
}

// ---------------------------------------------------------------------------
// Avancé : purge de la base
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn purge_database(pool: State<'_, SqlitePool>) -> Result<(), String> {
    let drops = [
        "DROP TABLE IF EXISTS reading_stats",
        "DROP TABLE IF EXISTS manga_tracking",
        "DROP TABLE IF EXISTS downloads",
        "DROP TABLE IF EXISTS history",
        "DROP TABLE IF EXISTS manga_categories",
        "DROP TABLE IF EXISTS categories",
        "DROP TABLE IF EXISTS chapters",
        "DROP TABLE IF EXISTS manga",
        "DROP TABLE IF EXISTS preferences",
        "DROP TABLE IF EXISTS sources",
    ];
    for stmt in drops {
        sqlx::query(stmt)
            .execute(&*pool)
            .await
            .map_err(|e| e.to_string())?;
    }
    sqlx::raw_sql(include_str!("../../migrations/001_init.sql"))
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::raw_sql(include_str!("../../migrations/002_tracking.sql"))
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::raw_sql(include_str!("../../migrations/003_features.sql"))
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    // ⚠️ Rejouer TOUTES les migrations : la 004 (index date_added) manquait
    // ici (review S13) — après une purge, l'index disparaissait jusqu'au
    // prochain démarrage de l'app.
    sqlx::raw_sql(include_str!("../../migrations/004_date_added_index.sql"))
        .execute(&*pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Calendrier des chapitres (session 13 bis) — matière première du pronostic.
// ============================================================================

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ChapterScheduleRow {
    pub manga_id: String,
    pub remote_id: String,
    pub source_id: String,
    pub title: String,
    pub cover_url: Option<String>,
    pub status: Option<String>,
    pub number: f64,
    pub date_upload: i64,
}

/// Dates des 12 derniers chapitres datés de chaque manga de la bibliothèque
/// (séries non terminées/annulées). Le frontend en déduit la cadence de
/// parution et la date estimée du prochain chapitre (lib/chapterSchedule.ts).
#[tauri::command]
pub async fn get_chapter_schedule(
    pool: State<'_, SqlitePool>,
) -> Result<Vec<ChapterScheduleRow>, String> {
    sqlx::query_as::<_, ChapterScheduleRow>(
        "SELECT manga_id, remote_id, source_id, title, cover_url, status, number, date_upload \
         FROM ( \
           SELECT m.id AS manga_id, m.remote_id, m.source_id, m.title, m.cover_url, m.status, \
                  c.number, c.date_upload, \
                  ROW_NUMBER() OVER ( \
                    PARTITION BY m.id ORDER BY c.date_upload DESC, c.number DESC \
                  ) AS rn \
           FROM manga m \
           JOIN chapters c ON c.manga_id = m.id \
           WHERE m.in_library = 1 \
             AND COALESCE(c.date_upload, 0) > 0 \
             AND COALESCE(m.status, 'unknown') NOT IN ('completed', 'cancelled') \
         ) \
         WHERE rn <= 12 \
         ORDER BY manga_id, date_upload DESC",
    )
    .fetch_all(&*pool)
    .await
    .map_err(|e| e.to_string())
}
