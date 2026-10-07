import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  CATEGORY_LABELS,
  VOLUME_STEPS,
  DEFAULT_PACK_NAMES,
  RECOMMENDED_PACK,
  DATA_DIR,
  PACKS_DIR,
} from "../src/constants";

describe("constants", () => {
  it("DEFAULT_CONFIG has all required fields", () => {
    expect(DEFAULT_CONFIG.default_pack).toBe(RECOMMENDED_PACK);
    expect(RECOMMENDED_PACK).toBe("sc_kerrigan");
    expect(DEFAULT_CONFIG.volume).toBe(1);
    expect(DEFAULT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CONFIG.annoyed_threshold).toBe(3);
    expect(DEFAULT_CONFIG.annoyed_window_seconds).toBe(10);
    expect(DEFAULT_CONFIG.relay_mode).toBe("auto");
  });

  it("DEFAULT_CONFIG categories match CATEGORY_LABELS keys", () => {
    const configKeys = Object.keys(DEFAULT_CONFIG.categories).sort();
    const labelKeys = Object.keys(CATEGORY_LABELS).sort();
    expect(configKeys).toEqual(labelKeys);
  });

  it("DEFAULT_CONFIG beeps only on task complete and unexpected termination", () => {
    // dsh port default: keep the harness quiet — only whole-task completion
    // and failure beep; everything else is off by default.
    expect(DEFAULT_CONFIG.categories["task.complete"]).toBe(true);
    expect(DEFAULT_CONFIG.categories["task.error"]).toBe(true);
    expect(DEFAULT_CONFIG.categories["session.start"]).toBe(false);
    expect(DEFAULT_CONFIG.categories["task.acknowledge"]).toBe(false);
    expect(DEFAULT_CONFIG.categories["user.spam"]).toBe(false);
    expect(DEFAULT_CONFIG.categories["resource.limit"]).toBe(false);
    expect(DEFAULT_CONFIG.categories["input.required"]).toBe(false);
    // Individual tool failures stay silent by default.
    expect(DEFAULT_CONFIG.tool_error_sounds).toBe(false);
  });

  it("DEFAULT_STATE has sensible defaults", () => {
    expect(DEFAULT_STATE.paused).toBe(false);
    expect(DEFAULT_STATE.last_played).toEqual({});
    expect(DEFAULT_STATE.prompt_timestamps).toEqual([]);
    expect(DEFAULT_STATE.last_stop_time).toBe(0);
    expect(DEFAULT_STATE.session_start_time).toBe(0);
  });

  it("VOLUME_STEPS are ordered 10% to 100%", () => {
    expect(VOLUME_STEPS).toHaveLength(10);
    expect(VOLUME_STEPS[0]).toBe("10%");
    expect(VOLUME_STEPS[9]).toBe("100%");
  });

  it("DEFAULT_PACK_NAMES includes expected packs", () => {
    // The recommended pack downloads first, and is runInstall's fallback.
    expect(DEFAULT_PACK_NAMES[0]).toBe(RECOMMENDED_PACK);
    expect(DEFAULT_PACK_NAMES).toContain("peon");
    expect(DEFAULT_PACK_NAMES).toContain("glados");
    expect(DEFAULT_PACK_NAMES).toContain("duke_nukem");
    expect(DEFAULT_PACK_NAMES.length).toBeGreaterThanOrEqual(10);
  });

  it("paths end with peon-ping directories", () => {
    expect(DATA_DIR).toMatch(/peon-ping$/);
    // Fork: accept both forward and back slashes (Windows uses \).
    expect(PACKS_DIR).toMatch(/peon-ping[\\/]packs$/);
  });
});
