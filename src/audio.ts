import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectLinuxPlayer, detectPlatform, detectPwshBin, detectWindowsPlayer, NO_CONSOLE_WINDOW, wslToWindowsPath, type Platform } from "./platform.ts";
import { saveState } from "./config.ts";
import { resolveIcon, sendDesktopNotification, type NotifyOptions } from "./notification.ts";
import type { NotifyStatus } from "./notify-content.ts";
import { getPacksDir, pickSound } from "./packs.ts";
import { getRelayUrl, relayPlayCategory, relayNotify } from "./relay.ts";
import type { PeonConfig, PeonState } from "./types.ts";

const PLATFORM: Platform = detectPlatform();

let currentSoundPid: number | null = null;

export function killPreviousSound(): void {
  if (currentSoundPid !== null) {
    try {
      process.kill(currentSoundPid);
    } catch {}
    currentSoundPid = null;
  }
}

function pct(volume: number): number {
  return Math.max(0, Math.min(100, Math.round(volume * 100)));
}

// --- WSL audio: WSLg native fast path + PowerShell fallback ---------------
//
// WSLg (Windows 11 WSL2) runs a PulseAudio server that routes audio to the
// Windows speakers over RDP. With a pulse client (`paplay`, from
// pulseaudio-utils) the plugin can play natively: a Linux process, ~0.1s
// spawn-to-audio, no Windows interop, no path conversion.
//
// WSLg quirk: the RDP sink auto-suspends after ~5s of idle, and a play into
// a suspended sink either silently drops the clip (paplay exits 0 in ~30ms)
// or stalls ~2s while the sink resumes. The PowerShell path (below) is
// deterministic at ~0.8s to audio, so it is the workhorse:
//   - native paplay is used only while the sink is provably warm — a
//     native play finished <4s ago, so the 5s suspend timeout cannot have
//     fired yet;
//   - every other play goes straight to PowerShell;
//   - if a warm-sink native play still fast-exits (sink suspended anyway),
//     it falls back to PowerShell after a short delay.
// A keep-alive silence stream was tried and rejected: it kept the sink
// RUNNING (instant plays) but wedged the whole WSLg PulseAudio server after
// ~2 minutes (pactl/paplay timeouts), breaking WSL audio entirely.
//
// Machines without paplay or without /mnt/wslg just use the PowerShell path.

const WSL_PULSE_SERVER = "unix:/mnt/wslg/PulseServer";

let wslNativeChecked: boolean | null = null;

function wslNativeAvailable(): boolean {
  if (wslNativeChecked !== null) return wslNativeChecked;
  wslNativeChecked = false;
  try {
    if (!existsSync("/mnt/wslg/PulseServer")) return false;
    execSync("command -v paplay", { stdio: "pipe", ...NO_CONSOLE_WINDOW });
    wslNativeChecked = true;
  } catch {}
  return wslNativeChecked;
}

/** When the last native (paplay) play exited; 0 = never. */
let lastWslNativeEnd = 0;

/**
 * WSL fallback: Windows PowerShell MediaPlayer. A spawned Windows process
 * cannot open a raw WSL path (`/home/...` / `/mnt/...`) — MediaPlayer fails
 * silently. Convert to the Windows view first (`wslpath -w`):
 * `\\wsl.localhost\<distro>\home\...` for WSL files, `D:\...` for /mnt/d.
 * Nothing is hardcoded — the distro, user, and drive mounts resolve per
 * machine.
 *
 * Latency/reliability fixes over upstream:
 *   1. Use Windows PowerShell 5.1 (`powershell.exe`, ~0.5s spawn) rather
 *      than PowerShell 7 (`pwsh`, ~1s) — see detectPwshBin.
 *   2. Copy the clip to `$env:TEMP` first and play the local copy. Opening
 *      MediaPlayer straight off `\\wsl.localhost` adds 0.6-3s of 9p open
 *      latency before any audio; a local NTFS file opens in ~0.1s (the copy
 *      itself is a 10-50KB file, ~0.1-0.2s).
 *   3. Wait for Open() to finish before Play(). Calling Play() while Open()
 *      is still in flight intermittently throws (media not open) and
 *      silently drops the whole sound.
 *   4. Poll Position against NaturalDuration and Close() only after the
 *      clip ends (waitSeconds is a ceiling). The upstream fixed
 *      `Start-Sleep` clipped the tail of clips whose open latency +
 *      duration exceeded the sleep.
 */
