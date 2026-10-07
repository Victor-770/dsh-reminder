import { describe, it, expect } from "vitest";

describe("notification", () => {
  describe("detectNotifier", () => {
    it("returns 'osascript' on mac", async () => {
      const { detectNotifier } = await import("../src/notification");
      expect(detectNotifier("mac")).toBe("osascript");
    });

    it("returns 'notify-send' on linux when available", async () => {
      const { detectNotifier } = await import("../src/notification");
      const exists = (cmd: string) => cmd === "notify-send";
      expect(detectNotifier("linux", exists)).toBe("notify-send");
    });

    it("returns null on linux when notify-send is not available", async () => {
      const { detectNotifier } = await import("../src/notification");
      const exists = (_cmd: string) => false;
      expect(detectNotifier("linux", exists)).toBeNull();
    });

    it("returns 'powershell' on wsl", async () => {
      const { detectNotifier } = await import("../src/notification");
      expect(detectNotifier("wsl")).toBe("powershell");
    });

    it("returns 'wintoast' on native windows", async () => {
      const { detectNotifier } = await import("../src/notification");
      expect(detectNotifier("win")).toBe("wintoast");
    });

    it("returns null on unknown platform", async () => {
      const { detectNotifier } = await import("../src/notification");
      expect(detectNotifier("unknown")).toBeNull();
    });
  });

  describe("buildNotifyCommand", () => {
    it("builds osascript command for mac", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("osascript", "Test Title", "Test Body");
      expect(cmd).not.toBeNull();
      expect(cmd!.bin).toBe("osascript");
      expect(cmd!.args).toContain("-e");
      const script = cmd!.args[cmd!.args.indexOf("-e") + 1];
      expect(script).toContain("Test Title");
      expect(script).toContain("Test Body");
    });

    it("builds notify-send command for linux", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("notify-send", "Hello", "World");
      expect(cmd).not.toBeNull();
      expect(cmd!.bin).toBe("notify-send");
      expect(cmd!.args).toContain("Hello");
      expect(cmd!.args).toContain("World");
    });

    it("builds powershell toast command for wsl", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("powershell", "Title", "Body");
      expect(cmd).not.toBeNull();
      // Fork: bin is now dynamic via detectPwshBin() — pwsh if installed, else
      // powershell.exe. Accept any of the four valid forms.
      expect(cmd!.bin).toMatch(/^(pwsh|powershell)(\.exe)?$/);
      const scriptArg = cmd!.args.find((a: string) => a.includes("Title"));
      expect(scriptArg).toBeDefined();
      expect(scriptArg).toContain("Body");
    });

    it("builds winforms command for native windows", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("winforms", "Title", "Body");
      expect(cmd).not.toBeNull();
      expect(cmd!.bin).toBe("powershell.exe");
      expect(cmd!.args).toContain("-STA");
      const script = cmd!.args[cmd!.args.length - 1];
      expect(script).toContain("NoActivateForm");
      expect(script).toContain("Title");
      expect(script).toContain("Body");
    });

    it("builds a native toast command for windows", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("wintoast", "Title", "Body", "C:/icon.png");
      expect(cmd).not.toBeNull();
      expect(cmd!.bin).toMatch(/^(pwsh|powershell)(\.exe)?$/);
      const script = cmd!.args[cmd!.args.length - 1];
      // Registering the AppUserModelID is what makes WinRT display anything.
      expect(script).toContain("AppUserModelId");
      expect(script).toContain("ToastNotificationManager");
      expect(script).toContain("IconUri");
      expect(script).toContain("CreateTextNode('Title')");
      expect(script).toContain("CreateTextNode('Body')");
      // The plugin's own clip is the alert sound; the shell chime must be off.
      expect(script).toContain(`SetAttribute('silent', 'true')`);
    });

    it("doubles single quotes in the native toast script", async () => {
      // Same failure mode as the WSL toast: a bare ' would end the
      // PowerShell string literal and silently kill the notification.
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("wintoast", "it's done", "playCategorySound('task.complete')");
      expect(cmd).not.toBeNull();
      const script = cmd!.args[cmd!.args.length - 1];
      expect(script).toContain("CreateTextNode('it''s done')");
      expect(script).toContain("CreateTextNode('playCategorySound(''task.complete'')')");
    });

    it("returns null for unknown notifier", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("unknown-thing" as any, "T", "B");
      expect(cmd).toBeNull();
    });

    it("escapes special characters in title and body", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("osascript", 'say "hi"', "it's done");
      expect(cmd).not.toBeNull();
      const script = cmd!.args[cmd!.args.indexOf("-e") + 1];
      expect(script).not.toMatch(/(?<!\\)"{2}/);
    });

    it("includes --icon for notify-send when iconPath provided", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("notify-send", "Hello", "World", "/path/to/icon.png");
      expect(cmd).not.toBeNull();
      expect(cmd!.args).toContain("--icon=/path/to/icon.png");
    });

    it("omits --icon for notify-send when no iconPath", async () => {
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("notify-send", "Hello", "World");
      expect(cmd).not.toBeNull();
      const hasIcon = cmd!.args.some((a: string) => a.startsWith("--icon"));
      expect(hasIcon).toBe(false);
    });

    it("includes icon in osascript when iconPath provided", async () => {
      // osascript doesn't support custom icons natively, so we just confirm it doesn't break
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("osascript", "Title", "Body", "/path/to/icon.png");
      expect(cmd).not.toBeNull();
      expect(cmd!.bin).toBe("osascript");
    });

    it("keeps the powershell toast text-only (no icon binding)", async () => {
      // WSL toast is deliberately text-only: WinRT appLogoOverride silently
      // drops icons served from `\\wsl.localhost\...` paths (and non-standard
      // sizes), so we don't hand it an icon at all.
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("powershell", "Title", "Body", "/path/to/icon.png");
      expect(cmd).not.toBeNull();
      const script = cmd!.args.join(" ");
      expect(script).not.toContain("appLogoOverride");
      expect(script).not.toContain("icon.png");
    });

    it("doubles single quotes in the powershell toast (assistant summaries contain code)", async () => {
      // The toast text is interpolated into PowerShell single-quoted strings;
      // a bare `'` (e.g. `playCategorySound('task.complete', ...)` in a
      // summary) would terminate the string and make the script fail
      // silently — no popup, no error.
      const { buildNotifyCommand } = await import("../src/notification");
      const cmd = buildNotifyCommand("powershell", "it's done", "playCategorySound('task.complete')", "/path/to/icon.png");
      expect(cmd).not.toBeNull();
      const script = cmd!.args.join(" ");
      expect(script).toContain("CreateTextNode('it''s done')");
      expect(script).toContain("CreateTextNode('playCategorySound(''task.complete'')')");
      expect(script).not.toContain("CreateTextNode('it's");
    });
  });

  describe("escapeNotificationText", () => {
    it("escapes double quotes", async () => {
      const { escapeNotificationText } = await import("../src/notification");
      expect(escapeNotificationText('say "hello"')).toBe('say \\"hello\\"');
    });

    it("escapes backslashes", async () => {
      const { escapeNotificationText } = await import("../src/notification");
      expect(escapeNotificationText("path\\to\\file")).toBe("path\\\\to\\\\file");
    });

    it("handles clean strings unchanged", async () => {
      const { escapeNotificationText } = await import("../src/notification");
      expect(escapeNotificationText("Task complete")).toBe("Task complete");
    });
  });
});
