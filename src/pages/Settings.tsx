import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { useTranslation } from 'react-i18next'
import {
  ACCENT_PRESETS,
  useSettingsStore,
  type Language,
  type Theme,
  type UpdateInterval,
} from '../store/settingsStore'
import {
  EXTERNAL_SOURCE_PATHS,
  SOURCE_REGISTRY,
  loadSingleSource,
  uninstallExternalSource,
} from '../hooks/useSource'
import type { ReaderSettings, Source } from '../types'
import {
  REPO_SOURCE_IDS,
  addRepo,
  fetchRepoIndex,
  getRepos,
  installRepoSource,
  isNewerVersion,
  removeRepo,
  uninstallRepoSource,
  updateRepoSource,
  type RepoIndex,
  type RepoRef,
  type RepoSourceEntry,
} from '../sources/repo'

// ============================================================================
// Page Paramètres — onglets verticaux. Toutes les valeurs sont persistées via
// settingsStore (localStorage) ; les opérations système passent par des
// commandes Tauri (dialogues, sauvegarde, purge…).
// ============================================================================

type Tab =
  | 'general'
  | 'library'
  | 'reader'
  | 'downloads'
  | 'sources'
  | 'accounts'
  | 'backup'
  | 'advanced'

const TABS: Tab[] = [
  'general',
  'library',
  'reader',
  'downloads',
  'sources',
  'accounts',
  'backup',
  'advanced',
]

export default function Settings() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('general')

  return (
    <div className="flex h-full">
      {/* Onglets verticaux */}
      <aside className="w-56 shrink-0 border-r border-line/5 p-3">
        <h1 className="px-2 py-3 text-lg font-semibold text-content">
          {t('settings.title')}
        </h1>
        {TABS.map((tb) => (
          <button
            key={tb}
            type="button"
            onClick={() => setTab(tb)}
            className={[
              'mb-0.5 block w-full rounded-lg px-3 py-2 text-left text-sm',
              tab === tb
                ? 'bg-accent/15 text-accent'
                : 'text-content-3 hover:bg-fill/5 hover:text-content',
            ].join(' ')}
          >
            {t(`settings.tabs.${tb}`)}
          </button>
        ))}
      </aside>

      {/* Contenu */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {tab === 'general' && <GeneralTab />}
          {tab === 'library' && <LibraryTab />}
          {tab === 'reader' && <ReaderTab />}
          {tab === 'downloads' && <DownloadsTab />}
          {tab === 'sources' && <SourcesTab />}
          {tab === 'accounts' && <AccountsTab />}
          {tab === 'backup' && <BackupTab />}
          {tab === 'advanced' && <AdvancedTab />}
        </div>
      </div>
    </div>
  )
}

// --- Briques d'UI réutilisables --------------------------------------------

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-sm text-content">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line/5 bg-surface-raised px-5 py-3">
      {children}
    </section>
  )
}

function Select<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange(v: T): void
}) {
  return (
    <select
      value={String(value)}
      onChange={(e) => {
        const found = options.find((o) => String(o.value) === e.target.value)
        if (found) onChange(found.value)
      }}
      className="rounded-lg border border-line/10 bg-surface px-3 py-1.5 text-sm text-content"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="h-4 w-4 accent-accent"
    />
  )
}

// --- Général ----------------------------------------------------------------

