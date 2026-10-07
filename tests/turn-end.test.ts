import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_STATE } from "../src/constants";

// Mock the audio + config modules so this suite never spawns processes and
// never touches the real ~/.config/peon-ping files. This file is the only one
// mocking ../src/config; the plugin-level tests here exercise the default
// sound routing ("beep only on task complete and unexpected termination").
// vi.hoisted: the vi.mock factories below run before this module's own
// bindings exist, so the shared fns must be created at hoist time.
const { mockPlay, mockNotify, mockSaveState } = vi.hoisted(() => ({
  mockPlay: vi.fn(),
  mockNotify: vi.fn(),
  mockSaveState: vi.fn(),
}));

vi.mock("../src/audio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/audio")>();
  return { ...actual, playCategorySound: mockPlay, sendNotification: mockNotify };
});

vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return {
    ...actual,
    ensureDirs: () => {},
    // relay_mode 'relay' makes shouldPlaySounds() true without real packs.
    // Individual tests override the return value to flip toggles.
    loadConfig: vi.fn(() => ({ ...DEFAULT_CONFIG, relay_mode: "relay" })),
    loadState: () => ({ ...DEFAULT_STATE }),
    saveConfig: () => {},
    saveState: mockSaveState,
  };
});

import { loadConfig } from "../src/config";

function makeSession(events: unknown[] = []) {
  return {
    id: "s-turn",
    header: { id: "s-turn", version: 0, createdAt: Date.now(), cwd: process.cwd(), delegationDepth: undefined as number | undefined },
    events,
    get surface() { return {}; },
  };
}

describe("default sound routing (dsh port)", () => {
  let listeners: Record<string, Function[]>;
  let stubCtx: any;

  beforeEach(async () => {
    mockPlay.mockClear();
    mockNotify.mockClear();
    mockSaveState.mockClear();
    vi.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG, relay_mode: "relay" });
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
    const { apply } = await import("../index");
    apply(stubCtx);
  });

  it("turn/end completed plays task.complete and notifies done", async () => {
    const session = makeSession();
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "turn/end",
        seq: 1,
        time: 1,
        data: { turn: 1, reason: { kind: "completed" } },
      } as any);
    }
    expect(mockPlay).toHaveBeenCalledWith("task.complete", expect.anything(), expect.anything());
    const notifyCall = mockNotify.mock.calls.find((c) => c[4] === "done");
    expect(notifyCall).toBeDefined();
  });

  it("turn/end error plays task.error and notifies error", async () => {
    const session = makeSession();
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "turn/end",
        seq: 1,
        time: 1,
        data: { turn: 1, reason: { kind: "error", error: { message: "boom", code: "UNKNOWN" } } },
      } as any);
    }
    expect(mockPlay).toHaveBeenCalledWith("task.error", expect.anything(), expect.anything());
    const notifyCall = mockNotify.mock.calls.find((c) => c[4] === "error");
    expect(notifyCall).toBeDefined();
    // sendNotification(title, body, config, uiNotify, status, promptLine)
    expect(String(notifyCall![1])).toContain("Task failed: boom");
  });

  it("turn/end aborted plays task.error", async () => {
    const session = makeSession();
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "turn/end",
        seq: 1,
        time: 1,
        data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } },
      } as any);
    }
    expect(mockPlay).toHaveBeenCalledWith("task.error", expect.anything(), expect.anything());
  });

  it("tool/result error stays fully silent by default (tool_error_sounds false)", async () => {
    const session = makeSession();
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "tool/call",
        seq: 0,
        time: 0,
        data: { turn: 1, step: 1, callId: "c-1", name: "bash", arguments: "{}" },
      } as any);
      await handler(session, {
        type: "tool/result",
        seq: 1,
        time: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "tool",
            id: "m-1",
            toolCallId: "c-1",
            isError: true,
            source: { kind: "tool", callId: "c-1" },
            content: [{ type: "text", text: "nope" }],
          },
        },
      } as any);
    }
    // An individual tool failure does NOT terminate the task — neither the
    // beep nor the popup fires unless the user opted into tool_error_sounds.
    expect(mockPlay).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("tool/result error beeps and notifies when tool_error_sounds enabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      relay_mode: "relay",
      tool_error_sounds: true,
    });
    const session = makeSession();
    for (const handler of listeners["session/event"]!) {
      // The tool name comes from the earlier `tool/call` event (0.2 results
      // carry only the callId), so the firehose replays it first.
      await handler(session, {
        type: "tool/call",
        seq: 0,
        time: 0,
        data: { turn: 1, step: 1, callId: "c-1", name: "bash", arguments: "{}" },
      } as any);
      await handler(session, {
        type: "tool/result",
        seq: 1,
        time: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "tool",
            id: "m-1",
            toolCallId: "c-1",
            isError: true,
            source: { kind: "tool", callId: "c-1" },
            content: [{ type: "text", text: "nope" }],
          },
          error: { name: "ToolError", code: "exit-1", reason: "Command exited with code 1" },
        },
      } as any);
    }
    expect(mockPlay).toHaveBeenCalledWith("task.error", expect.anything(), expect.anything());
    const notifyCall = mockNotify.mock.calls.find((c) => c[4] === "error");
    expect(notifyCall).toBeDefined();
    expect(String(notifyCall![1])).toContain("[bash]");
  });

  it("compaction/end stays fully silent by default (resource.limit off)", async () => {
    const session = makeSession();
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "compaction/end",
        seq: 1,
        time: 1,
        data: {},
      } as any);
    }
    // Compaction is a routine background event — off by default, beep AND popup.
    expect(mockPlay).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("compaction/end notifies when resource.limit category enabled", async () => {
    vi.mocked(loadConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      relay_mode: "relay",
      categories: { ...DEFAULT_CONFIG.categories, "resource.limit": true },
    });
    const session = makeSession();
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "compaction/end",
        seq: 1,
        time: 1,
        data: {},
      } as any);
    }
    expect(mockPlay).toHaveBeenCalledWith("resource.limit", expect.anything(), expect.anything());
    const notifyCall = mockNotify.mock.calls.find((c) => c[4] === "compacted");
    expect(notifyCall).toBeDefined();
  });

  it("restored session (delegationDepth 0 from JSONL round-trip) still plays task.complete", async () => {
    // dsh-session-persistence-jsonl writes `delegationDepth ?? 0` and reads
    // the explicit 0 back, so a session resumed after a host restart carries
    // delegationDepth: 0 — it must still be treated as top-level.
    const session = makeSession();
    session.header.delegationDepth = 0;
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "turn/end",
        seq: 1,
        time: 1,
        data: { turn: 1, reason: { kind: "completed" } },
      } as any);
    }
    expect(mockPlay).toHaveBeenCalledWith("task.complete", expect.anything(), expect.anything());
  });

  it("subagent session (delegationDepth >= 1) stays silent", async () => {
    const session = makeSession();
    session.header.delegationDepth = 1;
    for (const handler of listeners["session/event"]!) {
      await handler(session, {
        type: "turn/end",
        seq: 1,
        time: 1,
        data: { turn: 1, reason: { kind: "completed" } },
      } as any);
    }
    expect(mockPlay).not.toHaveBeenCalled();
  });
});
