CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lang TEXT NOT NULL,
  base_url TEXT NOT NULL,
  version TEXT NOT NULL,
  is_nsfw INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS manga (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cover_url TEXT,
  description TEXT,
  author TEXT,
  artist TEXT,
  status TEXT CHECK(status IN ('ongoing','completed','hiatus','cancelled','unknown')),
  genres TEXT,
  in_library INTEGER NOT NULL DEFAULT 0,
  date_added INTEGER,
  last_updated INTEGER,
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  manga_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  number REAL NOT NULL,
  title TEXT,
  scanlator TEXT,
  date_upload INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_bookmarked INTEGER NOT NULL DEFAULT 0,
  last_page_read INTEGER NOT NULL DEFAULT 0,
  pages_count INTEGER,
  date_fetch INTEGER,
  FOREIGN KEY (manga_id) REFERENCES manga(id)
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  flags INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS manga_categories (
  manga_id TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  PRIMARY KEY (manga_id, category_id),
  FOREIGN KEY (manga_id) REFERENCES manga(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id TEXT NOT NULL,
  manga_id TEXT NOT NULL,
  last_read INTEGER NOT NULL,
  read_duration INTEGER,
  FOREIGN KEY (chapter_id) REFERENCES chapters(id),
  FOREIGN KEY (manga_id) REFERENCES manga(id)
);

CREATE TABLE IF NOT EXISTS downloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id TEXT NOT NULL,
  manga_id TEXT NOT NULL,
  status TEXT CHECK(status IN ('queued','downloading','paused','completed','error')) NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  total_pages INTEGER,
  local_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (chapter_id) REFERENCES chapters(id)
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
