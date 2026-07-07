import { invoke } from '@tauri-apps/api/core'
import type { Source } from '../types'
import { MadaraSource, type MadaraConfig } from './engines/madara'
import { MangaThemesiaSource, type MangaThemesiaConfig } from './engines/mangathemesia'
import { SOURCE_REGISTRY, loadSingleSource } from '../hooks/useSource'

// ============================================================================
// Dépôts de sources (session 14) — équivalent MangaDesk du index.min.json de
// Keiyoushi. Un dépôt = une URL servant un JSON `mangadesk-repo/1` qui LISTE
// des sources. Deux familles d'entrées :
//   - engine 'madara' / 'mangathemesia' : PAS de code téléchargé — l'entrée ne
//     porte que la config d'un moteur intégré ; installer = persister la config.
//   - engine 'js' : plugin téléchargé (même mécanisme que l'installation par
//     URL de la session 5B — exports.default requis).
// Persistance : `{sourcesDir}/repos.json` (URLs des dépôts + entrées installées),
// rechargé au boot AVANT le render (cf. main.tsx). `list_js_files` ne matche que
// les .js : le .json ne perturbe pas le scan des plugins.
// ============================================================================

export type RepoEngine = 'madara' | 'mangathemesia' | 'js'

export interface RepoSourceEntry {
  id: string
  name: string
  lang: string
  baseUrl: string
  version?: string
  nsfw?: boolean
  engine: RepoEngine
  /** Surcharges passées au constructeur du moteur (hors id/name/baseUrl/lang). */
  config?: Record<string, unknown>
  /** engine 'js' uniquement : URL du plugin à télécharger. */
  url?: string
}

export interface RepoIndex {
  format: string
  name: string
  description?: string
  sources: RepoSourceEntry[]
}

export interface RepoRef {
  url: string
  name: string
}

interface RepoState {
  repos: RepoRef[]
  /** Entrées de moteur installées (les plugins js vivent en fichiers, pas ici). */
  installed: RepoSourceEntry[]
}

/** Ids des sources installées depuis un dépôt (pour le badge/désinstallation). */
export const REPO_SOURCE_IDS = new Set<string>()

let state: RepoState = { repos: [], installed: [] }

export function getRepos(): RepoRef[] {
  return state.repos
}

// --- Persistance -------------------------------------------------------------

async function stateFilePath(): Promise<string> {
  const dir = await invoke<string>('get_sources_dir')
  return `${dir}/repos.json`
}

async function saveState(): Promise<void> {
  const path = await stateFilePath()
  await invoke('write_text_file', { path, content: JSON.stringify(state, null, 2) })
}

// --- Validation --------------------------------------------------------------

const ID_RE = /^[a-z0-9_-]+$/

function validEntry(e: unknown): e is RepoSourceEntry {
  if (typeof e !== 'object' || e === null) return false
  const o = e as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    ID_RE.test(o.id) &&
    typeof o.name === 'string' &&
    typeof o.lang === 'string' &&
    typeof o.baseUrl === 'string' &&
    /^https?:\/\//.test(o.baseUrl) &&
    (o.engine === 'madara' || o.engine === 'mangathemesia' || o.engine === 'js') &&
    (o.engine !== 'js' || typeof o.url === 'string')
  )
}

export function parseRepoIndex(body: string): RepoIndex {
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    throw new Error('Le contenu téléchargé n’est pas du JSON valide.')
  }
  const idx = raw as Partial<RepoIndex>
  if (typeof idx.format !== 'string' || !idx.format.startsWith('mangadesk-repo/')) {
    throw new Error('Ce JSON n’est pas un dépôt MangaDesk (`format: mangadesk-repo/1` attendu).')
  }
  if (!Array.isArray(idx.sources)) {
    throw new Error('Dépôt invalide : champ `sources` manquant.')
  }
  const sources = idx.sources.filter(validEntry)
  if (sources.length === 0) {
    throw new Error('Dépôt vide ou entrées toutes invalides.')
  }
  return {
    format: idx.format,
    name: typeof idx.name === 'string' ? idx.name : 'Dépôt sans nom',
    description: typeof idx.description === 'string' ? idx.description : undefined,
    sources,
  }
}

