/**
 * Settings section bridge for the dsh-reminder web settings page.
 *
 * The web GUI's Settings page (client half of this package) reads and writes
 * the host through this plugin's own `/peon/api` HTTP route — not through a
 * settings namespace, because the harness apiproxy only exposes allowlisted
 * namespaces to web clients (third-party namespaces are filtered even when
 * registered). The host bridges the section to the same
 * `~/.config/peon-ping/config.json` + `state.json` files the pi plugin uses,
 * so event handlers and pi stay in sync.
 *
 * The section carries the full config plus three host-maintained fields:
 * - `packs`   — installed pack names (host writes after install/refresh)
 * - `_action` — client→host command field (`install[:<names>]`, `preview`,
 *   `refresh`); the host executes it and clears it
 * - `_notice` — host→client one-line result (install report, preview label)
 *
 * @module dsh-reminder/settings
 */

import { DEFAULT_CONFIG } from './constants.ts'
import type { PeonConfig, PeonState, RelayMode } from './types.ts'

/** All fields the web settings page exposes, plus host-maintained ones. */
export interface PeonSettings {
  default_pack: string
  volume: number
  enabled: boolean
  desktop_notifications: boolean
  tool_error_sounds: boolean
  silent_window_seconds: number
  relay_mode: RelayMode
  paused: boolean
  categories: Record<string, boolean>
  packs: string[]
  _action: string
  _notice: string
}

/** Namespace id string (kept for logs and the client-side mirror). */
export const PEON_SETTINGS_NS_ID = 'peon-ping'

/** Build the initial (base-layer) section from the current files. */
export function buildSettingsEntry(
  config: PeonConfig,
  state: PeonState,
  packs: string[],
): PeonSettings {
  return {
    default_pack: config.default_pack,
    volume: config.volume,
    enabled: config.enabled,
    desktop_notifications: config.desktop_notifications,
    tool_error_sounds: config.tool_error_sounds,
    silent_window_seconds: config.silent_window_seconds,
    relay_mode: config.relay_mode,
    paused: state.paused,
    categories: { ...config.categories },
    packs,
    _action: '',
    _notice: '',
  }
}

/**
 * Extract the pi config-file fields from a settings section, preserving any
 * fields the web page does not expose (annoyed_*, playback_wait_seconds) from
 * the current file when writing back.
 */
export function configFromSettings(section: PeonSettings, current: PeonConfig): PeonConfig {
  return {
    ...current,
    default_pack: section.default_pack,
    volume: section.volume,
    enabled: section.enabled,
    desktop_notifications: section.desktop_notifications,
    tool_error_sounds: section.tool_error_sounds,
    silent_window_seconds: section.silent_window_seconds,
    relay_mode: section.relay_mode,
    categories: { ...section.categories },
  }
}

/** Default config used when the file is absent (mirrors DEFAULT_CONFIG). */
export function defaultConfig(): PeonConfig {
  return { ...DEFAULT_CONFIG, categories: { ...DEFAULT_CONFIG.categories } }
}

/** Whether a section carries any client-driven change the host must act on. */
export function hasAction(section: PeonSettings): boolean {
  return typeof section._action === 'string' && section._action.length > 0
}

/** Parse the `_action` field into a command and optional pack names. */
export function parseAction(action: string): { command: string; names: string[] } {
  const [command, rest = ''] = action.split(':', 2)
  const names = rest.split(',').map((name) => name.trim()).filter(Boolean)
  return { command: command || '', names }
}
