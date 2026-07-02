import { create } from 'zustand'
import type { FilterValues } from '../types'

// ============================================================================
// Store Browse — état minimal de la page "Parcourir".
// Sert de source de vérité pour la source active (cf. useActiveSource).
// Session 13 : valeurs de filtres mémorisées par source (durée de la session,
// non persistées — comme la recherche).
// ============================================================================

interface BrowseState {
  activeSourceId: string | null
  query: string
  /** Valeurs de filtres choisies, indexées par id de source. */
  filterValues: Record<string, FilterValues>
  setActiveSourceId(id: string | null): void
  setQuery(query: string): void
  setFilterValues(sourceId: string, values: FilterValues): void
  resetFilterValues(sourceId: string): void
}

export const useBrowseStore = create<BrowseState>((set) => ({
  // Source réseau par défaut à l'ouverture (cf. SOURCE_REGISTRY dans main.tsx).
  activeSourceId: 'mangasorigines',
  query: '',
  filterValues: {},
  setActiveSourceId: (id) => set({ activeSourceId: id }),
  setQuery: (query) => set({ query }),
  setFilterValues: (sourceId, values) =>
    set((s) => ({ filterValues: { ...s.filterValues, [sourceId]: values } })),
  resetFilterValues: (sourceId) =>
    set((s) => {
      const next = { ...s.filterValues }
      delete next[sourceId]
      return { filterValues: next }
    }),
}))