function GeneralTab() {
  const { t } = useTranslation()
  const language = useSettingsStore((s) => s.language)
  const theme = useSettingsStore((s) => s.theme)
  const accentColor = useSettingsStore((s) => s.accentColor)
  const incognitoMode = useSettingsStore((s) => s.incognitoMode)
  const setIncognitoMode = useSettingsStore((s) => s.setIncognitoMode)
  const confirmBeforeExit = useSettingsStore((s) => s.confirmBeforeExit)
  const update = useSettingsStore((s) => s.updateSetting)

  return (
    <Card>
      <Row label={t('settings.language')}>
        <Select<Language>
          value={language}
          onChange={(v) => update('language', v)}
          options={[
            { value: 'fr', label: 'Français' },
            { value: 'en', label: 'English' },
          ]}
        />
      </Row>
      <Row label={t('settings.theme')}>
        <Select<Theme>
          value={theme}
          onChange={(v) => update('theme', v)}
          options={[
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
            { value: 'system', label: t('settings.themeSystem') },
          ]}
        />
      </Row>
      <Row label={t('settings.accent')}>
        <div className="flex items-center gap-2">
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => update('accentColor', c)}
              className={[
                'h-6 w-6 rounded-full border',
                accentColor === c ? 'border-content' : 'border-line/20',
              ].join(' ')}
              style={{ backgroundColor: c }}
              aria-label={c}
            />
          ))}
          <input
            type="color"
            value={accentColor}
            onChange={(e) => update('accentColor', e.target.value)}
            className="h-6 w-6 cursor-pointer rounded bg-transparent"
            aria-label="Couleur personnalisée"
          />
        </div>
      </Row>
      <Row label="Navigation privée">
        <Toggle checked={incognitoMode} onChange={(v) => void setIncognitoMode(v)} />
      </Row>
      <Row label="Confirmer avant de quitter">
        <Toggle
          checked={confirmBeforeExit}
          onChange={(v) => update('confirmBeforeExit', v)}
        />
      </Row>
    </Card>
  )
}

// --- Bibliothèque -----------------------------------------------------------

function LibraryTab() {
  const { t } = useTranslation()
  const defaultViewMode = useSettingsStore((s) => s.defaultViewMode)
  const gridColumns = useSettingsStore((s) => s.gridColumns)
  const update = useSettingsStore((s) => s.updateSetting)

  return (
    <Card>
      <Row label={t('settings.defaultView')}>
        <Select<'grid' | 'list'>
          value={defaultViewMode}
          onChange={(v) => update('defaultViewMode', v)}
          options={[
            { value: 'grid', label: t('settings.grid') },
            { value: 'list', label: t('settings.list') },
          ]}
        />
      </Row>
      <Row label={`${t('settings.gridColumns')} : ${gridColumns}`}>
        <input
          type="range"
          min={2}
          max={6}
          value={gridColumns}
          onChange={(e) => update('gridColumns', Number(e.target.value))}
          className="w-40 accent-accent"
        />
      </Row>
    </Card>
  )
}

// --- Lecteur ----------------------------------------------------------------

function ReaderTab() {
  const settings = useSettingsStore((s) => s.readerSettings)
  const patch = useSettingsStore((s) => s.updateReaderSettings)
  const set = <K extends keyof ReaderSettings>(k: K, v: ReaderSettings[K]) =>
    patch({ [k]: v } as Partial<ReaderSettings>)

  return (
    <Card>
      <Row label="Mode de lecture">
        <Select<ReaderSettings['readingMode']>
          value={settings.readingMode}
          onChange={(v) => set('readingMode', v)}
          options={[
            { value: 'ltr', label: 'Gauche → droite' },
            { value: 'rtl', label: 'Droite → gauche' },
            { value: 'webtoon', label: 'Webtoon' },
            { value: 'vertical', label: 'Vertical' },
          ]}
        />
      </Row>
      <Row label="Ajustement">
        <Select<ReaderSettings['scaleType']>
          value={settings.scaleType}
          onChange={(v) => set('scaleType', v)}
          options={[
            { value: 'fit-page', label: 'Page entière' },
            { value: 'fit-width', label: 'Largeur' },
            { value: 'fit-height', label: 'Hauteur' },
            { value: 'original', label: 'Taille réelle' },
          ]}
        />
      </Row>
      <Row label="Couleur de fond">
        <input
          type="color"
          value={settings.backgroundColor}
          onChange={(e) => set('backgroundColor', e.target.value)}
          className="h-6 w-10 cursor-pointer rounded bg-transparent"
        />
      </Row>
      <Row label={`Préchargement : ${settings.preloadCount}`}>
        <input
          type="range"
          min={1}
          max={8}
          value={settings.preloadCount}
          onChange={(e) => set('preloadCount', Number(e.target.value))}
          className="w-40 accent-accent"
        />
      </Row>
      <Row label="Afficher le numéro de page">
        <Toggle checked={settings.showPageNumber} onChange={(v) => set('showPageNumber', v)} />
      </Row>
      <Row label="Mode double page">
        <Toggle checked={settings.doublePageMode} onChange={(v) => set('doublePageMode', v)} />
      </Row>
    </Card>
  )
}

