/**
 * peon-ping settings section: reads and writes the host through the plugin's
 * own `/peon/api` HTTP prefix (get / set / action), which the host bridges to
 * the pi `~/.config/peon-ping/` files and to pack install / preview /
 * refresh.
 *
 * A plugin-owned HTTP route is used instead of the `settingsScope` transport
 * because the harness apiproxy only exposes allowlisted settings namespaces to
 * web clients — a third-party namespace is filtered from `settings.describe`
 * and answers `settings-not-exposed` even when registered. The page talks to
 * the same host origin, so the browser-trust fence on `/peon/api` is
 * satisfied by ordinary same-origin fetches.
 *
 * The component deliberately imports no Host value modules — the namespace id
 * and value shape are restated here (type-only), so the browser bundle stays
 * free of node-only imports.
 * @module dsh-reminder/client/PeonSettingsSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PeonKey } from './locales.ts'
import css from './PeonSettingsSection.module.css'

/** Client-side mirror of the host settings section (type-only). */
export interface PeonSettingsValue {
  default_pack: string
  volume: number
  enabled: boolean
  desktop_notifications: boolean
  tool_error_sounds: boolean
  silent_window_seconds: number
  relay_mode: 'auto' | 'local' | 'relay'
  paused: boolean
  categories: Record<string, boolean>
  packs: string[]
  _action: string
  _notice: string
}

/** Full component props: owner props (close) + injected translation face. */
export interface PeonSectionProps {
  /** Close the settings panel (shell affordance). */
  close: () => void
  /** Bound dictionary lookup. */
  t: (key: PeonKey) => string
}

/** Category keys in the order the pi settings panel lists them. */
const CATEGORIES: { key: string; label: PeonKey }[] = [
  { key: 'session.start', label: 'cat.session.start' },
  { key: 'task.acknowledge', label: 'cat.task.acknowledge' },
  { key: 'task.complete', label: 'cat.task.complete' },
  { key: 'task.error', label: 'cat.task.error' },
  { key: 'input.required', label: 'cat.input.required' },
  { key: 'resource.limit', label: 'cat.resource.limit' },
  { key: 'user.spam', label: 'cat.user.spam' },
]

/** One `/peon/api` response envelope. */
interface PeonApiResponse {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

/** Call one `/peon/api/<method>` endpoint on the same origin. */
async function peonCall<T>(method: string, payload: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/peon/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (error) {
    throw new Error(`peon-ping: network error: ${error instanceof Error ? error.message : String(error)}`)
  }
  const parsed = (await response.json().catch(() => null)) as PeonApiResponse | null
  if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
    throw new Error(parsed?.error?.message ?? `peon-ping: HTTP ${response.status}`)
  }
  return parsed.value as T
}

/** Read the current section from the host. */
async function fetchSection(): Promise<PeonSettingsValue> {
  return peonCall<PeonSettingsValue>('get', {})
}

/** Write one scalar field (categories is written whole) and return the fresh section. */
async function setField(field: keyof PeonSettingsValue, value: unknown): Promise<PeonSettingsValue> {
  return peonCall<PeonSettingsValue>('set', { field, value })
}

/** Trigger one host action (install / preview / refresh) and return the fresh section. */
async function runAction(action: string): Promise<PeonSettingsValue> {
  return peonCall<PeonSettingsValue>('action', { action })
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.row}>
      <span className={css.label}>{label}</span>
      <span className={css.control}>{children}</span>
    </div>
  )
}

function Toggle({ on, onChange, onText, offText }: {
  on: boolean
  onChange: (next: boolean) => void
  onText: string
  offText: string
}): ReactNode {
  return (
    <button
      type="button"
      className={`${css.toggle} ${on ? css.toggleOn : ''}`}
      onClick={() => onChange(!on)}
    >
      {on ? onText : offText}
    </button>
  )
}

