import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DemoSource } from './sources/demo'
import { MangaDexSource } from './sources/mangadex'
import { LelMangaSource } from './sources/lelmanga'
import { DemonicScansSource } from './sources/demonicscans'
import { MangasOriginesSource } from './sources/mangasorigines'
import { PantheonScanSource } from './sources/pantheonscan'
import { MangaScantradSource } from './sources/mangascantrad'
import { SushiScanSource } from './sources/sushiscan'
import { ScanMangaSource } from './sources/scanmanga'
import { SOURCE_REGISTRY, loadExternalSources } from './hooks/useSource'
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
SOURCE_REGISTRY['demo'] = new DemoSource()
SOURCE_REGISTRY['mangadex'] = new MangaDexSource()
SOURCE_REGISTRY['lelmanga'] = new LelMangaSource()
SOURCE_REGISTRY['demonicscans'] = new DemonicScansSource()
SOURCE_REGISTRY['mangasorigines'] = new MangasOriginesSource()
SOURCE_REGISTRY['pantheonscan'] = new PantheonScanSource()
SOURCE_REGISTRY['mangascantrad'] = new MangaScantradSource()
SOURCE_REGISTRY['sushiscan'] = new SushiScanSource()
SOURCE_REGISTRY['scanmanga'] = new ScanMangaSource()

// 2. Sources EXTERNES (dossier APPDATA) — chargement asynchrone. On les attend
// pour qu'elles soient disponibles dans le sélecteur Browse dès le 1er render.
// IIFE async pour éviter le top-level await (tsconfig target ES2020).
// En cas d'échec global (backend absent), on monte quand même l'app : seul le
// catalogue statique sera disponible.
void (async () => {
  try {
    await loadExternalSources()
  } catch (err) {
    console.warn('[main] loadExternalSources failed:', err)
  }
  // 3. Monter l'app après chargement des sources externes.
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})()
