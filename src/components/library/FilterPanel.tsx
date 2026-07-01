import { useEffect } from 'react'
import type { Category, LibraryFilters } from '../../types'

interface SourceOption {
  id: string
  name: string
}

interface FilterPanelProps {
  filters: LibraryFilters
  sources: SourceOption[]
  categories: Category[]
  onChange(patch: Partial<LibraryFilters>): void
  onReset(): void
  onClose(): void
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'ongoing', label: 'En cours' },
  { value: 'completed', label: 'Terminé' },
  { value: 'hiatus', label: 'En pause' },
  { value: 'cancelled', label: 'Annulé' },
  { value: 'unknown', label: 'Inconnu' },
]

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function CheckRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(): void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-sm text-content">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 accent-accent"
      />
      {label}
    </label>
  )
}

/** Panneau latéral droit de filtres, rétractable. */
export default function FilterPanel({
  filters,
  sources,
  categories,
  onChange,
  onReset,
  onClose,
}: FilterPanelProps) {
  // Échap ferme le panneau (sauf pendant une saisie).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-l border-line/5 bg-surface-sunken">
      <div className="flex items-center justify-between border-b border-line/5 px-4 py-3">
        <h2 className="text-sm font-semibold text-content">Filtres</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-content-3 hover:text-content"
          aria-label="Fermer les filtres"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
            Affichage
          </h3>
          <CheckRow
            label="Non lus uniquement"
            checked={filters.unreadOnly}
            onChange={() => onChange({ unreadOnly: !filters.unreadOnly })}
          />
          <CheckRow
            label="Téléchargés uniquement"
            checked={filters.downloadedOnly}
            onChange={() => onChange({ downloadedOnly: !filters.downloadedOnly })}
          />
        </section>

        <section className="mb-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
            Statut
          </h3>
          {STATUS_OPTIONS.map((s) => (
            <CheckRow
              key={s.value}
              label={s.label}
              checked={filters.statuses.includes(s.value)}
              onChange={() => onChange({ statuses: toggle(filters.statuses, s.value) })}
            />
          ))}
        </section>

        {sources.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
              Source
            </h3>
            {sources.map((src) => (
              <CheckRow
                key={src.id}
                label={src.name}
                checked={filters.sourceIds.includes(src.id)}
                onChange={() => onChange({ sourceIds: toggle(filters.sourceIds, src.id) })}
              />
            ))}
          </section>
        )}

        {categories.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
              Catégorie
            </h3>
            {categories.map((cat) => (
              <CheckRow
                key={cat.id}
                label={cat.name}
                checked={filters.categoryIds.includes(cat.id)}
                onChange={() =>
                  onChange({ categoryIds: toggle(filters.categoryIds, cat.id) })
                }
              />
            ))}
          </section>
        )}
      </div>

      <div className="border-t border-line/5 px-4 py-3">
        <button
          type="button"
          onClick={onReset}
          className="w-full rounded-lg bg-fill/5 py-2 text-sm font-medium text-content hover:bg-fill/10"
        >
          Réinitialiser
        </button>
      </div>
    </aside>
  )
}