export function PeonSettingsSection(props: PeonSectionProps): ReactNode {
  const { t } = props
  const [value, setValue] = useState<PeonSettingsValue | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const mounted = useRef(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await fetchSection()
      if (!mounted.current) return
      setValue(next)
      setStatus('ready')
      setError(null)
    } catch (cause) {
      if (!mounted.current) return
      setStatus('error')
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])

  if (status === 'loading' && value === null) {
    return <div className={css.wrap}>{t('notice')}…</div>
  }
  if (status === 'error' || value === null) {
    return <div className={css.wrap}>{t('notice')}: {error ?? t('unavailable')}</div>
  }

  const set = (field: keyof PeonSettingsValue, next: unknown): void => {
    void setField(field, next).then(refresh).catch((cause: unknown) => {
      setStatus('error')
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  const trigger = (action: string): void => {
    setPending(true)
    void runAction(action).then(refresh).catch((cause: unknown) => {
      setStatus('error')
      setError(cause instanceof Error ? cause.message : String(cause))
    }).finally(() => {
      setPending(false)
    })
  }

  const activePack = value.packs.includes(value.default_pack) ? value.default_pack : value.packs[0]

  return (
    <div className={css.wrap}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.description}>{t('description')}</p>

      {value._notice !== '' ? (
        <div className={css.notice}>
          {t('notice')}: {value._notice}
        </div>
      ) : null}

      <Row label={`${t('sounds')} (${t(value.paused ? 'paused' : 'active')})`}>
        <Toggle
          on={value.enabled}
          onChange={(next) => set('enabled', next)}
          onText={t('enabled')}
          offText={t('disabled')}
        />
        <Toggle
          on={!value.paused}
          onChange={(next) => set('paused', !next)}
          onText={t('active')}
          offText={t('paused')}
        />
      </Row>

      <Row label={t('soundPack')}>
        <select
          className={css.select}
          value={activePack ?? ''}
          onChange={(event) => set('default_pack', event.target.value)}
        >
          {value.packs.length === 0 ? (
            <option value="">{t('noPacks')}</option>
          ) : (
            value.packs.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))
          )}
        </select>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => trigger('install')}
        >
          {pending ? t('installing') : t('install')}
        </Button>
        <Button
          variant="outline"
          disabled={pending || value.packs.length === 0}
          onClick={() => trigger('preview')}
        >
          {t('preview')}
        </Button>
      </Row>

      <Row label={`${t('volume')}: ${Math.round(value.volume * 100)}%`}>
        <input
          type="range"
          min={0}
          max={100}
          step={10}
          value={Math.round(value.volume * 100)}
          onChange={(event) => set('volume', Number(event.target.value) / 100)}
          className={css.range}
        />
      </Row>

      <Row label={t('notifications')}>
        <Toggle
          on={value.desktop_notifications}
          onChange={(next) => set('desktop_notifications', next)}
          onText={t('enabled')}
          offText={t('disabled')}
        />
      </Row>

      <Row label={t('toolErrorAlert')}>
        <Toggle
          on={value.tool_error_sounds}
          onChange={(next) => set('tool_error_sounds', next)}
          onText={t('enabled')}
          offText={t('disabled')}
        />
      </Row>

      <Row label={t('silentWindow')}>
        <input
          type="number"
          min={0}
          max={300}
          value={value.silent_window_seconds}
          onChange={(event) => set('silent_window_seconds', Number(event.target.value) || 0)}
          className={css.number}
        />
      </Row>

      <Row label={t('relayMode')}>
        <select
          className={css.select}
          value={value.relay_mode}
          onChange={(event) => set('relay_mode', event.target.value)}
        >
          <option value="auto">auto</option>
          <option value="local">local</option>
          <option value="relay">relay</option>
        </select>
      </Row>

      <div className={css.categories}>
        <div className={css.catLabel}>{t('category')}</div>
        {CATEGORIES.map(({ key, label }) => (
          <div key={key} className={css.catRow}>
            <span>{t(label)}</span>
            <Toggle
              on={value.categories[key] !== false}
              onChange={(next) => {
                const nextCategories = { ...value.categories, [key]: next }
                set('categories', nextCategories)
              }}
              onText={t('enabled')}
              offText={t('disabled')}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
