import { join } from "node:path";
import { homedir } from "node:os";
import type { PeonConfig, PeonState } from "./types.ts";

export const DATA_DIR = join(homedir(), ".config", "peon-ping");
export const PACKS_DIR = join(DATA_DIR, "packs");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const STATE_PATH = join(DATA_DIR, "state.json");

export const LEGACY_PACKS = join(homedir(), ".claude", "hooks", "peon-ping", "packs");

/**
 * Fork default: the pack this port recommends, and therefore the one a fresh
 * config activates. It also heads DEFAULT_PACK_NAMES below, so it is the first
 * pack downloaded and the one `runInstall` falls back to when the configured
 * pack turns out not to be installed.
 */
export const RECOMMENDED_PACK = "sc_kerrigan";

export const DEFAULT_CONFIG: PeonConfig = {
  default_pack: RECOMMENDED_PACK,
  // Fork default: 1.0 (upstream uses 0.5). peon-ping is an alert sound — at
  // 0.5 it's easy to miss on Windows where ffplay's volume scaling is lower
  // than upstream WPF MediaPlayer. Users who want it quieter can edit
  // config.json or use the /peon settings panel.
  volume: 1.0,
  enabled: true,
  desktop_notifications: true,
  categories: {
    // dsh port default: keep the harness quiet — only beep when a task
    // COMPLETES or TERMINATES UNEXPECTEDLY. Everything else (session start,
    // per-prompt ack, rapid-prompt spam, individual tool errors, compaction)
    // is off by default; re-enable any of them with `/peon toggle <category>`.
    "session.start": false,
    "task.acknowledge": false,
    "task.complete": true,
    "task.error": true,
    "input.required": false,
    "resource.limit": false,
    "user.spam": false,
  },
  // dsh port: individual tool-call failures are silent by default; only the
  // whole-task failure path (turn/end with an error/aborted reason) beeps.
  tool_error_sounds: false,
  annoyed_threshold: 3,
  annoyed_window_seconds: 10,
  silent_window_seconds: 0,
  relay_mode: "auto",
  // Fork default: 8s ceiling (upstream hardcodes 3s in audio.ts). The WSL
  // player now waits for the clip to end naturally and only uses this as an
  // upper bound, so a generous ceiling costs nothing — the powershell
  // process exits as soon as the clip finishes, and long clips aren't cut.
  playback_wait_seconds: 8,
};

export const DEFAULT_STATE: PeonState = {
  paused: false,
  last_played: {},
  prompt_timestamps: [],
  last_stop_time: 0,
  session_start_time: 0,
};

export const CATEGORY_LABELS: Record<string, string> = {
  "session.start": "Session start",
  "task.acknowledge": "Task acknowledge",
  "task.complete": "Task complete",
  "task.error": "Task error",
  "input.required": "Input required",
  "resource.limit": "Resource limit",
  "user.spam": "Rapid prompt spam",
};

export const VOLUME_STEPS = ["10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%", "100%"];

export const REGISTRY_URL = "https://peonping.github.io/registry/index.json";
export const DEFAULT_PACK_NAMES = [
  RECOMMENDED_PACK, "peon", "peasant", "glados", "sc_battlecruiser",
  "ra2_kirov", "dota2_axe", "duke_nukem", "tf2_engineer", "hd2_helldiver",
];
export const FALLBACK_REPO = "PeonPing/og-packs";
export const FALLBACK_REF = "v1.1.0";
