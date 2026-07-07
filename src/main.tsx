import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { MangaDexSource } from './sources/mangadex'
import { LelMangaSource } from './sources/lelmanga'
import { DemonicScansSource } from './sources/demonicscans'
import { MangasOriginesSource } from './sources/mangasorigines'
import { PantheonScanSource } from './sources/pantheonscan'
import { MangaScantradSource } from './sources/mangascantrad'
import { SushiScanSource } from './sources/sushiscan'
import { ScanMangaSource } from './sources/scanmanga'
import { SOURCE_REGISTRY, loadExternalSources } from './hooks/useSource'
import { loadRepoSources } from './sources/repo'
import { useSettingsStore } from './store/settingsStore'
import { applyTheme, applyAccent } from './lib/appearance'
import './i18n'
import './index.css'

// Applique thème + accent AVANT le render pour éviter un flash clair au boot
// (zustand/persist hydrate localStorage de façon synchrone).
const initialSettings = useSettingsStore.getState()
applyTheme(initialSettings.theme)
applyAccent(initialSettings.accentColor)

// ----------------------------------------------------------------------------
// Ordre d'initialisation — CRITIQUE
// Le registre des sources DOIT être peuplé AVANT createRoot().render().
// Un accès au registre pendant le render d'un enfant avant ce point = null.
// ----------------------------------------------------------------------------

// 1. Sources STATIQUES — disponibles synchroniquement, pas de dépendance disque.
// L'ordre d'insertion pilote l'ordre d'affichage dans « Parcourir »
// (Object.values(SOURCE_REGISTRY)). Mangas Origines en tête, MangaDex en dernier.
SOURCE_REGISTRY['mangasorigines'] = new MangasOriginesSource()
SOURCE_REGISTRY['lelmanga'] = new LelMangaSource()
SOURCE_REGISTRY['demonicscans'] = new DemonicScansSource()
SOURCE_REGISTRY['pantheonscan'] = new PantheonScanSource()
SOURCE_REGISTRY['mangascantrad'] = new MangaScantradSource()
SOURCE_REGISTRY['sushiscan'] = new SushiScanSource()
SOURCE_REGISTRY['scanmanga'] = new ScanMangaSource()
SOURCE_REGISTRY['mangadex'] = new MangaDexSource()

// 2. Sources EXTERNES (dossier APPDATA) — chargement asynchrone. On les attend
// pour qu'elles soient disponibles dans le sélecteur Browse dès le 1er render.
// IIFE async pour éviter le top-level await (tsconfig target ES2020).
// En cas d'échec global (backend absent), on monte quand même l'app : seul le
// catalogue statique sera disponible.
void (async () => {
  // Plugins .js et sources de dépôt (repos.json) sont indépendants → parallèle.
  await Promise.all([
    loadExternalSources().catch((err) =>
      console.warn('[main] loadExternalSources failed:', err),
    ),
    loadRepoSources().catch((err) => console.warn('[main] loadRepoSources failed:', err)),
  ])
  // 3. Monter l'app après chargement des sources externes.
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})()