// --- Instanciation -----------------------------------------------------------

/** Construit la source d'une entrée moteur (jamais pour engine 'js'). */
function instantiateEntry(entry: RepoSourceEntry): Source {
  const base = {
    ...(entry.config ?? {}),
    id: entry.id,
    name: entry.name,
    baseUrl: entry.baseUrl,
    lang: entry.lang,
    isNsfw: entry.nsfw ?? false,
    version: entry.version ?? '1.0.0',
  }
  switch (entry.engine) {
    case 'madara':
      return new MadaraSource(base as unknown as MadaraConfig)
    case 'mangathemesia':
      return new MangaThemesiaSource(base as unknown as MangaThemesiaConfig)
    default:
      throw new Error(`Moteur non instanciable : ${entry.engine}`)
  }
}

function registerEntry(entry: RepoSourceEntry): Source {
  const source = instantiateEntry(entry)
  SOURCE_REGISTRY[source.id] = source
  REPO_SOURCE_IDS.add(source.id)
  // Cohérence FK pour manga.source_id (même contrat que loadSingleSource).
  invoke('register_source', {
    id: source.id,
    name: source.name,
    lang: source.lang,
    baseUrl: source.baseUrl,
    version: source.version,
    isNsfw: source.isNsfw,
  }).catch((e) => console.error('[repo] register_source failed:', e))
  return source
}

// --- API publique ------------------------------------------------------------

/** Recharge l'état persisté et enregistre les sources installées (au boot). */
export async function loadRepoSources(): Promise<void> {
  let content: string
  try {
    content = await invoke<string>('read_text_file', { path: await stateFilePath() })
  } catch {
    return // premier lancement : pas de repos.json
  }
  try {
    const parsed = JSON.parse(content) as Partial<RepoState>
    state = {
      repos: Array.isArray(parsed.repos)
        ? parsed.repos.filter((r): r is RepoRef => typeof r?.url === 'string')
        : [],
      installed: Array.isArray(parsed.installed) ? parsed.installed.filter(validEntry) : [],
    }
  } catch (err) {
    console.error('[repo] repos.json illisible :', err)
    return
  }
  for (const entry of state.installed) {
    try {
      registerEntry(entry)
    } catch (err) {
      // Entrée d'un futur format/moteur inconnu : on la garde persistée mais
      // la source est simplement absente de cette session.
      console.error(`[repo] source installée non chargeable (${entry.id}):`, err)
    }
  }
  if (state.installed.length > 0) {
    console.info(`[repo] ${state.installed.length} source(s) de dépôt chargée(s).`)
  }
}

/** Télécharge et valide l'index d'un dépôt. */
export async function fetchRepoIndex(url: string): Promise<RepoIndex> {
  const res = await invoke<{ status: number; body: string }>('fetch_url', {
    url: url.trim(),
    headers: {},
  })
  if (res.status !== 200) throw new Error(`Téléchargement échoué (HTTP ${res.status}).`)
  return parseRepoIndex(res.body)
}

/** Ajoute (ou met à jour) un dépôt dans la liste persistée. */
export async function addRepo(url: string): Promise<RepoIndex> {
  const trimmed = url.trim()
  const index = await fetchRepoIndex(trimmed)
  const existing = state.repos.find((r) => r.url === trimmed)
  if (existing) existing.name = index.name
  else state.repos.push({ url: trimmed, name: index.name })
  await saveState()
  return index
}

export async function removeRepo(url: string): Promise<void> {
  state.repos = state.repos.filter((r) => r.url !== url)
  await saveState()
}

