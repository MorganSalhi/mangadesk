// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod commands;
mod downloader;
mod updater;

use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_sql::{Migration, MigrationKind};

fn main() {
    // Migrations gérées par tauri-plugin-sql (expose aussi la base au frontend
    // via @tauri-apps/plugin-sql). Toute migration future = nouvelle version.
    let migrations = vec![
        Migration {
            version: 1,
            description: "init",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "tracking",
            sql: include_str!("../migrations/002_tracking.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "features",
            sql: include_str!("../migrations/003_features.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "date_added_index",
            sql: include_str!("../migrations/004_date_added_index.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        // ⚠️ DOIT être enregistré en premier. Sur Windows/Linux, le deep link
        // arrive comme argument d'un nouveau processus ; ce plugin (feature
        // "deep-link") le route vers l'instance déjà lancée — celle qui détient
        // le code_verifier PKCE — et déclenche son `on_open_url`.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:mangadesk.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        // Mise à jour automatique de l'app (vérif/téléchargement/installation des
        // releases signées) + relance après installation.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Pool sqlx partagé, utilisé par les commandes db.rs. Pointé sur le
            // dossier de config de l'app ; le schéma est garanti via les
            // migrations rejouées (idempotentes : CREATE TABLE IF NOT EXISTS).
            let dir = app
                .path()
                .app_config_dir()
                .expect("dossier de configuration introuvable");
            std::fs::create_dir_all(&dir).expect("création du dossier de config impossible");
            let db_path = dir.join("mangadesk.db");

            let pool = tauri::async_runtime::block_on(async move {
                let options = SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true);
                let pool = SqlitePool::connect_with(options)
                    .await
                    .expect("connexion SQLite échouée");
                sqlx::raw_sql(include_str!("../migrations/001_init.sql"))
                    .execute(&pool)
                    .await
                    .expect("initialisation du schéma (001) échouée");
                sqlx::raw_sql(include_str!("../migrations/002_tracking.sql"))
                    .execute(&pool)
                    .await
                    .expect("initialisation du schéma (002) échouée");
                sqlx::raw_sql(include_str!("../migrations/003_features.sql"))
                    .execute(&pool)
                    .await
                    .expect("initialisation du schéma (003) échouée");
                sqlx::raw_sql(include_str!("../migrations/004_date_added_index.sql"))
                    .execute(&pool)
                    .await
                    .expect("initialisation du schéma (004) échouée");

                // Seed des sources intégrées. Les tables `manga`/`chapters`/
                // `history` référencent `sources.id` (FK) — sans ces lignes,
                // tous les INSERT côté bibliothèque/lecture échouent en silence
                // et l'app oublie aussitôt les ajouts.
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let _ = sqlx::query(
                    "INSERT OR IGNORE INTO sources \
                     (id, name, lang, base_url, version, is_nsfw, installed_at) \
                     VALUES \
                       ('mangadex', 'MangaDex', 'en', 'https://mangadex.org', '1.0.0', 0, ?), \
                       ('lelmanga', 'LelManga', 'fr', 'https://www.lelmanga.com', '1.0.0', 0, ?), \
                       ('demonicscans', 'DemonicScans', 'en', 'https://demonicscans.org', '1.0.0', 0, ?), \
                       ('mangasorigines', 'Mangas Origines', 'fr', 'https://mangas-origines.fr', '1.0.0', 0, ?), \
                       ('pantheonscan', 'Pantheon Scan', 'fr', 'https://pantheon-scan.com', '1.0.0', 1, ?), \
                       ('mangascantrad', 'Manga-Scantrad', 'fr', 'https://manga-scantrad.io', '1.0.0', 1, ?), \
                       ('sushiscan', 'Sushi-Scan', 'fr', 'https://sushiscan.net', '1.0.0', 1, ?), \
                       ('scanmanga', 'Scan-Manga', 'fr', 'https://m.scan-manga.com', '1.0.0', 1, ?)",
                )
                .bind(now)
                .bind(now)
                .bind(now)
                .bind(now)
                .bind(now)
                .bind(now)
                .bind(now)
                .bind(now)
                .execute(&pool)
                .await;

                pool
            });

            app.manage(pool);

            // Téléchargements : file partagée + limite de concurrence.
            app.manage(downloader::Downloader::new(3));

            // Restaure le scope asset si un dossier de téléchargement
            // personnalisé est configuré (sinon les images locales hors APPDATA
            // ne seraient pas servies au lecteur).
            let custom_dl: Option<String> = tauri::async_runtime::block_on(async {
                sqlx::query_as::<_, (String,)>(
                    "SELECT value FROM preferences WHERE key = 'download_path'",
                )
                .fetch_optional(&*app.state::<SqlitePool>())
                .await
                .ok()
                .flatten()
                .map(|r| r.0)
            });
            if let Some(path) = custom_dl {
                downloader::allow_download_dir(app.handle(), &path);
            }

            // Mises à jour automatiques : intervalle partagé avec la boucle de fond.
            let updater_state = updater::UpdaterState::new(12);
            let interval = updater_state.interval_hours.clone();
            app.manage(updater_state);
            updater::start_update_loop(app.handle().clone(), interval);

            // Tracking : état OAuth (code_verifier en mémoire le temps du flow).
            app.manage(auth::AuthState::new());

            // Deep link OAuth : on transmet l'URL entrante au frontend, qui en
            // extrait provider + code/token et appelle `complete_oauth`.
            let _ = app.deep_link().register("mangadesk");
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = handle.emit("deep-link:received", url.to_string());
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fetch::fetch_url,
            commands::fetch::fetch_image_as_base64,
            commands::fetch::harvest_blobs,
            commands::fetch::solve_cloudflare,
            commands::fetch::fetch_via_webview,
            commands::fetch::fetch_image_via_webview,
            commands::fetch::render_via_webview,
            commands::fetch::eval_webview,
            commands::fs::get_app_data_dir,
            commands::fs::ensure_dir,
            commands::fs::file_exists,
            commands::fs::read_file_as_base64,
            commands::fs::clear_cache,
            commands::fs::read_logs,
            commands::fs::get_sources_dir,
            commands::fs::list_js_files,
            commands::fs::read_text_file,
            commands::fs::write_text_file,
            commands::fs::delete_file,
            commands::fs::register_source,
            commands::db::get_library,
            commands::db::add_to_library,
            commands::db::upsert_manga,
            commands::db::remove_from_library,
            commands::db::update_manga,
            commands::db::get_chapters,
            commands::db::upsert_chapters,
            commands::db::mark_chapter_read,
            commands::db::update_chapter_progress,
            commands::db::get_categories,
            commands::db::create_category,
            commands::db::delete_category,
            commands::db::set_manga_categories,
            commands::db::get_manga_categories,
            commands::db::get_unread_counts,
            commands::db::reorder_categories,
            commands::db::add_history_entry,
            commands::db::get_history,
            commands::db::get_history_by_manga,
            commands::db::reset_manga_reading_data,
            commands::db::get_preference,
            commands::db::set_preference,
            commands::db::get_recent_updates,
            commands::db::get_new_chapter_count,
            commands::db::record_download,
            commands::db::get_downloaded_chapter_ids,
            commands::db::get_downloaded_manga_ids,
            commands::db::delete_download,
            commands::db::export_backup,
            commands::db::import_backup,
            commands::db::purge_database,
            commands::db::update_reading_stats,
            commands::db::get_reading_stats,
            commands::db::get_global_stats,
            commands::db::migrate_manga,
            downloader::enqueue_download,
            downloader::provide_download_pages,
            downloader::pause_download,
            downloader::resume_download,
            downloader::cancel_download,
            downloader::get_download_queue,
            downloader::get_local_page_path,
            downloader::export_chapter_cbz,
            downloader::set_max_concurrent,
            downloader::set_download_path,
            updater::report_chapter_update,
            updater::trigger_update_now,
            updater::set_update_interval,
            auth::start_oauth,
            auth::complete_oauth,
            auth::disconnect_tracker,
            auth::tracker_connected,
            auth::search_tracker,
            auth::get_manga_tracking,
            auth::link_tracker,
            auth::unlink_tracker,
            auth::sync_tracker_progress,
        ])
        .run(tauri::generate_context!())
        .expect("error running MangaDesk");
}
