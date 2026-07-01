import type { Theme } from '../store/settingsStore'

// ============================================================================
// Application du thème (classe `dark` sur <html>) et de la couleur d'accent
// (variable CSS `--color-accent` consommée par Tailwind, cf. tailwind.config).
//
// Note : MangaDesk est conçu « dark-first » ; le mode clair bascule la classe
// et `color-scheme` (mécanique en place), mais les surfaces restent sombres
// faute de jeu de tokens clairs dédié.
// ============================================================================

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark)
  root.classList.toggle('dark', isDark)
  root.style.colorScheme = isDark ? 'dark' : 'light'
}

/** Convertit `#6c8cff` en canaux « 108 140 255 » pour `rgb(var(--x) / a)`. */
function hexToChannels(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const int = parseInt(m[1], 16)
  return `${(int >> 16) & 255} ${(int >> 8) & 255} ${int & 255}`
}

export function applyAccent(color: string): void {
  const channels = hexToChannels(color)
  if (channels) {
    document.documentElement.style.setProperty('--color-accent', channels)
  }
}
