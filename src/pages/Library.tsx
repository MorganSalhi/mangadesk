import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { SOURCE_REGISTRY } from '../hooks/useSource'
import {
  countActiveFilters,
  filterAndSortMangas,
  useLibraryStore,
  type LibraryManga,
} from '../store/libraryStore'
import { useSettingsStore } from '../store/settingsStore'
import type { LibrarySortOrder } from '../types'
import CategoryTabs from '../components/library/CategoryTabs'
import FilterPanel from '../components/library/FilterPanel'
import Modal from '../components/ui/Modal'

const SORT_OPTIONS: { value: LibrarySortOrder; label: string }[] = [
  { value: 'title-asc', label: 'Alphabétique A→Z' },
  { value: 'title-desc', label: 'Alphabétique Z→A' },
  { value: 'dateAdded', label: "Date d'ajout" },
  { value: 'lastUpdated', label: 'Dernière mise à jour' },
  { value: 'lastRead', label: 'Dernière lecture' },
]

function clampColumns(n: number): number {
  return Math.max(2, Math.min(6, n))
}

function formatDate(ms: number | undefined): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleDateString('fr-FR')
}

async function markMangasRead(mangaIds: string[]): Promise<void> {
  // Un UPDATE par manga côté SQL (avant : un aller-retour IPC par CHAPITRE).
  await Promise.all(
    mangaIds.map((mangaId) => invoke('mark_manga_read', { mangaId }).catch(() => {})),
  )
}

