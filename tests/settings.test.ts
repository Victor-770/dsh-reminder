import { describe, it, expect } from "vitest";
import {
  buildSettingsEntry,
  configFromSettings,
  hasAction,
  parseAction,
  PEON_SETTINGS_NS_ID,
  type PeonSettings,
} from "../src/settings";
import { DEFAULT_CONFIG } from "../src/constants";
import { DEFAULT_STATE } from "../src/constants";

const base = (): PeonSettings => buildSettingsEntry(
  { ...DEFAULT_CONFIG },
  { ...DEFAULT_STATE },
  ["peon", "glados"],
);

describe("settings section (web UI bridge)", () => {
  it("namespace id is peon-ping", () => {
    expect(PEON_SETTINGS_NS_ID).toBe("peon-ping");
  });

  it("buildSettingsEntry carries config, state, and packs", () => {
    const entry = base();
    // Assert the pass-through, not a specific pack: which pack is recommended
    // is a product default that lives in one place (RECOMMENDED_PACK).
    expect(entry.default_pack).toBe(DEFAULT_CONFIG.default_pack);
    expect(entry.volume).toBe(1);
    expect(entry.paused).toBe(false);
    expect(entry.packs).toEqual(["peon", "glados"]);
    expect(entry._action).toBe("");
    expect(entry.categories["task.complete"]).toBe(true);
    expect(entry.categories["session.start"]).toBe(false);
  });

  it("configFromSettings writes exposed fields and preserves unexposed ones", () => {
    const section = base();
    section.volume = 0.5;
    section.desktop_notifications = false;
    section.tool_error_sounds = true;

    const current = { ...DEFAULT_CONFIG, annoyed_threshold: 7, playback_wait_seconds: 5 };
    const next = configFromSettings(section, current);

    expect(next.volume).toBe(0.5);
    expect(next.desktop_notifications).toBe(false);
    expect(next.tool_error_sounds).toBe(true);
    // Unexposed fields survive the write-through.
    expect(next.annoyed_threshold).toBe(7);
    expect(next.playback_wait_seconds).toBe(5);
  });

  it("hasAction detects only non-empty _action", () => {
    expect(hasAction({ ...base(), _action: "" })).toBe(false);
    expect(hasAction({ ...base(), _action: "refresh" })).toBe(true);
  });

  it("parseAction splits command and names", () => {
    expect(parseAction("refresh")).toEqual({ command: "refresh", names: [] });
    expect(parseAction("install:peon_ru,glados")).toEqual({ command: "install", names: ["peon_ru", "glados"] });
    expect(parseAction("install")).toEqual({ command: "install", names: [] });
  });
});
