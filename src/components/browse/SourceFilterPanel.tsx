import { useEffect, useState } from 'react'
import type {
  FilterValues,
  MultiSelectFilterDef,
  SourceFilterDef,
} from '../../types'

// ============================================================================
// Panneau de filtres de « Parcourir » (session 13).
// Rend dynamiquement les définitions de filtres déclarées par la source
// active (tri, genres, statut…). Les modifications sont locales (draft) et
// appliquées d'un bloc via « Appliquer » → relance la recherche page 1.
// ============================================================================

interface SourceFilterPanelProps {
  defs: SourceFilterDef[]
  values: FilterValues
  loading: boolean
  onApply(values: FilterValues): void
  onReset(): void
  onClose(): void
}

/** Valeur effective d'un filtre : valeur choisie, sinon défaut de la définition. */
export function effectiveValue(
  def: SourceFilterDef,
  values: FilterValues,
): string | string[] | boolean {
  const v = values[def.id]
  switch (def.type) {
    case 'select':
      return typeof v === 'string' ? v : def.default ?? def.options[0]?.value ?? ''
    case 'multiselect':
      return Array.isArray(v) ? v : []
    case 'checkbox':
      return typeof v === 'boolean' ? v : def.default ?? false
    case 'text':
      return typeof v === 'string' ? v : ''
  }
}

/** Nombre de filtres dont la valeur diffère du défaut (badge du bouton Filtres). */
export function countActiveFilters(defs: SourceFilterDef[], values: FilterValues): number {
  let count = 0
  for (const def of defs) {
    const v = effectiveValue(def, values)
    switch (def.type) {
      case 'select':
        if (v !== (def.default ?? def.options[0]?.value ?? '')) count++
        break
      case 'multiselect':
        if ((v as string[]).length > 0) count++
        break
      case 'checkbox':
        if (v !== (def.default ?? false)) count++
        break
      case 'text':
        if ((v as string).trim() !== '') count++
        break
    }
  }
  return count
}

function MultiSelect({
  def,
  selected,
  onToggle,
}: {
  def: MultiSelectFilterDef
  selected: string[]
  onToggle(value: string): void
}) {
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const options = needle
    ? def.options.filter((o) => o.label.toLowerCase().includes(needle))
    : def.options

  return (
    <div>
      {def.options.length > 12 && (
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filtrer la liste…"
          className="mb-2 w-full rounded-lg border border-line/10 bg-surface-raised px-2.5 py-1.5 text-xs text-content outline-none focus:border-accent"
        />
      )}
      <div className="max-h-56 overflow-y-auto pr-1">
        {options.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer items-center gap-2 py-1 text-sm text-content"
          >
            <input
              type="checkbox"
              checked={selected.includes(o.value)}
              onChange={() => onToggle(o.value)}
              className="h-4 w-4 shrink-0 accent-accent"
            />
            <span className="min-w-0 truncate">{o.label}</span>
          </label>
        ))}
        {options.length === 0 && (
          <p className="py-1 text-xs text-content-4">Aucune option ne correspond.</p>
        )}
      </div>
    </div>
  )
}

/** Panneau latéral droit des filtres de la source active. */
export default function SourceFilterPanel({
  defs,
  values,
  loading,
  onApply,
  onReset,
  onClose,
}: SourceFilterPanelProps) {
  const [draft, setDraft] = useState<FilterValues>(values)

  // Resynchronise le brouillon quand la source change (nouvelles définitions).
  useEffect(() => {
    setDraft(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defs])

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

  function patch(id: string, value: string | string[] | boolean) {
    setDraft((d) => ({ ...d, [id]: value }))
  }

  function toggleMulti(id: string, def: MultiSelectFilterDef, value: string) {
    const current = effectiveValue(def, draft) as string[]
    patch(
      id,
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    )
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-l border-line/5 bg-surface-sunken">
      <div className="flex items-center justify-between border-b border-line/5 px-4 py-3">
        <h2 className="text-sm font-semibold text-content">Filtres de la source</h2>
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
        {loading ? (
          <p className="py-4 text-center text-sm text-content-4">
            Chargement des filtres…
          </p>
        ) : defs.length === 0 ? (
          <p className="py-4 text-center text-sm text-content-4">
            Cette source ne propose pas de filtres.
          </p>
        ) : (
          defs.map((def) => (
            <section key={def.id} className="mb-5">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-3">
                {def.name}
              </h3>
              {def.type === 'select' && (
                <select
                  value={effectiveValue(def, draft) as string}
                  onChange={(e) => patch(def.id, e.target.value)}
                  className="w-full rounded-lg border border-line/10 bg-surface-raised px-2.5 py-1.5 text-sm text-content"
                >
                  {def.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              {def.type === 'multiselect' && (
                <MultiSelect
                  def={def}
                  selected={effectiveValue(def, draft) as string[]}
                  onToggle={(v) => toggleMulti(def.id, def, v)}
                />
              )}
              {def.type === 'checkbox' && (
                <label className="flex cursor-pointer items-center gap-2 py-1 text-sm text-content">
                  <input
                    type="checkbox"
                    checked={effectiveValue(def, draft) as boolean}
                    onChange={(e) => patch(def.id, e.target.checked)}
                    className="h-4 w-4 accent-accent"
                  />
                  {def.name}
                </label>
              )}
              {def.type === 'text' && (
                <input
                  value={effectiveValue(def, draft) as string}
                  onChange={(e) => patch(def.id, e.target.value)}
                  placeholder={def.placeholder}
                  className="w-full rounded-lg border border-line/10 bg-surface-raised px-2.5 py-1.5 text-sm text-content outline-none focus:border-accent"
                />
              )}
            </section>
          ))
        )}
      </div>

      <div className="flex gap-2 border-t border-line/5 px-4 py-3">
        <button
          type="button"
          onClick={() => {
            setDraft({})
            onReset()
          }}
          className="flex-1 rounded-lg bg-fill/5 py-2 text-sm font-medium text-content hover:bg-fill/10"
        >
          Réinitialiser
        </button>
        <button
          type="button"
          onClick={() => onApply(draft)}
          disabled={loading}
          className="flex-1 rounded-lg bg-accent py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Appliquer
        </button>
      </div>
    </aside>
  )
}
