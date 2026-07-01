-- Index pour les requêtes triées / filtrées par date (session 5A).
-- `manga(date_added)` : ORDER BY date d'ajout dans la bibliothèque.
-- `chapters(date_fetch)` : tri / filtre des chapitres "récents" (Updates).
CREATE INDEX IF NOT EXISTS idx_manga_date_added ON manga(date_added);
CREATE INDEX IF NOT EXISTS idx_chapters_date_fetch ON chapters(date_fetch);
