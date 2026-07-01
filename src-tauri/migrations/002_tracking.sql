CREATE TABLE IF NOT EXISTS manga_tracking (
  manga_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('anilist', 'mal')),
  remote_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT,
  score INTEGER,
  progress INTEGER,
  last_synced INTEGER,
  PRIMARY KEY (manga_id, provider),
  FOREIGN KEY (manga_id) REFERENCES manga(id)
);

-- Un seul enregistrement de téléchargement par chapitre (requis par le
-- `ON CONFLICT` de `record_download`). La table `downloads` est créée en 001.
CREATE UNIQUE INDEX IF NOT EXISTS idx_downloads_chapter ON downloads(chapter_id);
