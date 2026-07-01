import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { invoke } from '@tauri-apps/api/core'
import type { ReaderSettings } from '../types'

// ============================================================================
// Store Paramètres — persisté dans localStorage via zustand/middleware.
// Étendu en session 3 : langue, thème, couleur d'accent, dépôts de sources,
// options de téléchargement et suivi des mises à jour vues (badge sidebar).
// ============================================================================

const DEFAULT_READER_SETTINGS: ReaderSettings = {
  readingMode: 'rtl',
  scaleType: 'fit-page',
  backgroundColor: '#15171d',
  preloadCount: 3,
  showPageNumber: true,
  doublePageMode: false,
  doublePageOffset: false,
  cropBorders: false,
}

export type Language = 'fr' | 'en'
export type Theme = 'light' | 'dark' | 'system'
export type UpdateInterval = 0 | 1 | 6 | 12 | 24 // 0 = jamais

/** Presets de couleur d'accent (le 1er est la valeur par défaut historique). */
export const ACCENT_PRESETS = [
  '#6c8cff',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#ec4899',
] as const

interface SettingsState {
  readerSettings: ReaderSettings
  gridColumns: number
  defaultViewMode: 'grid' | 'list'
  updateInterval: UpdateInterval
  downloadPath: string | null
  maxConcurrentDownloads: number
  deleteAfterRead: boolean
  language: Language
  theme: Theme
  accentColor: string
  sourceRepos: string[]
  lastSeenUpdates: number // timestamp ms — base du badge "nouveaux chapitres"
  // Session 4B — navigation privée : aucun write (history / progression /
  // reading_stats / badge non-lu) tant que ce flag est vrai. Persisté
  // localement (zustand/persist) ET côté SQLite (`preferences.incognito_mode`)
  // pour rester cohérent si le store local est purgé.
  incognitoMode: boolean
  // Actions
  updateReaderSettings(patch: Partial<ReaderSettings>): void
  updateSetting<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void
  addSourceRepo(url: string): void
  removeSourceRepo(url: string): void
  markUpdatesSeen(): void
  setIncognitoMode(value: boolean): Promise<void>
  hydrateIncognitoFromBackend(): Promise<void>
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      readerSettings: DEFAULT_READER_SETTINGS,
      gridColumns: 5,
      defaultViewMode: 'grid',
      updateInterval: 12,
      downloadPath: null,
      maxConcurrentDownloads: 3,
      deleteAfterRead: false,
      language: 'fr',
      theme: 'dark',
      accentColor: ACCENT_PRESETS[0],
      sourceRepos: [],
      lastSeenUpdates: Date.now(),
      incognitoMode: false,

      updateReaderSettings: (patch) =>
        set({ readerSettings: { ...get().readerSettings, ...patch } }),

      updateSetting: (key, value) => set({ [key]: value } as Partial<SettingsState>),

      addSourceRepo: (url) => {
        const trimmed = url.trim()
        if (!trimmed || get().sourceRepos.includes(trimmed)) return
        set((s) => ({ sourceRepos: [...s.sourceRepos, trimmed] }))
      },

      removeSourceRepo: (url) =>
        set((s) => ({ sourceRepos: s.sourceRepos.filter((u) => u !== url) })),

      markUpdatesSeen: () => set({ lastSeenUpdates: Date.now() }),

      setIncognitoMode: async (value) => {
        set({ incognitoMode: value })
        try {
          await invoke('set_preference', {
            key: 'incognito_mode',
            value: value ? '1' : '0',
          })
        } catch {
          /* backend absent : seul le store local est mis à jour */
        }
      },

      hydrateIncognitoFromBackend: async () => {
        try {
          const v = await invoke<string | null>('get_preference', { key: 'incognito_mode' })
          if (v === '0' || v === '1') set({ incognitoMode: v === '1' })
        } catch {
          /* backend absent */
        }
      },
    }),
    { name: 'mangadesk-settings' },
  ),
)