// --- Téléchargements --------------------------------------------------------

function DownloadsTab() {
  const { t } = useTranslation()
  const downloadPath = useSettingsStore((s) => s.downloadPath)
  const maxConcurrentDownloads = useSettingsStore((s) => s.maxConcurrentDownloads)
  const deleteAfterRead = useSettingsStore((s) => s.deleteAfterRead)
  const update = useSettingsStore((s) => s.updateSetting)

  async function pickFolder() {
    try {
      const dir = await open({ directory: true, multiple: false })
      if (typeof dir === 'string') {
        update('downloadPath', dir)
        // Persiste côté backend (préférence DB) + élargit le scope asset.
        await invoke('set_download_path', { path: dir }).catch((e) => console.error(e))
      }
    } catch (e) {
      console.error(e)
    }
  }

  function setConcurrent(value: number) {
    update('maxConcurrentDownloads', value)
    void invoke('set_max_concurrent', { value }).catch(() => {})
  }

  return (
    <Card>
      <Row label={t('settings.storageFolder')}>
        <span className="max-w-[260px] truncate text-xs text-content-3">
          {downloadPath ?? '— (défaut)'}
        </span>
        <button
          type="button"
          onClick={pickFolder}
          className="rounded-lg bg-fill/10 px-3 py-1.5 text-sm text-content hover:bg-fill/20"
        >
          {t('settings.browse')}
        </button>
      </Row>
      <Row label={`${t('settings.concurrentDownloads')} : ${maxConcurrentDownloads}`}>
        <input
          type="range"
          min={1}
          max={5}
          value={maxConcurrentDownloads}
          onChange={(e) => setConcurrent(Number(e.target.value))}
          className="w-40 accent-accent"
        />
      </Row>
      <Row label={t('settings.deleteAfterRead')}>
        <Toggle checked={deleteAfterRead} onChange={(v) => update('deleteAfterRead', v)} />
      </Row>
    </Card>
  )
}

// --- Sources & Extensions ---------------------------------------------------

interface InstalledSource {
  source: Source
  /** Provenance : intégrée au binaire, plugin .js, ou entrée de dépôt. */
  origin: 'builtin' | 'plugin' | 'repo'
}

function listInstalled(): InstalledSource[] {
  return Object.values(SOURCE_REGISTRY)
    .map((s) => ({
      source: s,
      origin: (EXTERNAL_SOURCE_PATHS[s.id]
        ? 'plugin'
        : REPO_SOURCE_IDS.has(s.id)
          ? 'repo'
          : 'builtin') as InstalledSource['origin'],
    }))
    .sort((a, b) => a.source.name.localeCompare(b.source.name))
}

