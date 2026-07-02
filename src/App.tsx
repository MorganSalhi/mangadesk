import { useEffect, useRef, useState } from 'react'
import {
  createHashRouter,
  NavLink,
  Outlet,
  RouterProvider,
} from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import Library from './pages/Library'
import Browse from './pages/Browse'
import Updates from './pages/Updates'
import History from './pages/History'
import Downloads from './pages/Downloads'
import Settings from './pages/Settings'
import Stats from './pages/Stats'
import Reader from './pages/Reader'
import MangaDetail from './pages/MangaDetail'
import Calendar from './pages/Calendar'
import Modal from './components/ui/Modal'
import { SOURCE_REGISTRY } from './hooks/useSource'
import { useDownloadStore } from './store/downloadStore'
import { useReaderStore } from './store/readerStore'
import { useSettingsStore } from './store/settingsStore'
import { applyTheme, applyAccent } from './lib/appearance'
import { checkForAppUpdate } from './lib/appUpdate'
import i18n from './i18n'
import type { Chapter } from './types'

// ----------------------------------------------------------------------------
// Icônes minimales (inline SVG, pas de dépendance externe)
// ----------------------------------------------------------------------------
type IconProps = { d: string }
function Icon({ d }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

const ICONS = {
  library: 'M4 5v14M9 5v14M14 6l5 13M4 5h5M9 5h5l5 14',
  browse: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-5-5',
  updates: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  history: 'M3 12a9 9 0 1 0 9-9 9 9 0 0 0-9 9ZM3 12H1m11-5v5l3 2',
  downloads: 'M12 3v12m0 0l-4-4m4 4l4-4M5 21h14',
  calendar: 'M8 2v4M16 2v4M3 8h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  stats: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-4l-.3 2.5a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L4.1 11a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6a7 7 0 0 0 .1-1Z',
}

function Sidebar() {
  const { t } = useTranslation()
  const [newCount, setNewCount] = useState(0)
  const lastSeenUpdates = useSettingsStore((s) => s.lastSeenUpdates)

  // Badge « nouveaux chapitres » : chapitres non lus fetchés depuis la dernière
  // ouverture de la page Mises à jour.
  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const count = await invoke<number>('get_new_chapter_count', {
          since: lastSeenUpdates,
        })
        if (!cancelled) setNewCount(count)
      } catch {
        /* backend absent */
      }
    }
    void refresh()
    const unlisten = listen('updater:done', () => void refresh())
    return () => {
      cancelled = true
      void unlisten.then((fn) => fn()).catch(() => {})
    }
  }, [lastSeenUpdates])

  const items = [
    { to: '/', label: t('nav.library'), icon: ICONS.library, end: true, badge: 0 },
    { to: '/browse', label: t('nav.browse'), icon: ICONS.browse, end: false, badge: 0 },
    {
      to: '/updates',
      label: t('nav.updates'),
      icon: ICONS.updates,
      end: false,
      badge: newCount,
    },
    { to: '/history', label: t('nav.history'), icon: ICONS.history, end: false, badge: 0 },
    {
      to: '/downloads',
      label: t('settings.tabs.downloads'),
      icon: ICONS.downloads,
      end: false,
      badge: 0,
    },
    { to: '/calendar', label: 'Calendrier', icon: ICONS.calendar, end: false, badge: 0 },
    { to: '/stats', label: 'Statistiques', icon: ICONS.stats, end: false, badge: 0 },
    { to: '/settings', label: t('nav.settings'), icon: ICONS.settings, end: false, badge: 0 },
  ]

  return (
    <nav
      className="flex w-60 shrink-0 flex-col gap-1 border-r border-line/5 bg-surface-sunken p-3"
      aria-label="Navigation principale"
    >
      <div className="px-3 py-4 text-lg font-semibold tracking-tight text-content">
        MangaDesk
      </div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            [
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-accent/15 text-accent'
                : 'text-content-3 hover:bg-fill/5 hover:text-content',
            ].join(' ')
          }
        >
          <Icon d={item.icon} />
          <span className="flex-1">{item.label}</span>
          {item.badge > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-white">
              {item.badge}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

/**
 * Effets globaux montés une seule fois : listeners téléchargements / mises à
 * jour / deep link OAuth, et application thème + accent.
 */
function useGlobalEffects() {
  const initListeners = useDownloadStore((s) => s.initListeners)
  const theme = useSettingsStore((s) => s.theme)
  const accentColor = useSettingsStore((s) => s.accentColor)
  const language = useSettingsStore((s) => s.language)
  const maxConcurrentDownloads = useSettingsStore((s) => s.maxConcurrentDownloads)
  const updateInterval = useSettingsStore((s) => s.updateInterval)
  const hydrateIncognito = useSettingsStore((s) => s.hydrateIncognitoFromBackend)

  // Récupère la dernière valeur d'incognito persistée côté SQLite (au cas où le
  // store local aurait été purgé). À ne faire qu'une fois au montage.
  useEffect(() => {
    void hydrateIncognito()
    // Vérifie une éventuelle mise à jour de l'app (best-effort, non bloquant).
    void checkForAppUpdate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apparence (thème + accent).
  useEffect(() => {
    applyTheme(theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => theme === 'system' && applyTheme(theme)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])

  useEffect(() => {
    applyAccent(accentColor)
  }, [accentColor])

  // Listeners backend (téléchargements + bridge mises à jour + deep link).
  useEffect(() => {
    initListeners((sourceId) => SOURCE_REGISTRY[sourceId] ?? null)

    const unlistenUpdater = listen<{ mangaId: string; sourceId: string }[]>(
      'updater:check',
      async (event) => {
        for (const { mangaId, sourceId } of event.payload) {
          const source = SOURCE_REGISTRY[sourceId]
          if (!source) continue
          try {
            const chapters: Chapter[] = await source.getChapterList(mangaId)
            await invoke('report_chapter_update', { mangaId, chapters })
          } catch (e) {
            console.error('updater bridge', e)
          }
        }
      },
    )

    const unlistenDeepLink = listen<string>('deep-link:received', (event) => {
      try {
        const url = new URL(event.payload)
        const provider = url.pathname.replace(/^\/+/, '') || url.host
        let code: string | null = null
        if (url.hash) {
          code = new URLSearchParams(url.hash.slice(1)).get('access_token')
        }
        if (!code) code = url.searchParams.get('code')
        if (provider && code) {
          void invoke('complete_oauth', { provider, code }).catch(console.error)
        }
      } catch (e) {
        console.error('deep link parse', e)
      }
    })

    return () => {
      void unlistenUpdater.then((fn) => fn()).catch(() => {})
      void unlistenDeepLink.then((fn) => fn()).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Synchronise la langue i18n avec le réglage persisté.
  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language)
  }, [language])

  // Pousse les réglages persistés (localStorage) vers le backend qui démarre
  // sur ses propres valeurs par défaut : concurrence de téléchargement et
  // intervalle de vérification des mises à jour.
  useEffect(() => {
    void invoke('set_max_concurrent', { value: maxConcurrentDownloads }).catch(() => {})
  }, [maxConcurrentDownloads])

  useEffect(() => {
    void invoke('set_update_interval', { hours: updateInterval }).catch(() => {})
  }, [updateInterval])
}

/**
 * Confirmation de fermeture. La croix de la fenêtre est interceptée côté Rust
 * (`on_window_event` → prevent_close + event `app:close-requested`) : sans
 * cela, les WebViews solveurs Cloudflare cachés maintiennent le process en
 * vie en arrière-plan. La sortie effective passe par `exit_app` (app.exit),
 * qui termine tout, fenêtres cachées comprises.
 */
function ExitConfirm() {
  const [visible, setVisible] = useState(false)
  const confirmBeforeExit = useSettingsStore((s) => s.confirmBeforeExit)
  const activeDownloads = useDownloadStore((s) =>
    s.queue.some((t) => t.status === 'downloading' || t.status === 'queued'),
  )
  // Le listener est monté une seule fois : il lit le réglage via une ref pour
  // toujours voir la valeur courante.
  const confirmRef = useRef(confirmBeforeExit)
  useEffect(() => {
    confirmRef.current = confirmBeforeExit
  }, [confirmBeforeExit])

  useEffect(() => {
    const unlisten = listen('app:close-requested', () => {
      if (confirmRef.current) setVisible(true)
      else void invoke('exit_app').catch(() => {})
    })
    return () => {
      void unlisten.then((fn) => fn()).catch(() => {})
    }
  }, [])

  if (!visible) return null
  return (
    <Modal title="Quitter MangaDesk ?" onClose={() => setVisible(false)}>
      <p className="text-sm text-content-3">
        L’application va se fermer complètement.
        {activeDownloads && (
          <>
            {' '}
            <span className="font-medium text-content">
              Des téléchargements sont en cours
            </span>{' '}
            : ils seront interrompus.
          </>
        )}
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="rounded-lg bg-fill/10 px-4 py-2 text-sm font-medium text-content hover:bg-fill/20"
        >
          Annuler
        </button>
        <button
          type="button"
          onClick={() => void invoke('exit_app').catch(() => {})}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
        >
          Quitter
        </button>
      </div>
    </Modal>
  )
}

function Layout() {
  useGlobalEffects()
  // En plein écran (lecteur immersif), on retire la sidebar pour libérer
  // toute la largeur. Cf. readerStore.isFullscreen.
  const isFullscreen = useReaderStore((s) => s.isFullscreen)
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface">
      {!isFullscreen && <Sidebar />}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <ExitConfirm />
    </div>
  )
}

// createHashRouter : obligatoire avec Tauri (createBrowserRouter incompatible
// avec le protocole asset/fichier servi par la webview).
const router = createHashRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Library /> },
      { path: 'browse', element: <Browse /> },
      { path: 'updates', element: <Updates /> },
      { path: 'history', element: <History /> },
      { path: 'downloads', element: <Downloads /> },
      { path: 'calendar', element: <Calendar /> },
      { path: 'stats', element: <Stats /> },
      { path: 'settings', element: <Settings /> },
      { path: 'manga/:sourceId/:mangaId', element: <MangaDetail /> },
      { path: 'reader/:mangaId/:chapterId/:sourceId', element: <Reader /> },
    ],
  },
])

export default function App() {
  return <RouterProvider router={router} />
}
