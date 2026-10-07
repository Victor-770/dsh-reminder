/**
 * peon-ping for DeepSeek Harness — a faithful port of the pi plugin
 * `pi-peon-ping-win` (https://github.com/Gohan/pi-peon-ping-win).
 *
 * Plays themed audio clips from OpenPeon sound packs on lifecycle events and
 * shows desktop notifications. The pi event mapping:
 *
 *   pi `session_start`          → dsh `session/created` (top-level sessions)
 *   pi `before_agent_start`     → dsh `user/message` (kind 'user'; prompt capture)
 *   pi `agent_start`            → dsh `turn/start` (spam detection + ack)
 *   pi `tool_execution_end` err → dsh `tool/result` with isError (0.2: a
 *                                 first-class `role: 'tool'` message)
 *   pi `agent_end`              → dsh `turn/end` (task complete + summary popup)
 *   pi `session_compact`        → dsh `compaction/end` (fires AFTER compaction)
 *
 * The pi TUI settings/install panels move into the web GUI: the Settings
 * page (the client half of this package) reads and writes the `peon-ping`
 * settings namespace, placed right below "Agent Presets" in Settings.
 *
 * Config and state stay in `~/.config/peon-ping/` — the same files the pi
 * plugin uses — so packs and settings are shared between pi and dsh.
 *
 * @module dsh-reminder
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'

// Type-level: merges `compaction/end` into the SessionEventMap vocabulary
// (mirrors @deepseek-ai/dsh-compaction/types; no runtime import).
import './src/compaction-events.ts'

import { playCategorySound, sendNotification } from './src/audio.ts'
import { ensureDirs, loadConfig, loadState, saveConfig, saveState } from './src/config.ts'
import { RECOMMENDED_PACK } from './src/constants.ts'
import { buildNotifyContent, extractAssistantText, extractToolErrorText, resolveProjectName } from './src/notify-content.ts'
import { listPacks } from './src/packs.ts'
import { checkRelayHealth, detectRemoteSession, getRelayUrl, relaySetupInstructions } from './src/relay.ts'
import { previewPackSound, runInstall } from './src/ui.ts'
import {
  buildSettingsEntry,
  configFromSettings,
  parseAction,
  type PeonSettings,
} from './src/settings.ts'
import type { PeonConfig, PeonState } from './src/types.ts'

export const name = 'peon-ping'

/** Structural session-title service (optional; popup project name). */
interface SessionTitleLike {
  get(session: Session): { title: string } | undefined
}

/**
 * Structural `webServer` service (host HTTP routes): the settings page of
 * this plugin talks to the host through its own `/peon/api` HTTP prefix
 * instead of the apiproxy `settings.*` RPC channel — the harness exposes only
 * an allowlisted set of settings namespaces to web clients
 * (`dsh-host-apiproxy`'s `WEB_SETTINGS_NAMESPACES`), and third-party
 * namespaces are filtered out (answered `settings-not-exposed`) even when
 * registered. A plugin-owned HTTP route is the supported way around that.
 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Structural `webRuntime` service: trusted browser authorities for the fence. */
interface WebRuntimeLike {
  trustedHosts: readonly string[]
}

/** Text of one content-block array (user prompts). */
function blocksText(content: readonly unknown[] | undefined): string {
  if (!content || !Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: string }).type === 'text')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Whether a session is a top-level (non-subagent) session.
 *
 * A live top-level session has no `delegationDepth` (undefined); only
 * `dsh-subagent` sets it, to `parent + 1` (>= 1) for child sessions. However
 * the JSONL persistence layer normalizes the header on save
 * (`delegationDepth ?? 0` in dsh-session-persistence-jsonl) and restores the
 * explicit `0` on load, so a resumed conversation must still count as
 * top-level — treating `0` as subagent would silence every hook after a host
 * restart.
 */
function isTopLevel(session: Session): boolean {
  const depth = session.header.delegationDepth
  return depth === undefined || depth === 0
}

/** Short human label for an unexpected turn end (popup body). */
function turnEndFailureLabel(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'aborted':
      return 'Task cancelled'
    case 'error': {
      const message = reason.error?.message
      return message !== undefined && message.length > 0 ? `Task failed: ${message}` : 'Task failed'
    }
    case 'blocked':
      return 'Task blocked'
    case 'max-tokens':
      return 'Task hit the token limit'
    case 'interrupted':
      return 'Task interrupted'
    default:
      return 'Task ended unexpectedly'
  }
}

// --- /peon/api web route helpers (the settings page's transport) -----------

/** JSON response envelope the client bundle expects (`{ok, value}` / `{ok, error}`). */
interface ApiResponse {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

function writeJson(res: ServerResponse, status: number, body: ApiResponse): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function writeOk(res: ServerResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** Read a bounded JSON request body (the settings page sends tiny payloads). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('invalid JSON body')
  }
}

