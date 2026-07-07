import type { Chapter, Manga } from '../types'

// ============================================================================
// Mapping des lignes SQLite (snake_case, renvoyées par les commandes Rust)
// vers les types du frontend — dédup de la review S13 (copié dans
// MangaDetail.tsx et Reader.tsx).
// ============================================================================

/** Ligne `chapters` telle que renvoyée par `get_chapters`. */
export interface ChapterRow {
  id: string
  manga_id: string
  number: number
  title: string | null
  scanlator: string | null
  date_upload: number | null
  is_read: number
  last_page_read: number
  pages_count: number | null
}

/**
 * Map Manga → ligne snake_case pour `upsert_manga` / `add_to_library`.
 * `opts.inLibrary` force le flag (ex. migration : la cible entre en biblio).
 */
export function toMangaRow(m: Manga, opts: { inLibrary?: boolean } = {}) {
  return {
    id: m.id,
    source_id: m.sourceId,
    remote_id: m.id,
    title: m.title,
    cover_url: m.coverUrl,
    description: m.description,
    author: m.author,
    artist: m.artist,
    status: m.status,
    genres: JSON.stringify(m.genres),
    in_library: (opts.inLibrary ?? m.inLibrary) ? 1 : 0,
    date_added: null,
    last_updated: Date.now(),
  }
}

export function toChapter(r: ChapterRow): Chapter {
  return {
    id: r.id,
    mangaId: r.manga_id,
    number: r.number,
    title: r.title ?? '',
    scanlator: r.scanlator ?? '',
    dateUpload: r.date_upload ?? 0,
    isRead: r.is_read === 1,
    lastPageRead: r.last_page_read,
    pagesCount: r.pages_count,
  }
}
