import { describe, it, expect, beforeEach, vi } from "vitest";

// The `session/created` handler below now kicks off a background pack download
// when the machine has no packs. Stub the installer so this suite can never
// reach the network (a clean CI box has no packs).
const { runInstallMock } = vi.hoisted(() => ({ runInstallMock: vi.fn() }));
vi.mock("../src/ui", () => ({
  runInstall: runInstallMock,
  previewPackSound: () => null,
}));

describe("config parity with upstream peon-ping", () => {
  describe("PeonConfig type has all upstream fields", () => {
    it("DEFAULT_CONFIG has default_pack instead of active_pack", async () => {
      const { DEFAULT_CONFIG, RECOMMENDED_PACK } = await import("../src/constants");
      expect(DEFAULT_CONFIG.default_pack).toBe(RECOMMENDED_PACK);
      expect((DEFAULT_CONFIG as any).active_pack).toBeUndefined();
    });

    it("DEFAULT_CONFIG has silent_window_seconds defaulting to 0", async () => {
      const { DEFAULT_CONFIG } = await import("../src/constants");
      expect(DEFAULT_CONFIG.silent_window_seconds).toBe(0);
    });
  });

  describe("active_pack → default_pack migration", () => {
    it("migrateConfig moves active_pack to default_pack", async () => {
      const { migrateConfig } = await import("../src/config");
      const raw = { active_pack: "glados", volume: 0.8 };
      const migrated = migrateConfig(raw);
      expect(migrated.default_pack).toBe("glados");
      expect(migrated.active_pack).toBeUndefined();
    });

    it("migrateConfig preserves default_pack if already present", async () => {
      const { migrateConfig } = await import("../src/config");
      const raw = { default_pack: "duke_nukem", active_pack: "glados" };
      const migrated = migrateConfig(raw);
      expect(migrated.default_pack).toBe("duke_nukem");
      expect(migrated.active_pack).toBeUndefined();
    });

    it("migrateConfig is a no-op when neither field exists", async () => {
      const { migrateConfig } = await import("../src/config");
      const raw = { volume: 0.3 };
      const migrated = migrateConfig(raw);
      expect(migrated.default_pack).toBeUndefined();
      expect(migrated.active_pack).toBeUndefined();
    });
  });

  describe("new config fields merge with defaults", () => {
    it("partial config gets new field defaults", async () => {
      const { DEFAULT_CONFIG } = await import("../src/constants");
      const partial = { default_pack: "glados" };
      const merged = {
        ...DEFAULT_CONFIG,
        ...partial,
        categories: { ...DEFAULT_CONFIG.categories, ...(partial as any).categories },
      };

      expect(merged.default_pack).toBe("glados");
      expect(merged.silent_window_seconds).toBe(0);
    });

    it("user overrides for new fields are preserved", async () => {
      const { DEFAULT_CONFIG } = await import("../src/constants");
      const partial = {
        silent_window_seconds: 5,
      };
      const merged = {
        ...DEFAULT_CONFIG,
        ...partial,
        categories: { ...DEFAULT_CONFIG.categories },
      };

      expect(merged.silent_window_seconds).toBe(5);
    });
  });

  describe("plugin registration (dsh port)", () => {
    let listeners: Record<string, Function[]>;
    let stubCtx: any;

    beforeEach(() => {
      listeners = {};
      stubCtx = {
        on: (name: string, handler: Function) => {
          (listeners[name] ??= []).push(handler);
          return () => {};
        },
        get: () => undefined,
        inject: () => {},
        logger: { warn: () => {}, info: () => {}, error: () => {} },
      };
    });

    it("apply registers session/created and session/event listeners", async () => {
      const { apply } = await import("../index");
      apply(stubCtx);

      expect(listeners["session/created"]).toBeDefined();
      expect(listeners["session/event"]).toBeDefined();
      // turn/start, tool/result, turn/end, compaction/end + user/message prompt capture
      expect(listeners["session/event"]!.length).toBe(6);
    });

    it("session/created handler completes without throwing", async () => {
      const { apply } = await import("../index");
      apply(stubCtx);

      const handler = listeners["session/created"]![0]!;
      await handler({
        id: "s-1",
        header: { id: "s-1", version: 0, createdAt: Date.now(), cwd: process.cwd() },
        events: [],
        get surface() { return {}; },
      });
    });
  });
});
