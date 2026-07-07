// ============================================================================
// Shim de build (alias esbuild de '@tauri-apps/api/core').
//
// Un plugin est évalué via `new Function` : aucun import possible à l'exécution.
// L'API Tauri y est donc atteinte par le global `window.__TAURI__`, exposé par
// `app.withGlobalTauri: true` (tauri.conf.json). Ce shim donne aux moteurs
// bundlés la même signature `invoke` que le vrai module.
// ============================================================================

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

interface TauriGlobal {
  core: { invoke: Invoke }
}

export const invoke: Invoke = (cmd, args) => {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  if (!tauri?.core?.invoke) {
    return Promise.reject(
      new Error('API Tauri globale absente — `app.withGlobalTauri` doit être activé.'),
    )
  }
  return tauri.core.invoke(cmd, args)
}
