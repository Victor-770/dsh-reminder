/**
 * dsh-reminder settings section, browser half.
 *
 * Registers the "peon-ping sounds" page in web Settings right below
 * "Agent Presets" (`settings.section` order 21; agent-presets is 20). The
 * page reads and writes the host through the plugin's own `/peon/api` HTTP
 * prefix (get / set / action) instead of a settings namespace: the harness
 * apiproxy only exposes allowlisted settings namespaces to web clients, so
 * third-party namespaces are filtered out even when registered. The route is
 * served by this plugin's host half on the same origin, so the page needs no
 * settings-scope transport.
 *
 * The browser context is the plain cordis `Context` with the `slots` and
 * `locale` services seated by the shell (dsh 0.2 has no client-runtime
 * package); the type-only imports below carry those services' declarations.
 *
 * @module dsh-reminder/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only service vocabulary: ctx.slots lives on the renderer's
// SlotRegistry, ctx.locale on the locale package's LocaleRuntime, and the
// `settings.section` slot declaration on the ui-settings contract. All are
// erased at runtime — the shell seats the services themselves.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PeonSettingsSection, type PeonSectionProps } from './PeonSettingsSection.tsx'
import { en, zh, type PeonKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** peon-ping sounds settings copy. */
    'settings.peon': PeonKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.peon'

/** Services required by the settings section (copy + slot declaration only). */
export const inject = ['slots', 'locale']

/** Contribute the peon-ping sounds settings page. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-reminder: copy dictionaries')

  const t = ctx.locale.bind(NS)
  const injected = (): PeonSectionProps => ({ t, close: () => {} })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'peon-ping',
    order: 21,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, PeonSettingsSection))
}
