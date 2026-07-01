-- Statistiques de lecture cumulées par manga (session 4B).
-- Mise à jour incrémentale depuis le Reader via `update_reading_stats`.
CREATE TABLE IF NOT EXISTS reading_stats (
  manga_id TEXT NOT NULL,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  chapters_read INTEGER NOT NULL DEFAULT 0,
  last_read INTEGER,
  PRIMARY KEY (manga_id),
  FOREIGN KEY (manga_id) REFERENCES manga(id)
);

-- Le mode navigation privée est stocké côté preferences (clé `incognito_mode`,
-- valeur "0"/"1") — aucune table dédiée nécessaire.