/**
 * Same browser-trust fence as the shell's own route mounts: the request must
 * come from a loopback or trusted authority, must not be a cross-site fetch,
 * and (when a browser sends one) its origin must match the Host header.
 */
function isTrustedRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const hostname = host.replace(/:\d+$/, '').toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  if (!loopback) {
    const trusted = (trustedHosts ?? []).some((authority) => authority.replace(/:\d+$/, '').toLowerCase() === hostname)
    if (!trusted) return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function apply(ctx: Context): void {
  ensureDirs()
  let config: PeonConfig = loadConfig()
  let state: PeonState = loadState()
  let installing = false

  // Per-session runtime facts (the pi plugin tracked these globally because
  // it had exactly one session per process; the harness hosts many). The
  // 0.2 session log is append-only with no synchronous event access, so the
  // facts other events carry are tracked from the firehose instead of read
  // back from the log.
  const sessionStartTimes = new WeakMap<Session, number>()
  const currentPrompts = new WeakMap<Session, string>()
  /** callId → tool name, recorded from `tool/call` (results carry only the callId). */
  const toolCallNames = new WeakMap<Session, Map<string, string>>()
  /** Most recent non-empty assistant text, for the completion popup body. */
  const lastAssistantTexts = new WeakMap<Session, string>()

  /** Look up the tool name for a `tool/result` from the tracked `tool/call` records. */
  const toolNameFor = (session: Session, callId: unknown): string => {
    if (typeof callId !== 'string') return 'tool'
    return toolCallNames.get(session)?.get(callId) ?? 'tool'
  }

  const hasPacks = () => listPacks().length > 0

  const shouldPlaySounds = () => {
    if (installing) return false
    const relayUrl = getRelayUrl(config.relay_mode)
    return relayUrl !== null || hasPacks()
  }

  const projectName = (session: Session): string => {
    const cwd = session.header.cwd ?? process.cwd()
    const titles = ctx.get('sessionTitle') as SessionTitleLike | undefined
    const snapshot = titles?.get(session)
    return resolveProjectName(cwd, snapshot?.title)
  }

  /**
   * A fresh install has no packs, so every hook would stay silent. Fetch the
   * recommended pack once, in the background; the Settings page's install
   * button stays the manual path (and the way to get the other nine).
   *
   * The one-shot flag is deliberately never reset: an offline machine logs the
   * pointer to Settings once instead of retrying the download every session.
   */
  let bootstrappedPacks = false
  const bootstrapRecommendedPack = (): void => {
    if (bootstrappedPacks) return
    bootstrappedPacks = true

    const settingsHint = `Install a sound pack under Settings › "peon-ping 声音通知".`
    ctx.logger.info(`peon-ping: no sound packs yet — fetching "${RECOMMENDED_PACK}" in the background.`)

    void runInstall([RECOMMENDED_PACK], (message) => ctx.logger.info(`peon-ping: ${message}`))
      .then((report) => {
        if (report.installed === 0) {
          ctx.logger.warn(`peon-ping: could not fetch "${RECOMMENDED_PACK}". ${settingsHint}`)
          return
        }
        // Adopt the new pack without waiting for the next event to reload.
        config = loadConfig()
        state = loadState()
        ctx.logger.info(`peon-ping: "${RECOMMENDED_PACK}" is ready.`)
      })
      .catch(() => ctx.logger.warn(`peon-ping: could not fetch "${RECOMMENDED_PACK}". ${settingsHint}`))
  }

  // pi `session_start` — a new top-level session entered the store.
  ctx.on('session/created', (session: Session) => {
    if (!isTopLevel(session)) return

    config = loadConfig()
    state = loadState()

    const relayUrl = getRelayUrl(config.relay_mode)
    if (relayUrl) {
      void checkRelayHealth(relayUrl).then((healthy) => {
        if (healthy) return
        const remote = detectRemoteSession()
        const instructions = remote
          ? relaySetupInstructions(remote)
          : `Ensure relay is running at ${relayUrl}`
        ctx.logger.warn(`peon-ping: relay unreachable at ${relayUrl}. ${instructions}`)
      })
    }

    if (!relayUrl && !hasPacks()) {
      bootstrapRecommendedPack()
      return
    }

    const now = Date.now()
    sessionStartTimes.set(session, now)
    state.session_start_time = now
    state.prompt_timestamps = []
    saveState(state)

    playCategorySound('session.start', config, state)
  })

  // 0.2 bookkeeping from the firehose: `tool/call` gives a `tool/result` its
  // tool name (the result message carries only the callId), and
  // `assistant/message` keeps the last assistant text for the popup body.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!isTopLevel(session)) return
    if (event.type === 'tool/call') {
      let names = toolCallNames.get(session)
      if (names === undefined) toolCallNames.set(session, (names = new Map()))
      names.set(String(event.data.callId), event.data.name)
    } else if (event.type === 'assistant/message') {
      const text = extractAssistantText(event.data.message)
      if (text !== '') lastAssistantTexts.set(session, text)
    }
  })

  // pi `before_agent_start` — capture the user's prompt for popup echo.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!isTopLevel(session)) return
    if (event.type !== 'user/message') return
    if (event.data.source.kind !== 'user') return
    currentPrompts.set(session, blocksText(event.data.content).slice(0, 200))
  })

  // pi `agent_start` — rapid-prompt spam detection + acknowledge sound.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!isTopLevel(session)) return
    if (event.type !== 'turn/start') return

    config = loadConfig()
    state = loadState()
    if (!shouldPlaySounds()) return

    const now = Date.now()
    const window = config.annoyed_window_seconds * 1000
    state.prompt_timestamps = state.prompt_timestamps.filter((t) => now - t < window)
    state.prompt_timestamps.push(now)
    saveState(state)

    if (state.prompt_timestamps.length >= config.annoyed_threshold) {
      playCategorySound('user.spam', config, state)
    } else {
      playCategorySound('task.acknowledge', config, state)
    }
  })

  // pi `tool_execution_end` with isError — error sound (opt-in) + desktop
  // notification. An individual tool failure does NOT terminate the task, so
  // by default it stays silent (`tool_error_sounds: false`) — both the beep
  // AND the popup follow that switch; only whole-task failures announce
  // themselves (see the turn/end handler). In 0.2 the result is a first-class
  // `role: 'tool'` message (`isError` on the message itself, the user-facing
  // failure reason beside it) — the old `tool-result` content block no longer
  // exists.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!isTopLevel(session)) return
    if (event.type !== 'tool/result') return

    const data = event.data
    if (!data.message.isError) return

    config = loadConfig()
    state = loadState()
    if (!shouldPlaySounds()) return

    if (config.tool_error_sounds) {
      playCategorySound('task.error', config, state)

      if (config.enabled && !state.paused && config.desktop_notifications) {
        const project = projectName(session)
        const toolName = toolNameFor(session, String(data.message.toolCallId))
        const detail = extractToolErrorText(data) || 'failed'
        const { title, body } = buildNotifyContent('error', project, `[${toolName}]: ${detail}`)
        sendNotification(title, body, config, undefined, 'error', currentPrompts.get(session))
      }
    }
  })

  // pi `agent_end` — completion sound + summary popup for a normal finish,
  // error sound + failure popup when the task terminates unexpectedly.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!isTopLevel(session)) return
    if (event.type !== 'turn/end') return

    config = loadConfig()
    state = loadState()
    if (!shouldPlaySounds()) return

    const now = Date.now()
    if (now - state.last_stop_time < 5000) return
    state.last_stop_time = now

    const reason = event.data.reason
    const completed = reason.kind === 'completed'

    if (completed) {
      // Silent window only suppresses task.complete, never failures.
      const silentMs = config.silent_window_seconds * 1000
      const startTime = sessionStartTimes.get(session) ?? state.session_start_time
      if (silentMs > 0 && now - startTime < silentMs) return

      saveState(state)
      playCategorySound('task.complete', config, state)

      if (config.enabled && !state.paused) {
        const project = projectName(session)
        const summary = lastAssistantTexts.get(session) ?? ''
        const { title, body } = buildNotifyContent('done', project, summary || undefined)
        sendNotification(title, body, config, undefined, 'done', currentPrompts.get(session))
      }
    } else {
      // Unexpected termination (error / aborted / blocked / max-tokens /
      // interrupted): beep the error sound and surface it in a popup.
      saveState(state)
      playCategorySound('task.error', config, state)

      if (config.enabled && !state.paused && config.desktop_notifications) {
        const project = projectName(session)
        const { title, body } = buildNotifyContent('error', project, turnEndFailureLabel(reason))
        sendNotification(title, body, config, undefined, 'error', currentPrompts.get(session))
      }
    }
  })

  // pi `session_compact` — resource-limit sound + notification. Like the
  // fork, we fire on the event AFTER compaction completes, not before.
  // Compaction is a routine background event, so it belongs to the
  // `resource.limit` category — OFF by default. Both the beep and the popup
  // follow that category switch.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!isTopLevel(session)) return
    if (event.type !== 'compaction/end') return

    config = loadConfig()
    state = loadState()
    if (!shouldPlaySounds()) return
    if (!config.categories['resource.limit']) return

    playCategorySound('resource.limit', config, state)

    if (config.enabled && !state.paused && config.desktop_notifications) {
      const project = projectName(session)
      const { title, body } = buildNotifyContent('compacted', project)
      sendNotification(title, body, config, undefined, 'compacted')
    }
  })

  // Web settings: the Settings page (client half of this package) talks to
  // the host through a plugin-owned `/peon/api` HTTP prefix (get / set /
  // action), which the host bridges to the pi config / state files and to
  // pack install / preview / refresh. A plugin-owned route is used instead of
  // the `peon-ping` settings namespace because the harness apiproxy exposes
  // only allowlisted settings namespaces to web clients — a third-party
  // namespace is filtered from `settings.describe` and answers
  // `settings-not-exposed` even when registered. The route mounts once the
  // `webServer` service is available (web surfaces only), and is fenced by
  // the same browser-trust check the shell's own routes use.
  {
    const entry = (): PeonSettings => buildSettingsEntry(
      loadConfig(),
      loadState(),
      listPacks().map((p) => p.name),
    )

    /** Persist one full section through to the pi files. */
    const writeSection = (section: PeonSettings): void => {
      const fileConfig = configFromSettings(section, loadConfig())
      saveConfig(fileConfig)
      const fileState = loadState()
      fileState.paused = section.paused
      saveState(fileState)
    }

    /** Execute one client command (pack install / preview / refresh). */
    const runAction = async (action: string): Promise<{ section: PeonSettings; notice: string }> => {
      const section = entry()
      let notice = section._notice
      let packs = section.packs
      const { command, names } = parseAction(action)
      if (command === 'install') {
        installing = true
        try {
          const progress: string[] = []
          const report = await runInstall(names, (msg) => {
            progress.push(msg)
            ctx.logger.info(`peon-ping: ${msg}`)
          })
          packs = listPacks().map((p) => p.name)
          notice = report.cancelled
            ? `Install cancelled (${report.installed}/${report.total} packs).`
            : report.installed > 0
              ? `Installed ${report.installed}/${report.total} packs${report.failed.length > 0 ? `; failed: ${report.failed.join(', ')}` : ''}.`
              : `No packs installed (${report.total} attempted${report.failed.length > 0 ? `; failed: ${report.failed.join(', ')}` : ''}).`
        } finally {
          installing = false
        }
      } else if (command === 'preview') {
        const previewed = previewPackSound(section.default_pack)
        notice = previewed !== null ? `Previewing ${previewed}.` : 'No preview sound available (install packs first).'
      } else if (command === 'refresh') {
        packs = listPacks().map((p) => p.name)
        notice = `${packs.length} pack${packs.length === 1 ? '' : 's'} installed.`
      } else if (command.length > 0) {
        notice = `Unknown action "${command}".`
      }
      return { section: { ...section, packs, _notice: notice, _action: '' }, notice }
    }

    ctx.inject(['webServer', 'webRuntime'], (sctx) => {
      const host = sctx as unknown as { webServer: WebServerLike; webRuntime?: WebRuntimeLike }
      const webServer = host.webServer
      const webRuntime = host.webRuntime
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/peon/api',
        handler: async (req, res) => {
          if (!isTrustedRequest(req, webRuntime?.trustedHosts ?? [])) {
            writeError(res, 403, 'forbidden', 'forbidden')
            return
          }
          if (req.method !== 'POST') {
            writeError(res, 405, 'method-error', 'method not allowed')
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith('/peon/api/') ? pathname.slice('/peon/api/'.length) : undefined
          if (method === undefined || method.includes('/')) {
            writeError(res, 404, 'not-found', `unknown peon API method "${method ?? ''}"`)
            return
          }
          try {
            const payload = (await readJsonBody(req)) as Record<string, unknown>
            if (method === 'get') {
              writeOk(res, entry())
            } else if (method === 'set') {
              const field = typeof payload.field === 'string' ? payload.field : ''
              if (field === '' || !(field in entry())) {
                writeError(res, 400, 'bad-request', `unknown field "${field}"`)
                return
              }
              const section = { ...entry(), [field]: payload.value }
              writeSection(section)
              writeOk(res, entry())
            } else if (method === 'action') {
              const action = typeof payload.action === 'string' ? payload.action : ''
              const { section, notice } = await runAction(action)
              writeSection(section)
              writeOk(res, { ...entry(), _notice: notice })
            } else {
              writeError(res, 404, 'not-found', `unknown peon API method "${method}"`)
            }
          } catch (error) {
            writeError(res, 400, 'bad-request', error instanceof Error ? error.message : String(error))
          }
        },
      }), 'dsh-reminder: /peon/api routes')
    })
  }
}
