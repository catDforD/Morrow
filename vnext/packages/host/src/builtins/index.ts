import modelSettings, { name, version } from './model-settings.js'

// Built-in plugins use the same ownership, services and contributions as installed plugins.
export const builtinPlugins = [{ name, version, plugin: modelSettings }]
