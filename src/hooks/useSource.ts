import { invoke } from '@tauri-apps/api/core'
import type { Source } from '../types'
import { useBrowseStore } from '../store/browseStore'

// ============================================================================
// Registre des sources.
// - Sources statiques compilées (mangadex, demo, lelmanga…) : peuplées
//   synchronment dans main.tsx AVANT le render.
// - Sources externes (.js dans `{APPDATA}/mangadesk/sources/`) : chargées
//   ensuite par `loadExternalSources()` via évaluation dans un Function-scope
//   isolé. Le .js doit poser une classe sur `exports.default` (style CJS).
// ============================================================================

export const SOURCE_REGISTRY: Record<string, Source> = {}

/** Plugins externes installés : chemin du .js → id de la source enregistrée. */
export const EXTERNAL_SOURCE_PATHS: Record<string, string> = {}

/**
 * Retourne la source correspondant à `sourceId`, ou `null` si inconnue.
 *
 * ⚠️ Ordre d'initialisation : le registre DOIT être peuplé avant
 * `ReactDOM.createRoot().render()`. Un accès pendant le render d'un composant
 * enfant avant ce point renverrait `null`.
 */
export function useSource(sourceId: string): Source | null {
  return SOURCE_REGISTRY[sourceId] ?? null
}

/**
 * Retourne la source active sélectionnée dans le store Browse, ou `null`.
 */
export function useActiveSource(): Source | null {
  const activeSourceId = useBrowseStore((s) => s.activeSourceId)
  if (!activeSourceId) return null
  return SOURCE_REGISTRY[activeSourceId] ?? null
}

// ---------------------------------------------------------------------------
// Sources externes (session 5B) — chargement de fichiers .js depuis APPDATA.
// ---------------------------------------------------------------------------

interface PluginExports {
  default?: new () => Source
}

/** Évalue un fichier source unique et l'enregistre dans le registre. */
export async function loadSingleSource(filePath: string): Promise<Source | null> {
  let code: string
  try {
    code = await invoke<string>('read_text_file', { path: filePath })
  } catch (err) {
    console.error('[Sources] read failed:', filePath, err)
    return null
  }
  try {
    // `new Function('exports', 'module', code)` : évaluation sans accès au
    // scope module courant (pas d'import à l'exécution). Deux contrats :
    // plugin manuscrit `exports.default = …` (session 5B) ou bundle esbuild
    // CJS `module.exports = …` (plugins générés par scripts/build-plugins.mjs,
    // session 14 — l'API Tauri y passe par window.__TAURI__).
    const factory = new Function('exports', 'module', code) as (
      exports: PluginExports,
      module: { exports: PluginExports },
    ) => void
    const exports: PluginExports = {}
    const module = { exports }
    factory(exports, module)
    const ctor = module.exports?.default ?? exports.default
    if (!ctor) {
      console.error('[Sources] plugin sans `exports.default`:', filePath)
      return null
    }
    const instance = new ctor()
    if (!instance.id || !instance.name) {
      console.error('[Sources] plugin sans id/name:', filePath)
      return null
    }
    SOURCE_REGISTRY[instance.id] = instance
    EXTERNAL_SOURCE_PATHS[instance.id] = filePath
    // Garantit la cohérence FK pour `manga.source_id` lors d'un add bibliothèque.
    invoke('register_source', {
      id: instance.id,
      name: instance.name,
      lang: instance.lang,
      baseUrl: instance.baseUrl,
      version: instance.version,
      isNsfw: instance.isNsfw,
    }).catch((e) => console.error('[Sources] register_source failed:', e))
    console.info(`[Sources] Loaded: ${instance.name} (${instance.id})`)
    return instance
  } catch (err) {
    console.error('[Sources] eval failed:', filePath, err)
    return null
  }
}

/** Scanne le dossier APPDATA et charge toutes les sources externes trouvées. */
export async function loadExternalSources(): Promise<void> {
  let dir: string
  try {
    dir = await invoke<string>('get_sources_dir')
  } catch (err) {
    console.warn('[Sources] get_sources_dir failed (backend absent ?):', err)
    return
  }
  let files: string[]
  try {
    files = await invoke<string[]>('list_js_files', { dir })
  } catch (err) {
    console.error('[Sources] list_js_files failed:', err)
    return
  }
  // Échec d'une source ne doit pas faire tomber les autres.
  await Promise.all(files.map((f) => loadSingleSource(f).catch(() => null)))
}

/** Désinstalle une source dynamique : retrait du registre + suppression disque. */
export async function uninstallExternalSource(sourceId: string): Promise<void> {
  const path = EXTERNAL_SOURCE_PATHS[sourceId]
  delete SOURCE_REGISTRY[sourceId]
  delete EXTERNAL_SOURCE_PATHS[sourceId]
  if (path) {
    try {
      await invoke('delete_file', { path })
    } catch (err) {
      console.error('[Sources] delete_file failed:', err)
    }
  }
}
