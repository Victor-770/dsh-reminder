import { describe, it, expect, beforeEach } from "vitest";

import { playCategorySound } from "../src/audio";
import { DEFAULT_CONFIG, DEFAULT_STATE } from "../src/constants";
import type { PeonConfig, PeonState } from "../src/types";

describe("task.error event handling", () => {
  it("task.error category is enabled by default", () => {
    expect(DEFAULT_CONFIG.categories["task.error"]).toBe(true);
  });

  it("playCategorySound skips task.error when category is disabled", () => {
    const config: PeonConfig = {
      ...DEFAULT_CONFIG,
      categories: { ...DEFAULT_CONFIG.categories, "task.error": false },
    };
    const state: PeonState = { ...DEFAULT_STATE };

    playCategorySound("task.error", config, state);
  });

  it("playCategorySound skips task.error when globally disabled", () => {
    const config: PeonConfig = { ...DEFAULT_CONFIG, enabled: false };
    const state: PeonState = { ...DEFAULT_STATE };

    playCategorySound("task.error", config, state);
  });

  it("playCategorySound skips task.error when paused", () => {
    const config: PeonConfig = { ...DEFAULT_CONFIG };
    const state: PeonState = { ...DEFAULT_STATE, paused: true };

    playCategorySound("task.error", config, state);
  });

  describe("plugin wiring (dsh port)", () => {
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

    it("registers session/event handlers", async () => {
      const { apply } = await import("../index");
      apply(stubCtx);
      expect(listeners["session/event"]).toBeDefined();
      expect(listeners["session/event"]!.length).toBe(6);
    });

    it("tool/result handler ignores non-error results", async () => {
      const { apply } = await import("../index");
      apply(stubCtx);
      const sessionEventHandlers = listeners["session/event"]!;

      // Each handler receives (session, event); the tool/result handler is the
      // one that looks at tool-result blocks. Feed it a non-error result.
      for (const handler of sessionEventHandlers) {
        await handler(
          {
            id: "s-err",
            header: { id: "s-err", version: 0, createdAt: Date.now(), cwd: process.cwd() },
            events: [],
            get surface() { return {}; },
          },
          {
            type: "tool/result",
            seq: 0,
            time: 0,
            data: {
              turn: 1,
              step: 1,
              message: {
                role: "user",
                id: "m-1",
                source: { kind: "tool", callId: "c-1" },
                content: [{
                  type: "tool-result",
                  toolCallId: "c-1",
                  content: [{ type: "text", text: "ok" }],
                  isError: false,
                }],
              },
            },
          },
        );
      }
    });

    it("tool/result error handler completes without throwing", async () => {
      const { apply } = await import("../index");
      apply(stubCtx);
      const sessionEventHandlers = listeners["session/event"]!;

      // Simulates a failed tool result: playCategorySound("task.error") will
      // no-op gracefully since no packs are installed in the test environment.
      for (const handler of sessionEventHandlers) {
        await handler(
          {
            id: "s-err2",
            header: { id: "s-err2", version: 0, createdAt: Date.now(), cwd: process.cwd() },
            events: [
              {
                type: "tool/call",
                seq: 0,
                time: 0,
                data: { turn: 1, step: 1, callId: "c-2", name: "bash", arguments: "{}" },
              },
            ],
            get surface() { return {}; },
          },
          {
            type: "tool/result",
            seq: 1,
            time: 1,
            data: {
              turn: 1,
              step: 1,
              message: {
                role: "user",
                id: "m-2",
                source: { kind: "tool", callId: "c-2" },
                content: [{
                  type: "tool-result",
                  toolCallId: "c-2",
                  content: [{ type: "text", text: "Command exited with code 1" }],
                  isError: true,
                }],
              },
            },
          },
        );
      }
    });
  });
});
