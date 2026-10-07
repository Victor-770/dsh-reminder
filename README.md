# dsh-reminder

> peon-ping sound notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) — a **faithful port** of the pi plugin [`pi-peon-ping-win`](https://github.com/Gohan/pi-peon-ping-win).

Plays themed audio clips (Warcraft III Peon, GLaDOS, Duke Nukem, StarCraft, …) on lifecycle events using [OpenPeon](https://github.com/PeonPing/og-packs) sound packs, and shows desktop notifications — with native Windows support (three-tier audio fallback `ffplay` → `mpv` → `winmm.dll PlaySound`, and a native Windows toast notification).

## Acknowledgments

This project is a **port**, not an original work. All credit for the underlying functionality goes to:

- **[pi-peon-ping](https://github.com/joshuadavidthomas/pi-peon-ping)** by [Josh Thomas](https://github.com/joshuadavidthomas) — the original peon-ping extension for the pi coding agent.
- **[pi-peon-ping-win](https://github.com/Gohan/pi-peon-ping-win)** by [cppgohan](https://github.com/Gohan) — the fork that added native Windows support (audio fallback, WinForms popup, event-aware notifications).
- **[peon-ping](https://github.com/PeonPing/peon-ping)** and the [OpenPeon](https://github.com/PeonPing/og-packs) sound packs / registry.

Thank you to all of them for the original work and the MIT license that makes this port possible.

## Features

| Event | Sound category | Desktop notification | Default sound |
|-------|---------------|----------------------|---------------|
| Session start | `session.start` — "Ready to work?" | — | off |
| Agent starts working | `task.acknowledge` — "Work, work." | — | off |
| Individual tool failure | `task.error` — error sound | `error` — body names the failing tool | off (beep **and** popup follow the `tool_error_sounds` switch) || Rapid prompts (≥3 in 10s) | `user.spam` — annoyed voice line | — | off |
| **Task completes** | `task.complete` — completion sound | `done` — body shows the assistant's last response (truncated) | **on** |
| **Task terminates unexpectedly** (error / cancelled / blocked / token limit) | `task.error` — error sound | `error` — body names the failure | **on** |
| Context compaction | `resource.limit` — limit sound | `compacted` — body: "Context compacted" | off |

**dsh port default: the harness stays quiet — only a task **completing** or **terminating unexpectedly** beeps.** Everything else (session start, per-prompt ack, spam, individual tool errors, compaction) is off by default and can be re-enabled with `/peon toggle <category>` (tool errors with `/peon tool-error on`).

This is the same feature table as the pi plugin; only the host and the default on/off set changed. The event mapping:

| pi event | dsh event |
|----------|-----------|
| `session_start` | `session/created` (top-level sessions) |
| `before_agent_start` | `user/message` (kind `user`) |
| `agent_start` | `turn/start` |
| `tool_execution_end` (error) | `tool/result` with `isError` |
| `agent_end` | `turn/end` |
| `session_compact` | `compaction/end` (fires **after** compaction completes) |

## Requirements

- DeepSeek Harness (any profile — the plugin is installed as a profile bundle)
- An audio player on your system (see Platform support below). On Windows, `winget install Gyan.FFmpeg` for the best experience.

## Installation (npm)

Install as a profile plugin:

```bash
dsh plugin --profile web add dsh-reminder
```

Restart the harness (or reload the profile) so the new bundle layer mounts. The bundle patch (`cordis.patch.yml`) inserts the `peon-ping` plugin row automatically — no manual `cordis.patch.yml` editing.

On the first session where no sound packs are installed, the plugin fetches the recommended pack (`sc_kerrigan`, ~0.4 MB) in the background — so it beeps without any setup. Only one attempt is made per run; if it fails, the log points at Settings → **peon-ping sound notifications** for the manual install (which also gets the other nine default packs).

To install from a local checkout:

```bash
dsh plugin --profile web add D:/1codeprojects/dsh-plugins/dsh-reminder
```

To uninstall:

```bash
dsh plugin --profile web remove dsh-reminder
```

## Usage

All settings live in the **web Settings page**: open Settings (the gear icon in the sidebar), scroll past **Agent Presets** to the **peon-ping sounds** section. There you can:

- see the current state (pack, volume, toggles, relay mode) and the host notice line,
- **Install default packs** (downloads the 10 default packs from the [peon-ping registry](https://peonping.github.io/registry/)),
- pick the active sound pack from the installed ones,
- set the volume,
- toggle desktop notifications, the tool-error beep, and every sound category,
- pause/resume sounds, set the silent window and relay mode,
- **Preview** the current pack's session-start sound.

Changes are written through to `~/.config/peon-ping/config.json` immediately, so they apply to the next event without a restart. There is no `/peon` slash command — the pi TUI panel became this web page.

> **Settings-page transport**: the page talks to the host through the plugin's own `/peon/api` HTTP route (same origin, behind the browser-trust fence), **not** through the host's settings-namespace allowlist (`dsh-host-apiproxy`'s `WEB_SETTINGS_NAMESPACES` admits only built-in namespaces; a third-party namespace is filtered from `settings.describe` even when registered). So the settings page works on dsh versions that never added `peon-ping` to that allowlist.

To install specific packs from the registry directly, edit `~/.config/peon-ping/config.json` or use the registry's pack names with the page's install action (the page installs the defaults; pack names come from the [peon-ping registry](https://peonping.github.io/registry/index.json)).

## Platform support

| Platform | Player | Notifications |
|----------|--------|---------------|
| macOS | `afplay` (built-in) | `osascript` |
| Linux | `pw-play`, `paplay`, `ffplay`, `mpv`, `play`, or `aplay` (first found) | `notify-send` (desktop session required) |
| WSL | PowerShell `MediaPlayer` — the WSL path is converted to the Windows view (`wslpath -w` → `\\wsl.localhost\<distro>\...` or `D:\...`) so the spawned Windows PowerShell can actually open the file | Windows Toast (text-only; no icon — WinRT silently drops icons from WSL paths) |
| **Windows (native)** ⭐ | `ffplay` (recommended, `winget install Gyan.FFmpeg`) → `mpv` → `winmm.dll PlaySound` fallback (no volume control) | Native Windows toast (bottom-right + Action Center; silenced, so only the pack clip is heard) |

WSL audio works out of the box on any distro: the `\\wsl.localhost\<distro>\...` prefix, the user name, and the `/mnt/<drive>` mounts are resolved dynamically by `wslpath -w` per machine — nothing is hardcoded.

## Config and data

Config, state, and packs live in the **same** files the pi plugin uses, so a machine that already ran pi-peon-ping keeps its packs and settings:

- `~/.config/peon-ping/config.json`
- `~/.config/peon-ping/state.json`
- `~/.config/peon-ping/packs/`

| Option | Default | Description |
|--------|---------|-------------|
| `default_pack` | `"sc_kerrigan"` | Active sound pack (the port's recommended pack; it is listed first when installing the defaults) |
| `volume` | `1.0` | Sound volume (0.0–1.0) |
| `enabled` | `true` | Master on/off switch |
| `desktop_notifications` | `true` | Show system notifications on task complete |
| `categories` | `task.complete` + `task.error` on, rest off | Per-event toggles for sound **and** popup (see the feature table) |
| `tool_error_sounds` | `false` | Individual tool failures: beep + popup when enabled; fully silent when off |
| `silent_window_seconds` | `0` | Suppress `task.complete` for tasks shorter than N seconds |
| `annoyed_threshold` | `3` | Number of rapid prompts to trigger spam detection |
| `annoyed_window_seconds` | `10` | Time window for spam detection |
| `relay_mode` | `"auto"` | Relay mode: `"auto"`, `"local"`, or `"relay"` |
| `playback_wait_seconds` | `2` | Seconds the PowerShell player process stays alive after `Play()` |

Legacy config with `active_pack` is migrated to `default_pack` on load. Packs are also picked up from `~/.claude/hooks/peon-ping/packs` (Claude Code).

## Remote development

The extension auto-detects SSH sessions, devcontainers, and Codespaces, and routes audio through the peon-ping relay running on your local machine (see the [peon-ping remote development docs](https://github.com/PeonPing/peon-ping#remote-development-ssh--devcontainers--codespaces)). Configure with `/peon relay`.

## Development

The repository is self-contained: all type declarations come from the npm
devDependencies (no vendored or machine-specific paths in `tsconfig.json`).

```bash
npm install
npm test              # run tests
npm run typecheck     # type check
npm run build         # build lib/ (host bundle)
npm run build:client  # build lib/client.js (browser bundle)
npm run publish:dry-run  # verify the npm package contents
```

## License

MIT. All credit for the original work goes to [joshuadavidthomas](https://github.com/joshuadavidthomas) (pi-peon-ping) and [cppgohan](https://github.com/Gohan) (pi-peon-ping-win, native Windows support).
