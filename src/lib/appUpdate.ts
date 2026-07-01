import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { ask, message } from '@tauri-apps/plugin-dialog'

// ============================================================================
// Mise à jour automatique de l'application.
//
// Interroge l'endpoint configuré dans tauri.conf.json (latest.json de la
// dernière GitHub Release). Si une version signée plus récente existe, propose
// de l'installer puis relance l'app. Best-effort : silencieux hors ligne, sans
// release, ou en `pnpm dev` (backend Tauri absent).
// ============================================================================

let checked = false

export async function checkForAppUpdate(): Promise<void> {
  // Une seule vérification par session (le composant racine peut re-monter).
  if (checked) return
  checked = true
  try {
    const update = await check()
    if (!update) return
    const yes = await ask(
      `La version ${update.version} est disponible ` +
        `(actuelle : ${update.currentVersion}).\n\n` +
        `${update.body ?? ''}\n\nInstaller maintenant ?`,
      { title: 'Mise à jour disponible', kind: 'info' },
    )
    if (!yes) return
    await update.downloadAndInstall()
    await message('Mise à jour installée. L’application va redémarrer.', {
      title: 'MangaDesk',
    })
    await relaunch()
  } catch (e) {
    // Pas de release / hors ligne / backend absent → on ignore silencieusement.
    console.debug('[appUpdate] vérification ignorée :', e)
  }
}