export default function Library() {
  const {
    mangas,
    categories,
    coverCache,
    unreadCounts,
    downloadedMangaIds,
    mangaCategories,
    activeCategory,
    filters,
    sortOrder,
    loadLibrary,
    loadCategories,
    loadMangaCategories,
    setActiveCategory,
    setFilters,
    resetFilters,
    setSortOrder,
    createCategory,
    reorderCategories,
    removeManyFromLibrary,
  } = useLibraryStore()

  const gridColumns = useSettingsStore((s) => s.gridColumns)
  const viewMode = useSettingsStore((s) => s.defaultViewMode)
  const updateSetting = useSettingsStore((s) => s.updateSetting)

  const navigate = useNavigate()

  const [showFilters, setShowFilters] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [modal, setModal] = useState<null | 'create' | 'changeCategory'>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [pendingCategoryIds, setPendingCategoryIds] = useState<number[]>([])
  const longPressTimer = useRef<number | null>(null)

  useEffect(() => {
    void loadLibrary()
    void loadCategories()
    void loadMangaCategories()
  }, [loadLibrary, loadCategories, loadMangaCategories])

  const visible = useMemo(
    () =>
      filterAndSortMangas({
        mangas,
        filters,
        sortOrder,
        activeCategory,
        mangaCategories,
        unreadCounts,
        downloadedMangaIds,
      }),
    [
      mangas,
      filters,
      sortOrder,
      activeCategory,
      mangaCategories,
      unreadCounts,
      downloadedMangaIds,
    ],
  )

  const availableSources = useMemo(
    () => Object.values(SOURCE_REGISTRY).map((s) => ({ id: s.id, name: s.name })),
    [],
  )

  const activeFilterCount = countActiveFilters(filters)

  // Handlers stables (useCallback) : les cartes sont mémoïsées — sans réfs
  // stables, chaque chargement de couverture re-rendrait toute la grille.
  const toggleSelect = useCallback((mangaId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(mangaId)) next.delete(mangaId)
      else next.add(mangaId)
      return next
    })
  }, [])

  function exitSelection() {
    setSelectionMode(false)
    setSelected(new Set())
  }

  const handlePointerDown = useCallback(
    (mangaId: string) => {
      longPressTimer.current = window.setTimeout(() => {
        setSelectionMode(true)
        toggleSelect(mangaId)
      }, 300)
    },
    [toggleSelect],
  )

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleCardClick = useCallback(
    (manga: LibraryManga, e: React.MouseEvent) => {
      // Clic en mode sélection (ou Shift) = (dé)sélection ; sinon → page détail.
      if (selectionMode || e.shiftKey) {
        if (!selectionMode) setSelectionMode(true)
        toggleSelect(manga.id)
        return
      }
      navigate(`/manga/${manga.sourceId}/${manga.id}`)
    },
    [selectionMode, toggleSelect, navigate],
  )

  async function handleMarkAllRead() {
    await markMangasRead([...selected])
    exitSelection()
  }

  async function handleDeleteSelected() {
    const ids = [...selected]
    if (ids.length === 0) return
    const ok = window.confirm(
      `Supprimer ${ids.length} manga(s) de la bibliothèque ?`,
    )
    if (!ok) return
    await removeManyFromLibrary(ids)
    exitSelection()
  }

  async function applyCategoryChange() {
    // Cast explicite Number() : si pendingCategoryIds vient d'un parsing de
    // string (form values, etc.), Rust attend Vec<i32> côté backend (bug 2c).
    const categoryIds = pendingCategoryIds.map((id) => Number(id))
    await Promise.all(
      [...selected].map((mangaId) =>
        invoke('set_manga_categories', { mangaId, categoryIds }).catch((e) =>
          console.error('[library] set_manga_categories failed:', e),
        ),
      ),
    )
    // Recharge impérative : sans ça la Map `mangaCategories` du store reste
    // stale, l'onglet/filtre catégorie ne reflète pas le changement (bug 2b).
    await loadMangaCategories()
    setModal(null)
    setPendingCategoryIds([])
    exitSelection()
  }

  const columns = clampColumns(gridColumns)

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="flex items-center gap-3 px-6 pt-6">
          <h1 className="mr-auto text-2xl font-semibold tracking-tight text-content">
            Bibliothèque
          </h1>

          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as LibrarySortOrder)}
            className="rounded-lg border border-line/10 bg-surface-raised px-3 py-1.5 text-sm text-content"
            aria-label="Trier"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className="relative rounded-lg border border-line/10 bg-surface-raised px-3 py-1.5 text-sm text-content hover:bg-fill/10"
          >
            Filtres
            {activeFilterCount > 0 && (
              <span className="ml-2 rounded-full bg-accent px-1.5 text-xs text-white">
                {activeFilterCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() =>
              updateSetting('defaultViewMode', viewMode === 'grid' ? 'list' : 'grid')
            }
            className="rounded-lg border border-line/10 bg-surface-raised px-3 py-1.5 text-sm text-content hover:bg-fill/10"
            aria-label="Basculer grille / liste"
          >
            {viewMode === 'grid' ? '☰ Liste' : '▦ Grille'}
          </button>
        </header>

        <div className="mt-3">
          <CategoryTabs
            categories={categories}
            activeCategory={activeCategory}
            onSelect={setActiveCategory}
            onReorder={reorderCategories}
            onAddClick={() => setModal('create')}
          />
        </div>

        {/* Contenu */}
        <div className="flex-1 overflow-y-auto px-6 py-5 pb-24">
          {visible.length === 0 ? (
            <p className="mt-10 text-center text-sm text-content-4">
              Aucun manga dans la bibliothèque.
            </p>
          ) : viewMode === 'grid' ? (
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {visible.map((m) => (
                <GridCard
                  key={m.id}
                  manga={m}
                  cover={coverCache.get(m.id)}
                  unread={unreadCounts.get(m.id) ?? 0}
                  downloaded={downloadedMangaIds.has(m.id)}
                  selected={selected.has(m.id)}
                  onPointerDown={handlePointerDown}
                  onPointerUp={clearLongPress}
                  onClick={handleCardClick}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-line/5">
              {visible.map((m) => (
                <ListRow
                  key={m.id}
                  manga={m}
                  cover={coverCache.get(m.id)}
                  selected={selected.has(m.id)}
                  onClick={handleCardClick}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {showFilters && (
        <FilterPanel
          filters={filters}
          sources={availableSources}
          categories={categories}
          onChange={setFilters}
          onReset={resetFilters}
          onClose={() => setShowFilters(false)}
        />
      )}

      {/* Barre d'actions de sélection */}
      {selectionMode && (
        <div className="fixed bottom-0 left-60 right-0 flex h-16 items-center gap-3 border-t border-line/10 bg-surface-raised px-6">
          <span className="mr-auto text-sm text-content-2">
            {selected.size} sélectionné(s)
          </span>
          <button
            type="button"
            onClick={handleMarkAllRead}
            className="rounded-lg bg-fill/5 px-3 py-2 text-sm text-content hover:bg-fill/10"
          >
            Marquer tout lu
          </button>
          <button
            type="button"
            onClick={() => {
              setPendingCategoryIds([])
              setModal('changeCategory')
            }}
            className="rounded-lg bg-fill/5 px-3 py-2 text-sm text-content hover:bg-fill/10"
          >
            Changer catégorie
          </button>
          <button
            type="button"
            onClick={handleDeleteSelected}
            className="rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-300 hover:bg-red-500/30"
          >
            Supprimer
          </button>
          <button
            type="button"
            onClick={exitSelection}
            className="rounded-lg px-3 py-2 text-sm text-content-3 hover:text-content"
          >
            Annuler
          </button>
        </div>
      )}

      {/* Modal création de catégorie */}
      {modal === 'create' && (
        <Modal title="Nouvelle catégorie" onClose={() => setModal(null)}>
          <input
            autoFocus
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="Nom de la catégorie"
            className="mb-4 w-full rounded-lg border border-line/10 bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setModal(null)}
              className="rounded-lg px-3 py-2 text-sm text-content-3 hover:text-content"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={async () => {
                await createCategory(newCategoryName)
                setNewCategoryName('')
                setModal(null)
              }}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
            >
              Créer
            </button>
          </div>
        </Modal>
      )}

      {/* Modal changement de catégorie */}
      {modal === 'changeCategory' && (
        <Modal title="Changer de catégorie" onClose={() => setModal(null)}>
          {categories.length === 0 ? (
            <p className="mb-4 text-sm text-content-3">
              Aucune catégorie. Créez-en une d'abord.
            </p>
          ) : (
            <div className="mb-4 flex flex-col gap-1">
              {categories.map((cat) => (
                <label
                  key={cat.id}
                  className="flex cursor-pointer items-center gap-2 text-sm text-content"
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-accent"
                    checked={pendingCategoryIds.includes(cat.id)}
                    onChange={() =>
                      setPendingCategoryIds((prev) =>
                        prev.includes(cat.id)
                          ? prev.filter((id) => id !== cat.id)
                          : [...prev, cat.id],
                      )
                    }
                  />
                  {cat.name}
                </label>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setModal(null)}
              className="rounded-lg px-3 py-2 text-sm text-content-3 hover:text-content"
            >
              Annuler
            </button>
            <button
              type="button"
              onClick={applyCategoryChange}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white"
            >
              Appliquer
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sous-composants
// ---------------------------------------------------------------------------

function CoverImg({ cover, alt }: { cover: string | undefined; alt: string }) {
  if (!cover) {
    return <div className="h-full w-full animate-pulse bg-fill/10" />
  }
  return <img src={cover} alt={alt} loading="lazy" className="h-full w-full object-cover" />
}

interface GridCardProps {
  manga: LibraryManga
  cover: string | undefined
  unread: number
  downloaded: boolean
  selected: boolean
  onPointerDown(mangaId: string): void
  onPointerUp(): void
  onClick(manga: LibraryManga, e: React.MouseEvent): void
}

// memo : seules les cartes dont les props changent re-rendent (les couvertures
// arrivent par lots pendant tout le chargement de la bibliothèque).
const GridCard = memo(function GridCard({
  manga,
  cover,
  unread,
  downloaded,
  selected,
  onPointerDown,
  onPointerUp,
  onClick,
}: GridCardProps) {
  return (
    <button
      type="button"
      className="group flex flex-col text-left"
      onMouseDown={() => onPointerDown(manga.id)}
      onMouseUp={onPointerUp}
      onMouseLeave={onPointerUp}
      onClick={(e) => onClick(manga, e)}
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-surface-raised">
        <CoverImg cover={cover} alt={manga.title} />

        {unread > 0 && (
          <span
            className="absolute right-1.5 top-1.5 rounded-md px-1.5 py-0.5 text-xs font-semibold text-white"
            style={{ backgroundColor: '#3B82F6' }}
          >
            {unread}
          </span>
        )}

        {downloaded && (
          <span className="absolute bottom-1.5 left-1.5 flex h-5 w-5 items-center justify-center rounded bg-black/60 text-[11px] text-white">
            ↓
          </span>
        )}

        {selected && (
          <div className="absolute inset-0 flex items-center justify-center bg-accent/40">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-white">
              ✓
            </span>
          </div>
        )}
      </div>
      <span className="mt-1.5 line-clamp-2 text-sm text-content">{manga.title}</span>
    </button>
  )
})

const ListRow = memo(function ListRow({
  manga,
  cover,
  selected,
  onClick,
}: {
  manga: LibraryManga
  cover: string | undefined
  selected: boolean
  onClick(manga: LibraryManga, e: React.MouseEvent): void
}) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(manga, e)}
      className={[
        'flex items-center gap-3 px-1 py-2 text-left',
        selected ? 'bg-accent/15' : 'hover:bg-fill/5',
      ].join(' ')}
    >
      <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-surface-raised">
        <CoverImg cover={cover} alt={manga.title} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-content">{manga.title}</div>
        <div className="truncate text-xs text-content-4">
          {manga.sourceId} · MàJ {formatDate(manga.lastUpdated)}
        </div>
      </div>
    </button>
  )
})
