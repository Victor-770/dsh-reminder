import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_STATE, RECOMMENDED_PACK } from "../src/constants";

// Fully hermetic: no real ~/.config writes, no packs on disk, no relay, and no
// network — the installer itself is a mock, so these tests assert the *policy*
// (when we fetch, what we fetch, and what we say when it fails).
const { runInstallMock, loggerMock } = vi.hoisted(() => ({
  runInstallMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/ui", () => ({
  runInstall: runInstallMock,
  previewPackSound: () => null,
}));

vi.mock("../src/packs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/packs")>();
  return { ...actual, listPacks: () => [] };
});

vi.mock("../src/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/relay")>();
  return { ...actual, getRelayUrl: () => null, detectRemoteSession: () => null };
});

vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return {
    ...actual,
    ensureDirs: () => {},
    loadConfig: () => ({ ...DEFAULT_CONFIG, categories: { ...DEFAULT_CONFIG.categories } }),
    loadState: () => ({ ...DEFAULT_STATE }),
    saveConfig: () => {},
    saveState: () => {},
  };
});

function makeSession() {
  return {
    id: "s-boot",
    header: { id: "s-boot", version: 0, createdAt: Date.now(), cwd: process.cwd() },
    events: [],
    get surface() { return {}; },
  };
}

function stubCtx() {
  const listeners: Record<string, Function[]> = {};
  return {
    listeners,
    ctx: {
      on: (name: string, handler: Function) => { (listeners[name] ??= []).push(handler); return () => {}; },
      get: () => undefined,
      inject: () => {},
      logger: loggerMock,
    } as any,
  };
}

/** Let the fire-and-forget install promise settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const warnText = () => loggerMock.warn.mock.calls.map((c) => String(c[0])).join(" | ");

describe("first-run pack bootstrap", () => {
  beforeEach(() => {
    runInstallMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
  });

  it("fetches the recommended pack when no packs are installed", async () => {
    runInstallMock.mockResolvedValue({ installed: 1, total: 1, failed: [], cancelled: false });
    const { ctx, listeners } = stubCtx();
    const { apply } = await import("../index");
    apply(ctx);

    listeners["session/created"]![0]!(makeSession());
    await flush();

    expect(runInstallMock).toHaveBeenCalledTimes(1);
    expect(runInstallMock.mock.calls[0]![0]).toEqual([RECOMMENDED_PACK]);
  });

  it("only tries once per process, however many sessions start", async () => {
    runInstallMock.mockResolvedValue({ installed: 1, total: 1, failed: [], cancelled: false });
    const { ctx, listeners } = stubCtx();
    const { apply } = await import("../index");
    apply(ctx);

    const handler = listeners["session/created"]![0]!;
    handler(makeSession());
    handler(makeSession());
    handler(makeSession());
    await flush();

    expect(runInstallMock).toHaveBeenCalledTimes(1);
  });

  it("points at the Settings page when the download fails", async () => {
    runInstallMock.mockResolvedValue({ installed: 0, total: 1, failed: [RECOMMENDED_PACK], cancelled: false });
    const { ctx, listeners } = stubCtx();
    const { apply } = await import("../index");
    apply(ctx);

    listeners["session/created"]![0]!(makeSession());
    await flush();

    expect(warnText()).toContain(RECOMMENDED_PACK);
    expect(warnText()).toContain("Settings");
    // The old port warned about a /peon command that never existed here.
    expect(warnText()).not.toContain("/peon install");
  });

  it("points at the Settings page when the download throws", async () => {
    runInstallMock.mockRejectedValue(new Error("offline"));
    const { ctx, listeners } = stubCtx();
    const { apply } = await import("../index");
    apply(ctx);

    listeners["session/created"]![0]!(makeSession());
    await flush();

    expect(warnText()).toContain("Settings");
  });
});