function playWslPowerShell(file: string, volume: number, waitSeconds: number): ChildProcess | null {
  const psBin = detectPwshBin() ?? "powershell.exe";
  const winPath = wslToWindowsPath(file);
  const cmd = `
Add-Type -AssemblyName PresentationCore
$src = '${winPath.replace(/'/g, "''")}'
$dst = Join-Path $env:TEMP ('peon-' + [guid]::NewGuid().ToString('N') + [System.IO.Path]::GetExtension('${winPath.replace(/'/g, "''")}'))
Copy-Item -LiteralPath $src -Destination $dst -Force
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]::new('file:///' + ($dst -replace '\\\\', '/')))
$p.Volume = ${volume}
$openDeadline = [DateTime]::Now.AddSeconds(5)
while (-not $p.NaturalDuration.HasTimeSpan -and [DateTime]::Now -lt $openDeadline) {
    Start-Sleep -Milliseconds 100
}
$p.Play()
$stopAt = [DateTime]::Now.AddSeconds(${waitSeconds})
while ([DateTime]::Now -lt $stopAt) {
    Start-Sleep -Milliseconds 100
    if ($p.NaturalDuration.HasTimeSpan) {
        $dur = $p.NaturalDuration.TimeSpan.TotalMilliseconds
        if ($dur -gt 0 -and $p.Position.TotalMilliseconds -ge ($dur - 80)) { break }
    }
}
$p.Close()
Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
`;
  return spawn(psBin, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    stdio: "ignore",
    detached: true,
    ...NO_CONSOLE_WINDOW,
  });
}

/**
 * Play one clip on WSL: native WSLg paplay when the sink is provably warm,
 * otherwise the deterministic PowerShell path. Returns the first attempt's
 * child process (the caller tracks/kills it); a warm-path fast-exit falls
 * back to PowerShell internally.
 */
function playWslSound(file: string, volume: number, waitSeconds: number): ChildProcess | null {
  const nativeWarm = lastWslNativeEnd !== 0 && Date.now() - lastWslNativeEnd < 4000;
  if (nativeWarm && wslNativeAvailable()) {
    const paVol = Math.max(0, Math.min(65536, Math.round(volume * 65536)));
    const env = { ...process.env, PULSE_SERVER: WSL_PULSE_SERVER };
    const started = Date.now();
    const child = spawn("paplay", [`--volume=${paVol}`, file], {
      stdio: "ignore",
      detached: true,
      ...NO_CONSOLE_WINDOW,
      env,
    });
    child.on("exit", () => {
      lastWslNativeEnd = Date.now();
      // A successful play lasts ≥ the shortest clip (~0.9s); exiting in
      // <300ms means the suspended-sink silent no-op — take the PowerShell
      // path instead of waiting out the ~2s resume.
      if (Date.now() - started < 300) {
        setTimeout(() => {
          const fallback = playWslPowerShell(file, volume, waitSeconds);
          if (fallback) {
            fallback.unref();
            currentSoundPid = fallback.pid ?? null;
            fallback.on("exit", () => {
              if (currentSoundPid === fallback.pid) currentSoundPid = null;
            });
          }
        }, 200);
      }
    });
    return child;
  }
  return playWslPowerShell(file, volume, waitSeconds);
}