/**
 * URL de téléchargement d'un plugin 'js'. Une `url` RELATIVE est résolue
 * contre l'URL de l'index du dépôt (comme les APK de l'index Keiyoushi) —
 * le dépôt reste ainsi hébergeable n'importe où sans réécrire l'index.
 */
function resolvePluginUrl(entry: RepoSourceEntry, repoUrl?: string): string {
  try {
    return new URL(entry.url!, repoUrl).toString()
  } catch {
    throw new Error(
      `URL de plugin irrésoluble : « ${entry.url} » (dépôt : ${repoUrl ?? 'inconnu'}).`,
    )
  }
}

/** Télécharge et charge (ou recharge) un plugin 'js' dans le dossier sources. */
async function downloadJsPlugin(entry: RepoSourceEntry, repoUrl?: string): Promise<Source> {
  const res = await invoke<{ status: number; body: string }>('fetch_url', {
    url: resolvePluginUrl(entry, repoUrl),
    headers: {},
  })
  if (res.status !== 200) throw new Error(`Téléchargement échoué (HTTP ${res.status}).`)
  // Sanity minimale (bundle esbuild : `module.exports`, manuscrit :
  // `exports.default`) — la vraie validation est le chargement lui-même.
  if (!/exports/.test(res.body)) {
    throw new Error('Le contenu téléchargé ne ressemble pas à un plugin MangaDesk.')
  }
  const dir = await invoke<string>('get_sources_dir')
  const destPath = `${dir}/${entry.id}.js`
  await invoke('write_text_file', { path: destPath, content: res.body })
  const loaded = await loadSingleSource(destPath)
  if (!loaded) {
    await invoke('delete_file', { path: destPath }).catch(() => {})
    throw new Error('Plugin téléchargé mais invalide.')
  }
  return loaded
}

/**
 * Installe une entrée de dépôt. Entrée 'js' : télécharge le bundle dans le
 * dossier sources (procédé Tachiyomi — le code voyage dans l'extension).
 * Entrée moteur : instancie + persiste la config, rien de téléchargé.
 */
export async function installRepoSource(
  entry: RepoSourceEntry,
  repoUrl?: string,
): Promise<Source> {
  if (SOURCE_REGISTRY[entry.id]) {
    throw new Error(`La source « ${entry.name} » est déjà présente.`)
  }
  if (entry.engine === 'js') return downloadJsPlugin(entry, repoUrl)
  const source = registerEntry(entry)
  state.installed = state.installed.filter((e) => e.id !== entry.id).concat(entry)
  await saveState()
  return source
}

/**
 * Met à jour une source déjà installée depuis un dépôt vers la version de
 * l'entrée. 'js' : re-télécharge le bundle (même chemin → remplace le fichier
 * et l'instance du registre). Moteur : ré-instancie avec la nouvelle config.
 */
export async function updateRepoSource(
  entry: RepoSourceEntry,
  repoUrl?: string,
): Promise<Source> {
  if (entry.engine === 'js') return downloadJsPlugin(entry, repoUrl)
  const source = registerEntry(entry)
  state.installed = state.installed.filter((e) => e.id !== entry.id).concat(entry)
  await saveState()
  return source
}

/** true si `remote` est strictement plus récente qu'`installed` (x.y.z). */
export function isNewerVersion(remote: string | undefined, installed: string): boolean {
  if (!remote || remote === installed) return false
  const r = remote.split('.').map((n) => parseInt(n, 10) || 0)
  const i = installed.split('.').map((n) => parseInt(n, 10) || 0)
  for (let k = 0; k < Math.max(r.length, i.length); k++) {
    const d = (r[k] ?? 0) - (i[k] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/** Désinstalle une source installée depuis un dépôt (entrées moteur). */
export async function uninstallRepoSource(sourceId: string): Promise<void> {
  delete SOURCE_REGISTRY[sourceId]
  REPO_SOURCE_IDS.delete(sourceId)
  state.installed = state.installed.filter((e) => e.id !== sourceId)
  await saveState()
}