function SourcesTab() {
  const { t } = useTranslation()
  const updateInterval = useSettingsStore((s) => s.updateInterval)
  const showNsfwSources = useSettingsStore((s) => s.showNsfwSources)
  const update = useSettingsStore((s) => s.updateSetting)
  // Le registre est muté en place ; on déclenche un re-render manuel après
  // install/uninstall via un compteur monotone.
  const [tick, setTick] = useState(0)
  const installed = listInstalled()
  void tick // forcer la dépendance dans le diff React (sinon warning de lint)

  const [modal, setModal] = useState<null | 'install'>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  // Dépôts de sources (session 14).
  const repos = getRepos()
  const [repoUrl, setRepoUrl] = useState('')
  const [repoError, setRepoError] = useState<string | null>(null)
  const [repoBusy, setRepoBusy] = useState(false)
  const [browsing, setBrowsing] = useState<RepoRef | null>(null)

  async function handleAddRepo(): Promise<void> {
    setRepoError(null)
    setRepoBusy(true)
    try {
      const index = await addRepo(repoUrl)
      setRepoUrl('')
      // Ouvre directement le contenu du dépôt fraîchement ajouté.
      setBrowsing({ url: repoUrl.trim(), name: index.name })
    } catch (e) {
      console.error('[repo] add failed:', e)
      setRepoError(e instanceof Error ? e.message : String(e))
    } finally {
      setRepoBusy(false)
      setTick((n) => n + 1)
    }
  }

  async function handleRemoveRepo(url: string): Promise<void> {
    await removeRepo(url).catch((e) => console.error('[repo] remove failed:', e))
    setTick((n) => n + 1)
  }

  async function changeInterval(hours: UpdateInterval) {
    update('updateInterval', hours)
    await invoke('set_update_interval', { hours }).catch(() => {})
  }

  async function installFromFile(): Promise<void> {
    setInstallError(null)
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Source JavaScript', extensions: ['js'] }],
      })
      if (typeof picked !== 'string') return
      setInstalling(true)
      const sourcesDir = await invoke<string>('get_sources_dir')
      const fileName = picked.split(/[\\/]/).pop() ?? 'source.js'
      const destPath = `${sourcesDir}/${fileName}`
      const content = await invoke<string>('read_text_file', { path: picked })
      await invoke('write_text_file', { path: destPath, content })
      const loaded = await loadSingleSource(destPath)
      if (!loaded) {
        setInstallError(
          'Le fichier ne paraît pas exporter une source valide (`exports.default` attendu).',
        )
        // Nettoyage : on ne laisse pas un .js inutilisable traîner.
        await invoke('delete_file', { path: destPath }).catch(() => {})
      } else {
        setModal(null)
      }
    } catch (e) {
      console.error('[sources] install from file failed:', e)
      setInstallError(typeof e === 'string' ? e : 'Installation depuis le fichier impossible.')
    } finally {
      setInstalling(false)
      setTick((n) => n + 1)
    }
  }

  async function installFromUrl(url: string): Promise<void> {
    setInstallError(null)
    if (!url.trim()) {
      setInstallError('URL vide.')
      return
    }
    setInstalling(true)
    try {
      const res = await invoke<{ status: number; body: string }>('fetch_url', {
        url: url.trim(),
        headers: {},
      })
      if (res.status !== 200) {
        setInstallError(`Téléchargement échoué (HTTP ${res.status}).`)
        return
      }
      // Sanity minimale (manuscrit `exports.default` ou bundle esbuild
      // `module.exports`) — la vraie validation est le chargement lui-même.
      if (!/exports/.test(res.body)) {
        setInstallError(
          'Le contenu téléchargé ne ressemble pas à un plugin MangaDesk (aucun `exports`).',
        )
        return
      }
      const sourcesDir = await invoke<string>('get_sources_dir')
      // Tente d'extraire `id` depuis la classe pour nommer le fichier proprement
      // ; fallback sur le dernier segment de l'URL.
      const idMatch = res.body.match(/\bid\s*=\s*['"`]([a-z0-9_-]+)['"`]/i)
      const fallback = url.trim().split(/[/?#]/).pop() ?? 'source'
      const fileBase = idMatch?.[1] ?? fallback.replace(/\.js$/i, '')
      const destPath = `${sourcesDir}/${fileBase}.js`
      await invoke('write_text_file', { path: destPath, content: res.body })
      const loaded = await loadSingleSource(destPath)
      if (!loaded) {
        setInstallError('Plugin chargé mais invalide (pas de classe valide trouvée).')
        await invoke('delete_file', { path: destPath }).catch(() => {})
      } else {
        setModal(null)
      }
    } catch (e) {
      console.error('[sources] install from url failed:', e)
      setInstallError(typeof e === 'string' ? e : 'Téléchargement impossible.')
    } finally {
      setInstalling(false)
      setTick((n) => n + 1)
    }
  }

  async function uninstall(sourceId: string, origin: InstalledSource['origin']): Promise<void> {
    if (origin === 'repo') await uninstallRepoSource(sourceId)
    else await uninstallExternalSource(sourceId)
    setTick((n) => n + 1)
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center justify-between py-1">
          <h3 className="text-xs font-semibold uppercase text-content-3">
            Sources installées
          </h3>
          <button
            type="button"
            onClick={() => {
              setInstallError(null)
              setModal('install')
            }}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
          >
            + Installer une source
          </button>
        </div>
        <div className="mt-2 flex flex-col divide-y divide-line/5">
          {installed.length === 0 && (
            <p className="py-3 text-xs text-content-4">Aucune source installée.</p>
          )}
          {installed.map(({ source, origin }) => (
            <div key={source.id} className="flex items-center gap-3 py-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-fill/10 text-xs font-semibold uppercase text-content">
                {source.name.slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-content">{source.name}</div>
                <div className="truncate text-xs text-content-4">
                  {source.id} · {source.baseUrl || '—'}
                </div>
              </div>
              {source.isNsfw && (
                <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] uppercase text-red-300">
                  18+
                </span>
              )}
              <span className="rounded-full bg-fill/10 px-2 py-0.5 text-[10px] uppercase text-content-3">
                {source.lang}
              </span>
              <span
                className={[
                  'rounded-full px-2 py-0.5 text-[10px]',
                  origin === 'builtin' ? 'bg-fill/10 text-content-3' : 'bg-accent/15 text-accent',
                ].join(' ')}
              >
                {origin === 'builtin' ? 'Intégrée' : origin === 'repo' ? 'Dépôt' : 'Installée'}
              </span>
              {origin !== 'builtin' ? (
                <button
                  type="button"
                  onClick={() => void uninstall(source.id, origin)}
                  className="rounded-lg bg-fill/5 px-3 py-1 text-xs text-red-300 hover:bg-red-500/15"
                >
                  Supprimer
                </button>
              ) : (
                <span className="w-[68px]" aria-hidden />
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="py-1">
          <h3 className="text-xs font-semibold uppercase text-content-3">Dépôts de sources</h3>
          <p className="mt-1 text-xs text-content-4">
            Un dépôt liste des sources installables en un clic (format{' '}
            <code>mangadesk-repo/1</code>, voir <code>repo/README.md</code>).
          </p>
        </div>
        <div className="mt-2 flex flex-col divide-y divide-line/5">
          {repos.length === 0 && (
            <p className="py-3 text-xs text-content-4">Aucun dépôt ajouté.</p>
          )}
          {repos.map((repo) => (
            <div key={repo.url} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-content">{repo.name}</div>
                <div className="truncate text-xs text-content-4">{repo.url}</div>
              </div>
              <button
                type="button"
                onClick={() => setBrowsing(repo)}
                className="rounded-lg bg-fill/10 px-3 py-1 text-xs text-content hover:bg-fill/20"
              >
                Parcourir
              </button>
              <button
                type="button"
                onClick={() => void handleRemoveRepo(repo.url)}
                className="rounded-lg bg-fill/5 px-3 py-1 text-xs text-red-300 hover:bg-red-500/15"
              >
                Retirer
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://…/index.json"
            className="min-w-0 flex-1 rounded-lg border border-line/10 bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={repoBusy || !repoUrl.trim()}
            onClick={() => void handleAddRepo()}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {repoBusy ? 'Ajout…' : 'Ajouter'}
          </button>
        </div>
        {repoError && <p className="mt-2 text-xs text-red-400">{repoError}</p>}
      </Card>

      <Card>
        <Row label="Afficher les sources 18+">
          {/* Même principe que Tachiyomi : le flag vient de l'extension
              (ContentWarning Keiyoushi → nsfw du plugin). Masque le sélecteur
              de Parcourir et les entrées 18+ des dépôts. */}
          <Toggle
            checked={showNsfwSources}
            onChange={(v) => update('showNsfwSources', v)}
          />
        </Row>
        <Row label={t('settings.checkInterval')}>
          <Select<UpdateInterval>
            value={updateInterval}
            onChange={changeInterval}
            options={[
              { value: 1, label: t('settings.hours', { count: 1 }) },
              { value: 6, label: t('settings.hours', { count: 6 }) },
              { value: 12, label: t('settings.hours', { count: 12 }) },
              { value: 24, label: t('settings.hours', { count: 24 }) },
              { value: 0, label: t('settings.never') },
            ]}
          />
        </Row>
        <Row label="">
          <button
            type="button"
            onClick={() => void invoke('trigger_update_now').catch(() => {})}
            className="rounded-lg bg-fill/10 px-3 py-1.5 text-sm text-content hover:bg-fill/20"
          >
            {t('settings.checkNow')}
          </button>
        </Row>
      </Card>

      {modal === 'install' && (
        <InstallSourceModal
          installing={installing}
          error={installError}
          onCancel={() => setModal(null)}
          onPickFile={() => void installFromFile()}
          onUrl={(u) => void installFromUrl(u)}
        />
      )}

      {browsing && (
        <RepoBrowserModal
          repo={browsing}
          onCancel={() => setBrowsing(null)}
          onChanged={() => setTick((n) => n + 1)}
        />
      )}
    </div>
  )
}

function RepoBrowserModal({
  repo,
  onCancel,
  onChanged,
}: {
  repo: RepoRef
  onCancel(): void
  onChanged(): void
}) {
  const [index, setIndex] = useState<RepoIndex | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** id en cours d'installation, ou '*' pour « tout installer ». */
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  // Réglage 18+ : les entrées NSFW du dépôt sont masquées ET exclues de
  // « Tout installer » quand il est désactivé (comportement Tachiyomi).
  const showNsfwSources = useSettingsStore((s) => s.showNsfwSources)
  const visibleSources = (index?.sources ?? []).filter((e) => showNsfwSources || !e.nsfw)
  const hiddenCount = (index?.sources.length ?? 0) - visibleSources.length

  useEffect(() => {
    let cancelled = false
    fetchRepoIndex(repo.url)
      .then((idx) => {
        if (!cancelled) setIndex(idx)
      })
      .catch((e) => {
        console.error('[repo] browse failed:', e)
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [repo.url])

  async function install(entry: RepoSourceEntry, update = false): Promise<void> {
    setBusy(entry.id)
    setErrors((prev) => ({ ...prev, [entry.id]: '' }))
    try {
      if (update) await updateRepoSource(entry, repo.url)
      else await installRepoSource(entry, repo.url)
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [entry.id]: e instanceof Error ? e.message : String(e),
      }))
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  async function installAll(): Promise<void> {
    if (!index) return
    setBusy('*')
    for (const entry of visibleSources) {
      if (SOURCE_REGISTRY[entry.id]) continue
      try {
        await installRepoSource(entry, repo.url)
      } catch (e) {
        setErrors((prev) => ({
          ...prev,
          [entry.id]: e instanceof Error ? e.message : String(e),
        }))
      }
    }
    setBusy(null)
    onChanged()
  }

  const missingCount = visibleSources.filter((e) => !SOURCE_REGISTRY[e.id]).length

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-line/10 bg-surface-raised p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Sources du dépôt ${repo.name}`}
      >
        <header className="mb-3 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-content">{repo.name}</h2>
            <p className="truncate text-xs text-content-4">{repo.url}</p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Fermer"
            className="ml-3 text-content-3 hover:text-content"
          >
            ✕
          </button>
        </header>

        {loadError && <p className="text-xs text-red-400">{loadError}</p>}
        {!index && !loadError && (
          <p className="py-4 text-sm text-content-3">Chargement du dépôt…</p>
        )}

        {index && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-content-4">
                {visibleSources.length} source(s) · {missingCount} installable(s)
                {hiddenCount > 0 && ` · ${hiddenCount} masquée(s) (18+)`}
              </span>
              <button
                type="button"
                disabled={busy !== null || missingCount === 0}
                onClick={() => void installAll()}
                className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {busy === '*' ? 'Installation…' : 'Tout installer'}
              </button>
            </div>
            <div className="flex flex-col divide-y divide-line/5 overflow-y-auto">
              {visibleSources.map((entry) => {
                const installed = SOURCE_REGISTRY[entry.id]
                const present = !!installed
                // Mise à jour proposée seulement pour les sources venues d'un
                // dépôt/plugin — jamais pour une intégrée au binaire.
                const fromRepo =
                  REPO_SOURCE_IDS.has(entry.id) || !!EXTERNAL_SOURCE_PATHS[entry.id]
                const updatable =
                  present && fromRepo && isNewerVersion(entry.version, installed.version)
                return (
                  <div key={entry.id} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-content">{entry.name}</span>
                        {entry.nsfw && (
                          <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] uppercase text-red-300">
                            18+
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-content-4">
                        {entry.baseUrl} · {entry.engine}
                      </div>
                      {errors[entry.id] && (
                        <p className="text-xs text-red-400">{errors[entry.id]}</p>
                      )}
                    </div>
                    <span className="rounded-full bg-fill/10 px-2 py-0.5 text-[10px] uppercase text-content-3">
                      {entry.lang}
                    </span>
                    {updatable ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void install(entry, true)}
                        className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        {busy === entry.id ? '…' : `Mettre à jour (${entry.version})`}
                      </button>
                    ) : present ? (
                      <span className="rounded-full bg-fill/10 px-2 py-0.5 text-[10px] text-content-3">
                        {fromRepo ? 'Installée' : 'Intégrée'}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void install(entry)}
                        className="rounded-lg bg-fill/10 px-3 py-1 text-xs text-content hover:bg-fill/20 disabled:opacity-50"
                      >
                        {busy === entry.id ? '…' : 'Installer'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function InstallSourceModal({
  installing,
  error,
  onCancel,
  onPickFile,
  onUrl,
}: {
  installing: boolean
  error: string | null
  onCancel(): void
  onPickFile(): void
  onUrl(url: string): void
}) {
  const [url, setUrl] = useState('')
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-xl border border-line/10 bg-surface-raised p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Installer une source"
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-content">Installer une source</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Fermer"
            className="text-content-3 hover:text-content"
          >
            ✕
          </button>
        </header>

        <section className="mb-4">
          <h3 className="mb-2 text-xs font-semibold uppercase text-content-3">
            Depuis un fichier local
          </h3>
          <button
            type="button"
            disabled={installing}
            onClick={onPickFile}
            className="rounded-lg bg-fill/10 px-3 py-2 text-sm text-content hover:bg-fill/20 disabled:opacity-50"
          >
            Sélectionner un fichier .js…
          </button>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase text-content-3">
            Depuis une URL
          </h3>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/source.js"
              className="min-w-0 flex-1 rounded-lg border border-line/10 bg-surface px-3 py-2 text-sm text-content outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={installing || !url.trim()}
              onClick={() => onUrl(url)}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Télécharger
            </button>
          </div>
        </section>

        {error && (
          <p className="mt-3 text-xs text-red-400">{error}</p>
        )}
        {installing && (
          <p className="mt-3 text-xs text-content-3">Installation en cours…</p>
        )}
      </div>
    </div>
  )
}

// --- Comptes ----------------------------------------------------------------

const ACCOUNT_PROVIDERS = [
  { id: 'anilist', label: 'AniList' },
  { id: 'mal', label: 'MyAnimeList' },
] as const

function AccountsTab() {
  const { t } = useTranslation()
  const [connected, setConnected] = useState<Record<string, boolean>>({})

  async function refresh() {
    const next: Record<string, boolean> = {}
    for (const p of ACCOUNT_PROVIDERS) {
      next[p.id] = await invoke<boolean>('tracker_connected', { provider: p.id }).catch(
        () => false,
      )
    }
    setConnected(next)
  }

  useEffect(() => {
    void refresh()
    // Rafraîchit le statut quand le flow OAuth aboutit (deep link → token stocké).
    const unlisten = listen('oauth:done', () => void refresh())
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {})
    }
  }, [])

  return (
    <Card>
      {ACCOUNT_PROVIDERS.map((p) => (
        <Row key={p.id} label={p.label}>
          <span className="text-xs text-content-3">
            {connected[p.id] ? t('settings.connected') : t('settings.notConnected')}
          </span>
          {connected[p.id] ? (
            <button
              type="button"
              onClick={async () => {
                await invoke('disconnect_tracker', { provider: p.id }).catch(() => {})
                void refresh()
              }}
              className="rounded-lg bg-fill/10 px-3 py-1.5 text-sm text-content hover:bg-fill/20"
            >
              {t('settings.disconnect')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void invoke('start_oauth', { provider: p.id }).catch(alert)}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white"
            >
              {t('settings.connect')}
            </button>
          )}
        </Row>
      ))}
    </Card>
  )
}

// --- Sauvegarde & Restauration ----------------------------------------------

interface ImportResult {
  mangasImported: number
  chaptersUpdated: number
  errors: string[]
}

function BackupTab() {
  const { t } = useTranslation()
  const [message, setMessage] = useState<string | null>(null)

  async function doExport() {
    try {
      const outputPath = await save({
        defaultPath: 'mangadesk-backup.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (!outputPath) return
      await invoke('export_backup', { outputPath })
      setMessage('Sauvegarde exportée.')
    } catch (e) {
      setMessage(`Erreur export : ${e}`)
    }
  }

  async function doImport() {
    try {
      const filePath = await open({
        multiple: false,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (typeof filePath !== 'string') return
      const result = await invoke<ImportResult>('import_backup', { filePath })
      setMessage(
        `Importé : ${result.mangasImported} manga(s), ${result.chaptersUpdated} chapitre(s) mis à jour` +
          (result.errors.length ? `, ${result.errors.length} erreur(s)` : ''),
      )
    } catch (e) {
      setMessage(`Erreur import : ${e}`)
    }
  }

  return (
    <Card>
      <Row label={t('settings.export')}>
        <button
          type="button"
          onClick={doExport}
          className="rounded-lg bg-fill/10 px-3 py-1.5 text-sm text-content hover:bg-fill/20"
        >
          {t('settings.export')}
        </button>
      </Row>
      <Row label={t('settings.import')}>
        <button
          type="button"
          onClick={doImport}
          className="rounded-lg bg-fill/10 px-3 py-1.5 text-sm text-content hover:bg-fill/20"
        >
          {t('settings.import')}
        </button>
      </Row>
      {message && <p className="py-2 text-xs text-content-3">{message}</p>}
    </Card>
  )
}

// --- Avancé -----------------------------------------------------------------

function AdvancedTab() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<string | null>(null)
  // Vraie version de l'app (depuis tauri.conf.json embarqué dans le binaire),
  // et non une chaîne codée en dur qui se désynchronise à chaque mise à jour.
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(''))
  }, [])

  async function clearCache() {
    await invoke('clear_cache').catch(() => {})
    setLogs(null)
  }

  async function purgeDb() {
    if (!window.confirm('Purger toute la base de données ? Action irréversible.')) return
    await invoke('purge_database').catch((e) => alert(String(e)))
  }

  async function viewLogs() {
    const content = await invoke<string>('read_logs').catch(() => '')
    setLogs(content || '(journal vide)')
  }

  return (
    <div className="space-y-6">
      <Card>
        <Row label={t('settings.clearCache')}>
          <button
            type="button"
            onClick={clearCache}
            className="rounded-lg bg-fill/10 px-3 py-1.5 text-sm text-content hover:bg-fill/20"
          >
            {t('settings.clearCache')}
          </button>
        </Row>
        <Row label={t('settings.purgeDb')}>
          <button
            type="button"
            onClick={purgeDb}
            className="rounded-lg bg-red-500/20 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/30"
          >
            {t('settings.purgeDb')}
          </button>
        </Row>
        <Row label={t('settings.viewLogs')}>
          <button
            type="button"
            onClick={viewLogs}
            className="rounded-lg bg-fill/10 px-3 py-1.5 text-sm text-content hover:bg-fill/20"
          >
            {t('settings.viewLogs')}
          </button>
        </Row>
      </Card>

      {logs !== null && (
        <pre className="max-h-72 overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-4 text-xs text-slate-200">
          {logs}
        </pre>
      )}

      <Card>
        <h3 className="py-1 text-xs font-semibold uppercase text-content-3">
          {t('settings.about')}
        </h3>
        <p className="py-1 text-sm text-content-2">
          MangaDesk{appVersion ? ` v${appVersion}` : ''}
        </p>
        <p className="text-xs text-content-4">
          Tauri 2 · React 18 · SQLite. Licences open source des dépendances incluses
          dans leurs paquets respectifs.
        </p>
      </Card>
    </div>
  )
}