export function playSound(file: string, volume: number, waitSeconds = 2): void {
  killPreviousSound();

  let child;

  switch (PLATFORM) {
    case "mac":
      child = spawn("afplay", ["-v", String(volume), file], {
        stdio: "ignore",
        detached: true,
        ...NO_CONSOLE_WINDOW,
      });
      break;

    case "win": {
      // Fork note: native Windows. Try ffplay / mpv first (volume-capable,
      // also used by the linux branch for symmetry), then fall back to
      // winmm.dll PlaySound via PowerShell P/Invoke (no external deps but
      // no volume control either).
      //
      // Why not WPF MediaPlayer like upstream WSL? Because MediaPlayer
      // silently fails to render audio in a `-NonInteractive -Command`
      // background process — there's no WPF Dispatcher message pump.
      const winPlayer = detectWindowsPlayer();

      // detached:false on Windows, for the same reason the winmm fallback
      // below uses it: Node documents that a detached Windows child "will have
      // its own console window", which is exactly the terminal that flashed on
      // every sound. ffplay resolves to the Chocolatey shim — a
      // CONSOLE-subsystem executable — so it inherited (and showed) that
      // console. windowsHide alone is not enough here: CREATE_NO_WINDOW is
      // ignored when a new console is requested. unref() below still lets the
      // harness exit while the clip finishes.
      if (winPlayer === "ffplay") {
        child = spawn("ffplay", ["-nodisp", "-autoexit", "-volume", String(pct(volume)), file], {
          stdio: "ignore", detached: false, ...NO_CONSOLE_WINDOW,
        });
        break;
      }

      if (winPlayer === "mpv") {
        child = spawn("mpv", ["--no-video", `--volume=${pct(volume)}`, file], {
          stdio: "ignore", detached: false, ...NO_CONSOLE_WINDOW,
        });
        break;
      }

      // Fallback: winmm.dll PlaySound. Synchronous (SND_SYNC), blocks until
      // the wav finishes. `volume` and `waitSeconds` are ignored here —
      // install ffplay (`winget install Gyan.FFmpeg`) or mpv for volume.
      // detached:false on Windows keeps the PowerShell child in the
      // interactive desktop session (same rule as the WinForms notifier);
      // detached:true would break the desktop association.
      const psBin = detectPwshBin() ?? "powershell.exe";
      const winPath = file.replace(/\//g, "\\");
      const cmd = `
        Add-Type -TypeDefinition @'
        using System.Runtime.InteropServices;
        public class WinMm {
          [DllImport("winmm.dll", SetLastError=true, CharSet=CharSet.Auto)]
          public static extern bool PlaySound(string lpszName, System.IntPtr hModule, uint fdwSound);
        }
'@
        # SND_FILENAME = 0x00020000, SND_SYNC = 0x0000 (default)
        [WinMm]::PlaySound('${winPath.replace(/\\/g, "\\\\")}', [IntPtr]::Zero, 0x00020000) | Out-Null
      `;
      child = spawn(psBin, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
        stdio: "ignore",
        detached: false,
        ...NO_CONSOLE_WINDOW,
      });
      break;
    }

    case "wsl": {
      // WSLg native audio (fast path): `paplay` is a native Linux process —
      // WSLg native audio when the sink is provably warm (a native play
      // finished <4s ago), otherwise the deterministic PowerShell path —
      // see playWslSound.
      child = playWslSound(file, volume, waitSeconds);
      break;
    }

    case "linux": {
      const player = detectLinuxPlayer();
      if (!player) return;

      switch (player) {
        case "pw-play":
          child = spawn("pw-play", ["--volume", String(volume), file], {
            stdio: "ignore", detached: true, ...NO_CONSOLE_WINDOW,
          });
          break;
        case "paplay": {
          const paVol = Math.max(0, Math.min(65536, Math.round(volume * 65536)));
          child = spawn("paplay", [`--volume=${paVol}`, file], {
            stdio: "ignore", detached: true, ...NO_CONSOLE_WINDOW,
          });
          break;
        }
        case "ffplay": {
          child = spawn("ffplay", ["-nodisp", "-autoexit", "-volume", String(pct(volume)), file], {
            stdio: "ignore", detached: true, ...NO_CONSOLE_WINDOW,
          });
          break;
        }
        case "mpv": {
          child = spawn("mpv", ["--no-video", `--volume=${pct(volume)}`, file], {
            stdio: "ignore", detached: true, ...NO_CONSOLE_WINDOW,
          });
          break;
        }
        case "play":
          child = spawn("play", ["-v", String(volume), file], {
            stdio: "ignore", detached: true, ...NO_CONSOLE_WINDOW,
          });
          break;
        case "aplay":
          child = spawn("aplay", ["-q", file], {
            stdio: "ignore", detached: true, ...NO_CONSOLE_WINDOW,
          });
          break;
      }
      break;
    }
  }

  if (child) {
    child.unref();
    currentSoundPid = child.pid ?? null;
    child.on("exit", () => {
      if (currentSoundPid === child.pid) currentSoundPid = null;
    });
  }
}

export type UiNotify = (message: string, type?: "info" | "warning" | "error") => void;

export function sendNotification(
  title: string,
  body: string,
  config: PeonConfig,
  uiNotify?: UiNotify,
  status?: NotifyStatus,
  promptLine?: string,
): void {
  if (!config.desktop_notifications) return;

  const relayUrl = getRelayUrl(config.relay_mode);
  if (relayUrl) {
    relayNotify(relayUrl, title, body).catch(() => {});
    return;
  }

  const packPath = join(getPacksDir(), config.default_pack);
  const iconPath = resolveIcon(packPath);
  const options: NotifyOptions = {
    iconPath,
    ...(status !== undefined ? { status } : {}),
    ...(promptLine !== undefined ? { promptLine } : {}),
  };
  const sent = sendDesktopNotification(title, body, options);
  if (!sent && uiNotify) {
    uiNotify(`${title}: ${body}`, "info");
  }
}

export function playCategorySound(category: string, config: PeonConfig, state: PeonState): void {
  if (!config.enabled || state.paused) return;
  if (!config.categories[category]) return;

  const relayUrl = getRelayUrl(config.relay_mode);
  if (relayUrl) {
    relayPlayCategory(relayUrl, category).catch(() => {});
    return;
  }

  const sound = pickSound(category, config, state);
  if (sound) {
    playSound(sound.file, config.volume, config.playback_wait_seconds);
    saveState(state);
  }
}
