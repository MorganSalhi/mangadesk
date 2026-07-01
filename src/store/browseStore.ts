import { create } from 'zustand'

// ============================================================================
// Store Browse — état minimal de la page "Parcourir".
// Sert de source de vérité pour la source active (cf. useActiveSource).
// ============================================================================

interface BrowseState {
  activeSourceId: string | null
  query: string
  setActiveSourceId(id: string | null): void
  setQuery(query: string): void
}

export const useBrowseStore = create<BrowseState>((set) => ({
  // Source réseau par défaut à l'ouverture (cf. SOURCE_REGISTRY dans main.tsx).
  activeSourceId: 'mangasorigines',
  query: '',
  setActiveSourceId: (id) => set({ activeSourceId: id }),
  setQuery: (query) => set({ query }),
}))
