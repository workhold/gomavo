import { command } from '../api'

/** MGLand's own package format. This is not a VS Code or JetBrains extension. */
export interface NativePluginManifest {
  id: string
  name: string
  version: string
  description: string
  main: 'main.js'
  activationEvents: string[]
  contributes: {
    commands: { command: string; title: string }[]
  }
}

export interface InstalledNativePlugin {
  manifest: NativePluginManifest
  enabled: boolean
  installedAt: string
}

export function listNativePlugins(): Promise<InstalledNativePlugin[]> {
  return command('list_native_plugins')
}

export function installNativePlugin(path: string, replace = false): Promise<InstalledNativePlugin> {
  return command('install_native_plugin', { path, replace })
}

export function setNativePluginEnabled(id: string, enabled: boolean): Promise<void> {
  return command('set_native_plugin_enabled', { id, enabled })
}

export function removeNativePlugin(id: string): Promise<void> {
  return command('remove_native_plugin', { id })
}

export function readNativePluginCode(id: string): Promise<string> {
  return command('read_native_plugin_code', { id })
}
