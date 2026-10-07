/**
 * Notification content generation — title and body per event type.
 *
 * Strategy (informed by upstream peon-ping's peon.sh and the pi plugin's
 * notify-content.ts):
 *
 * - Title: "<project> · <status>" where <project> comes from a priority
 *   chain (session name > git remote > folder name), and <status> is a
 *   short label describing the event type (done / error / compacted).
 *   This replaces the old hardcoded "pi · <folder>" + "Task complete".
 *
 * - Body: event-specific. For task completion we extract the assistant's
 *   last text response (truncated), so the popup actually tells you what
 *   happened instead of a generic "Task complete". For errors we name the
 *   failing tool. For compaction we say so plainly.
 *
 * Ported from pi-peon-ping-win's `src/notify-content.ts`: the pi
 * `ExtensionAPI` session-name lookup became the Harness `sessionTitle`
 * service (optional), and the pi `AgentMessage[]` history became the
 * `assistant/message` event's message (tracked from the `session/event`
 * firehose).
 */

import { execSync } from "node:child_process";
import { NO_CONSOLE_WINDOW } from "./platform.ts";

/** Maximum characters of the assistant's last response to show in the body. */
const MAX_SUMMARY_CHARS = 120;

/**
 * Resolve the project label via a priority chain.
 *
 *   1. session name  — the Harness session-title projection (like pi's
 *      `pi.getSessionName()`, which upstream prefers)
 *   2. git remote repo name — `git remote get-url origin` → trailing segment
 *   3. basename(cwd)        — folder name fallback
 *
 * Upstream has more layers (.peon-label file, project_name_map glob,
 * notification_title_script); we keep it simple since sessions already
 * have a first-class title projection.
 */
export function resolveProjectName(cwd: string, sessionName?: string): string {
  // 1. Session name (highest priority — user explicitly set it, or the
  //    harness auto-titled the session)
  const name = sessionName?.trim();
  if (name) return sanitizeLabel(name);

  // 2. Git remote repo name
  const gitRepo = readGitRepoName(cwd);
  if (gitRepo) return sanitizeLabel(gitRepo);

  // 3. Folder name fallback. Normalize backslashes to forward slashes first:
  //    `node:path`'s basename only treats the host's native separator
  //    specially, so a Windows path on a POSIX host (or vice versa) would
  //    otherwise keep the whole path. Taking the last segment manually keeps
  //    the result identical on every OS.
  const folder = cwd
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .split("/")
    .pop();
  return sanitizeLabel(folder ?? "") || "project";
}

function readGitRepoName(cwd: string): string | null {
  try {
    const out = execSync("git remote get-url origin", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      encoding: "utf8",
      ...NO_CONSOLE_WINDOW,
    }).trim();
    if (!out) return null;
    // Trim trailing slash, take last path segment, strip .git suffix
    const repo = out.replace(/\/$/, "").split(/[\/:]/).pop();
    return repo ? repo.replace(/\.git$/, "") : null;
  } catch {
    return null;
  }
}

/** Strip characters that don't play well in popup titles. */
function sanitizeLabel(s: string): string {
  return s.replace(/[^a-zA-Z0-9 ._\-\u4e00-\u9fff]/g, "").trim().slice(0, 50);
}

/** Extract the plain text of one message's content blocks. */
function blocksToText(content: readonly unknown[] | undefined, joinWith: string): string {
  if (!content || !Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join(joinWith)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the assistant's last text response for the DSH completion popup.
 * Takes the assembled assistant message straight from the `assistant/message`
 * event (the 0.2 session log has no synchronous event access, so the plugin
 * tracks the message from the firehose). Tool-call-only turns yield "" —
 * they don't tell the user anything useful in a popup.
 */
export function extractAssistantText(
  message: { readonly content?: readonly unknown[] } | undefined,
): string {
  if (!message) return "";
  const content = (message as { content?: unknown }).content;
  const text = blocksToText(Array.isArray(content) ? content : undefined, " ");
  return text ? truncate(text, MAX_SUMMARY_CHARS) : "";
}

/**
 * Extract error text from a 0.2 `tool/result` event's data.
 *
 * The preferred source is `error.reason` — the raw user-facing failure reason
 * the 0.2 event carries beside the model content. When it is absent (or the
 * tool only wrote its failure into its output) we fall back to the
 * first-class `role: 'tool'` message's text blocks: for the bash tool that is
 * the combined stdout + stderr + "Command exited with code N"; for other
 * tools it's the thrown error message. Same shape as the pi plugin's
 * `ToolExecutionEndEvent.result`.
 */
export function extractToolErrorText(result: {
  readonly message?: { readonly content?: readonly unknown[] };
  readonly error?: { readonly reason?: string };
}): string {
  if (!result || typeof result !== "object") return "";
  const reason = result.error?.reason;
  if (typeof reason === "string" && reason.trim() !== "") {
    return truncate(reason.trim(), MAX_SUMMARY_CHARS);
  }
  const content = (result.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";

  const text = blocksToText(content, "\n");
  return text ? truncate(text, MAX_SUMMARY_CHARS) : "";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Try to cut at a word boundary near the limit
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Event types that produce a distinct notification status/title suffix. */
export type NotifyStatus = "done" | "error" | "compacted";

/** Human-readable status label for the title. */
const STATUS_LABEL: Record<NotifyStatus, string> = {
  done: "done",
  error: "error",
  compacted: "compacted",
};

export interface NotifyContent {
  title: string;
  body: string;
  status: NotifyStatus;
}

/**
 * Build notification title + body for a given event.
 *
 * title: "<project> · <status>"
 * body:  event-specific (assistant summary for done, tool name for error,
 *        fixed text for compacted).
 */
export function buildNotifyContent(
  status: NotifyStatus,
  project: string,
  bodyOverride?: string,
): NotifyContent {
  const title = `${project} · ${STATUS_LABEL[status]}`;

  let body: string;
  if (bodyOverride !== undefined) {
    body = bodyOverride;
  } else if (status === "done") {
    body = "Task complete";
  } else if (status === "error") {
    body = "Tool failed";
  } else {
    body = "Context compacted";
  }

  return { title, body, status };
}
