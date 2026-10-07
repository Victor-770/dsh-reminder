import { describe, it, expect } from "vitest";
import {
  buildNotifyContent,
  extractAssistantText,
  extractToolErrorText,
  resolveProjectName,
} from "../src/notify-content";

describe("resolveProjectName", () => {
  it("prefers the session name over folder name", () => {
    expect(resolveProjectName("C:\\some\\project", "My Session")).toBe("My Session");
  });

  it("falls back to the folder name", () => {
    expect(resolveProjectName("C:\\some\\project")).toBe("project");
  });

  it("sanitizes invalid characters", () => {
    expect(resolveProjectName("C:\\some\\pro*ject<>")).toBe("project");
  });
});

describe("extractAssistantText (assistant/message payload)", () => {
  it("extracts the message's text", () => {
    const message = { role: "assistant", id: "a1", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "First response" }] };
    expect(extractAssistantText(message)).toBe("First response");
  });

  it("skips tool-call-only messages", () => {
    const message = { role: "assistant", id: "a1", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "tool-call", id: "c", name: "bash", arguments: "{}" }] };
    expect(extractAssistantText(message)).toBe("");
  });

  it("truncates long text", () => {
    const long = "word ".repeat(50);
    const message = { role: "assistant", id: "a1", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: long }] };
    const result = extractAssistantText(message);
    expect(result.length).toBeLessThan(long.length);
    expect(result.endsWith("…")).toBe(true);
  });

  it("returns empty for an undefined message", () => {
    expect(extractAssistantText(undefined)).toBe("");
  });
});

describe("extractToolErrorText (0.2 tool/result data)", () => {
  it("prefers the user-facing error reason", () => {
    const data = {
      message: { role: "tool", id: "t1", toolCallId: "c-1", isError: true, source: { kind: "tool", callId: "c-1" }, content: [{ type: "text", text: "stdout\nstderr" }] },
      error: { name: "ToolError", code: "exit-1", reason: "Command exited with code 1" },
    };
    const result = extractToolErrorText(data);
    expect(result).toBe("Command exited with code 1");
  });

  it("falls back to the tool message's text blocks", () => {
    const data = {
      message: { role: "tool", id: "t1", toolCallId: "c-1", isError: true, source: { kind: "tool", callId: "c-1" }, content: [{ type: "text", text: "stdout\nstderr" }] },
    };
    const result = extractToolErrorText(data);
    expect(result).toContain("stdout");
    expect(result).toContain("stderr");
  });

  it("returns empty when no text blocks", () => {
    const data = { message: { role: "tool", id: "t2", toolCallId: "c-2", isError: true, source: { kind: "tool", callId: "c-2" }, content: [] } };
    expect(extractToolErrorText(data)).toBe("");
  });

  it("returns empty for non-object input", () => {
    expect(extractToolErrorText(null as never)).toBe("");
    expect(extractToolErrorText("oops" as never)).toBe("");
  });
});

describe("buildNotifyContent", () => {
  it("builds done content with a summary override", () => {
    const { title, body, status } = buildNotifyContent("done", "project", "Done!");
    expect(title).toBe("project · done");
    expect(body).toBe("Done!");
    expect(status).toBe("done");
  });

  it("builds done content with fallback text", () => {
    const { body } = buildNotifyContent("done", "project");
    expect(body).toBe("Task complete");
  });

  it("builds error content", () => {
    const { title, body } = buildNotifyContent("error", "project", "[bash]: failed");
    expect(title).toBe("project · error");
    expect(body).toBe("[bash]: failed");
  });

  it("builds compacted content", () => {
    const { title, body } = buildNotifyContent("compacted", "project");
    expect(title).toBe("project · compacted");
    expect(body).toBe("Context compacted");
  });
});
