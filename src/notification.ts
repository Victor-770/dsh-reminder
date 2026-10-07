import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./constants.ts";
import type { NotifyStatus } from "./notify-content.ts";
import { detectPlatform, detectPwshBin, NO_CONSOLE_WINDOW, type Platform } from "./platform.ts";

export const DEFAULT_ICON_PATH = join(DATA_DIR, "peon-icon.png");

export type Notifier = "osascript" | "notify-send" | "powershell" | "wintoast" | "winforms";

/** AppUserModelID the native Windows toast is attributed to. */
export const TOAST_AUMID = "peon-ping";

export interface NotifyCommand {
  bin: string;
  args: string[];
}

function defaultCommandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "pipe", ...NO_CONSOLE_WINDOW });
    return true;
  } catch {
    return false;
  }
}

export function escapeNotificationText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function detectNotifier(
  platform: Platform = detectPlatform(),
  commandExists: (cmd: string) => boolean = defaultCommandExists,
): Notifier | null {
  switch (platform) {
    case "mac":
      return "osascript";
    case "linux":
      return commandExists("notify-send") ? "notify-send" : null;
    case "win":
      // Fork: native Windows shows a real Windows toast (bottom-right, and in
      // the Action Center) instead of the self-drawn WinForms banner. The
      // banner renderer is kept as an explicit `winforms` choice, but a
      // native toast is what the OS and users expect.
      return "wintoast";
    case "wsl":
      return "powershell";
    default:
      return null;
  }
}

export function resolveIcon(packPath?: string): string {
  if (packPath) {
    const packIcon = join(packPath, "icon.png");
    if (existsSync(packIcon)) return packIcon;
  }
  return DEFAULT_ICON_PATH;
}

export function buildNotifyCommand(
  notifier: Notifier | string,
  title: string,
  body: string,
  iconPath?: string,
  status?: NotifyStatus,
  promptLine?: string,
): NotifyCommand | null {
  const safeTitle = escapeNotificationText(title);
  const safeBody = escapeNotificationText(body);

  switch (notifier) {
    case "osascript": {
      const script = `display notification "${safeBody}" with title "${safeTitle}"`;
      return { bin: "osascript", args: ["-e", script] };
    }
    case "notify-send": {
      const args = [];
      if (iconPath) args.push(`--icon=${iconPath}`);
      args.push(title, body);
      return { bin: "notify-send", args };
    }
    case "wintoast": {
      return buildWinToastCommand(safeTitle, safeBody, iconPath);
    }
    case "winforms": {
      return buildWinFormsCommand(safeTitle, safeBody, iconPath, status, promptLine);
    }
    case "powershell": {
      // WSL toast, text-only. The WinRT `appLogoOverride` icon is
      // deliberately omitted: loading an icon from the WSL filesystem
      // requires a `\\wsl.localhost\...` path (or copying the file out),
      // and WinRT silently drops non-standard icon sizes — the text toast
      // itself works reliably, which is what matters here.
      //
      // The text is interpolated into PowerShell single-quoted strings, so
      // any `'` in the title/body (assistant summaries routinely contain
      // code snippets like `playCategorySound('task.complete', ...)`) would
      // terminate the string and make the whole script fail SILENTLY.
      const psTitle = escapeNotificationText(title).replace(/'/g, "''");
      const psBody = escapeNotificationText(body).replace(/'/g, "''");
      const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $template.GetElementsByTagName('text')
$text.Item(0).AppendChild($template.CreateTextNode('${psTitle}')) > $null
$text.Item(1).AppendChild($template.CreateTextNode('${psBody}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('peon-ping').Show($toast)
`.trim();
      return { bin: detectPwshBin() ?? "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", ps] };
    }
    default:
      return null;
  }
}

export interface NotifyOptions {
  platform?: Platform;
  iconPath?: string;
  status?: NotifyStatus;
  promptLine?: string;
}

export function sendDesktopNotification(
  title: string,
  body: string,
  options: NotifyOptions | Platform = {},
): boolean {
  const opts: NotifyOptions = typeof options === "string"
    ? { platform: options }
    : options;
  const platform = opts.platform ?? detectPlatform();
  const notifier = detectNotifier(platform);
  if (!notifier) return false;

  const cmd = buildNotifyCommand(notifier, title, body, opts.iconPath, opts.status, opts.promptLine);
  if (!cmd) return false;

  // Windows: detached must be false. With detached:true, Node creates the
  // child with CREATE_NEW_PROCESS_GROUP, which breaks the desktop association
  // for WinForms — the PowerShell process runs to completion but no window
  // ever renders on the interactive desktop. Other platforms keep detached:
  // true so short-lived notifiers (osascript/notify-send) survive parent exit.
  //
  // windowsHide (NO_CONSOLE_WINDOW) is what keeps the terminal window from
  // flashing on the desktop harness: it only adds CREATE_NO_WINDOW, so it
  // does not disturb the interactive-desktop association the WinForms form
  // needs (verified: the popup still renders with the flag set).
  const isWindows = platform === "win";
  try {
    const child = spawn(cmd.bin, cmd.args, {
      stdio: "ignore",
      detached: !isWindows,
      ...NO_CONSOLE_WINDOW,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Native Windows toast (WinRT): the shell renders it in the bottom-right and
 * leaves it in the Action Center — the same surface every other app uses.
 *
 * The AUMID registration is what makes it work at all. WinRT silently drops a
 * toast whose AppUserModelID has no identity, and an unpackaged desktop app has
 * no Start-menu shortcut to inherit one from. Registering
 * `HKCU\Software\Classes\AppUserModelId\<aumid>` (DisplayName + IconUri) gives
 * it an identity; without that entry `Show()` returns normally and nothing
 * ever appears — exactly the failure mode the old WSL-style toast hit.
 */
function buildWinToastCommand(title: string, body: string, iconPath?: string): NotifyCommand {
  const psSingle = (s: string) => s.replace(/'/g, "''");
  const iconWinPath = iconPath ? iconPath.replace(/\//g, "\\") : "";
  const lines = [
    `$aumid = '${TOAST_AUMID}'`,
    `$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $aumid`,
    `New-Item -Path $key -Force | Out-Null`,
    `Set-ItemProperty -Path $key -Name 'DisplayName' -Value '${psSingle(TOAST_AUMID)}'`,
  ];
  if (iconWinPath !== "") {
    lines.push(`Set-ItemProperty -Path $key -Name 'IconUri' -Value '${psSingle(iconWinPath)}'`);
  }
  lines.push(
    `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null`,
    `$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)`,
    `$text = $template.GetElementsByTagName('text')`,
    `$text.Item(0).AppendChild($template.CreateTextNode('${psSingle(title)}')) > $null`,
    `$text.Item(1).AppendChild($template.CreateTextNode('${psSingle(body)}')) > $null`,
    // Silence the toast: the Peon clip *is* the notification sound, so the
    // shell's default chime would double it up. The `<audio silent="true"/>`
    // element is the form WinRT accepts here — the typed ToastAudio API is not
    // resolvable from Windows PowerShell 5.1.
    `$audio = $template.CreateElement('audio')`,
    `$audio.SetAttribute('silent', 'true')`,
    `$template.DocumentElement.AppendChild($audio) > $null`,
    `$toast = [Windows.UI.Notifications.ToastNotification]::new($template)`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)`,
  );
  return {
    bin: detectPwshBin() ?? "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command", lines.join("\n")],
  };
}

// Legacy renderer: a self-drawn WinForms banner, kept as an explicit choice
// now that `win` selects the native toast above.
//
// Its remaining virtue is unconditional rendering: a borderless form does not
// go through the shell's notification plumbing at all, so it still appears on
// machines where toasts are disabled system-wide or swallowed by Focus Assist.
//
// The original rationale for preferring it ("WinRT Toast from
// `-NonInteractive -Command` silently fails") was a misdiagnosis: the toast
// never rendered because its AppUserModelID had never been registered, not
// because of the launch flags. With registration it works from exactly those
// flags — see buildWinToastCommand.
function buildWinFormsCommand(
  title: string,
  body: string,
  iconPath?: string,
  status?: NotifyStatus,
  promptLine?: string,
): NotifyCommand {
  // Paths into PowerShell single-quoted strings: escape ' as ''
  const psSingle = (s: string) => s.replace(/'/g, "''");
  const iconWinPath = iconPath ? iconPath.replace(/\//g, "\\") : "";
  const safeIconPath = psSingle(iconWinPath);
  const safePromptLine = promptLine ? psSingle(promptLine) : "";

  // PowerShell template. Single-quoted strings inside; we interpolate only
  // safe values from above.
  //
  // Layout notes (verified via popup-test/v2-new-layout.ps1):
  //   - form 720x220 (was 580x180): wider text area shows more content,
  //     taller form fits 3 lines of body without crowding the bottom edge
  //   - font: SystemFonts.DefaultFont family (NOT hardcoded 'Segoe UI')
  //     Segoe UI has no CJK glyphs; Windows falls back to YaHei UI whose
  //     ascent metrics differ, causing the top of Chinese characters to be
  //     clipped when the Label sizes itself by the Segoe UI metrics.
  //   - TextAlign: TopLeft (NOT MiddleLeft). MiddleLeft relies on
  //     TextRenderer.MeasureText which under-measures on .NET 5+
  //     (dotnet/winforms#8368), pushing text up and clipping the top.
  //   - body height: measured via TextRenderer.MeasureText on a 3-line probe
  //     rather than Font.GetHeight*3 — GetHeight underestimates line spacing
  //     and only 2 lines would render in the nominal 3-line box.
  //   - AutoEllipsis on body: if the assistant summary exceeds 3 lines,
  //     WinForms appends "…" instead of overflowing.
  // Layout (verified via tmp/popup-test/v3-layout.ps1):
  //   - form 920 wide -> textWidth ~752 (36% more chars/line than the 580 form)
  //   - three rows when promptLine is set: title / prompt(1 line) / body(3 lines);
  //     two rows when absent: title / body (prompt section collapses to 0)
  //   - row heights come from TextRenderer.MeasureText, not hardcoded constants —
  //     AutoEllipsis only draws the ellipsis glyph when Size.Height >= the
  //     EndEllipsis probe height; under-sizing silently drops the text entirely
  //   - prompt prefixed with "> " (markdown-quote styling)
  //   - NoActivateForm overrides ShowWithoutActivation -> popup doesn't steal
  //     keyboard focus; TopMost still keeps it visually on top
  //   - background color by status, mirroring upstream peon-ping notify.sh
  //     (done=blue 30,80,180 / error=red 180,0,0 / compacted=yellow 200,160,0)
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing

# Form subclass that shows without stealing keyboard focus. TopMost keeps
# it visually on top; ShowWithoutActivation keeps focus on the user's window.
if (-not ("NoActivateForm" -as [type])) {
    Add-Type -ReferencedAssemblies System.Windows.Forms @'
using System.Windows.Forms;
public class NoActivateForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
'@
}

$iconPath = '${safeIconPath}'
$hasIcon = ($iconPath -ne '') -and (Test-Path $iconPath)

# Background color by event status. RGB values mirror upstream peon-ping's
# notify.sh WinForms renderer (scripts/notify.sh lines 554-558):
#   done       -> blue   (30, 80, 180)
#   error      -> red    (180, 0, 0)
#   compacted  -> yellow (200, 160, 0)
# Unknown/missing falls back to the original neutral dark.
$status = '${status ?? ""}'
switch ($status) {
    'done'       { $bgColor = [System.Drawing.Color]::FromArgb(30, 80, 180) }
    'error'      { $bgColor = [System.Drawing.Color]::FromArgb(180, 0, 0) }
    'compacted'  { $bgColor = [System.Drawing.Color]::FromArgb(200, 160, 0) }
    default      { $bgColor = [System.Drawing.Color]::FromArgb(30, 30, 40) }
}

# Prompt line (optional). agent_end / tool_execution_end pass the user's
# last message; session_compact leaves it empty.
$promptText = '${safePromptLine}'
$hasPrompt = $promptText -ne ''

# Fonts: system default UI family. Hardcoding 'Segoe UI' forces a font-link
# fallback for CJK whose ascent metrics differ, clipping the top of Chinese
# characters (Flow-Launcher/Flow.Launcher#4373).
$uiFontFamily = [System.Drawing.SystemFonts]::DefaultFont.FontFamily
$titleFont  = New-Object System.Drawing.Font($uiFontFamily, 24, [System.Drawing.FontStyle]::Bold)
$promptFont = New-Object System.Drawing.Font($uiFontFamily, 14)
$bodyFont   = New-Object System.Drawing.Font($uiFontFamily, 14)

# Layout constants
$formWidth  = 920
$iconSize   = 100
$iconX      = 24
$textX      = $iconX + $iconSize + 20
$textWidth  = $formWidth - $textX - 24
$topPad     = 24
$gapTitle   = 8        # title -> prompt
$gapPrompt  = 16       # prompt -> body (larger, visual separation)
$bottomPad  = 24

# All row heights measured by the system, not hardcoded. AutoEllipsis only
# renders the ellipsis glyph when Size.Height >= what DrawText(EndEllipsis)
# asks for; under-sizing silently drops the text (the exact bug we hit when
# prompt Height was hardcoded to 28).
$titleProbe = [System.Windows.Forms.TextRenderer]::MeasureText(
    'Ag中文', $titleFont,
    (New-Object System.Drawing.Size([int]::MaxValue, [int]::MaxValue)),
    [System.Windows.Forms.TextFormatFlags]::NoPrefix)
$titleHeight = [int]$titleProbe.Height + 8

$bodyProbeText = "line1" + [char]10 + "line2" + [char]10 + "line3"
$bodyProbe = [System.Windows.Forms.TextRenderer]::MeasureText(
    $bodyProbeText, $bodyFont,
    (New-Object System.Drawing.Size($textWidth, [int]::MaxValue)),
    [System.Windows.Forms.TextFormatFlags]::WordBreak -bor [System.Windows.Forms.TextFormatFlags]::NoPrefix)
$bodyHeight = [int]$bodyProbe.Height + 20   # +20 ensures 3 lines actually render

# Prompt section height is 0 when no prompt — collapses layout to title/body.
$promptHeight = 0
if ($hasPrompt) {
    $promptProbe = [System.Windows.Forms.TextRenderer]::MeasureText(
        $promptText, $promptFont,
        (New-Object System.Drawing.Size($textWidth, [int]::MaxValue)),
        [System.Windows.Forms.TextFormatFlags]::NoPrefix -bor [System.Windows.Forms.TextFormatFlags]::EndEllipsis)
    $promptHeight = [int]$promptProbe.Height + 6
}

# Total text block height (conditional on prompt presence)
if ($hasPrompt) {
    $textBlockH = $titleHeight + $gapTitle + $promptHeight + $gapPrompt + $bodyHeight
} else {
    $textBlockH = $titleHeight + $gapTitle + $bodyHeight
}
$formHeight = $topPad + $textBlockH + $bottomPad

# Vertical positions
$label1Y      = $topPad
$labelPromptY = $label1Y + $titleHeight + $gapTitle
if ($hasPrompt) {
    $label2Y = $labelPromptY + $promptHeight + $gapPrompt
} else {
    $label2Y = $labelPromptY
}

# Icon vertically centered on the whole text block
$iconY = $topPad + [int](($textBlockH - $iconSize) / 2)
if ($iconY -lt 20) { $iconY = 20 }

$screens = [System.Windows.Forms.Screen]::AllScreens
$forms = New-Object System.Collections.ArrayList

foreach ($screen in $screens) {
    $form = New-Object NoActivateForm
    $form.Text = 'peon-ping'
    $form.TopMost = $true
    $form.FormBorderStyle = 'None'
    $form.BackColor = $bgColor
    $form.Size = New-Object System.Drawing.Size($formWidth, $formHeight)
    $form.ShowInTaskbar = $false
    $form.StartPosition = 'Manual'

    $wa = $screen.WorkingArea
    $x = $wa.X + [int](($wa.Width - $formWidth) / 2)
    $y = $wa.Y + [int]($wa.Height / 4) - [int]($formHeight / 2)
    $form.Location = New-Object System.Drawing.Point($x, $y)

    if ($hasIcon) {
        $pictureBox = New-Object System.Windows.Forms.PictureBox
        $pictureBox.Location = New-Object System.Drawing.Point($iconX, $iconY)
        $pictureBox.Size = New-Object System.Drawing.Size($iconSize, $iconSize)
        $pictureBox.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
        $pictureBox.Image = [System.Drawing.Image]::FromFile($iconPath)
        $form.Controls.Add($pictureBox)
    }

    # Title
    $label1 = New-Object System.Windows.Forms.Label
    $label1.Text = '${title.replace(/'/g, "''")}'
    $label1.Font = $titleFont
    $label1.ForeColor = [System.Drawing.Color]::White
    $label1.AutoSize = $false
    $label1.Size = New-Object System.Drawing.Size($textWidth, $titleHeight)
    $label1.TextAlign = [System.Drawing.ContentAlignment]::TopLeft
    $label1.Location = New-Object System.Drawing.Point($textX, $label1Y)

    # Body (3-line assistant summary; AutoEllipsis truncates overflow)
    $label2 = New-Object System.Windows.Forms.Label
    $label2.Text = '${body.replace(/'/g, "''")}'
    $label2.Font = $bodyFont
    $label2.ForeColor = [System.Drawing.Color]::LightGray
    $label2.AutoSize = $false
    $label2.Size = New-Object System.Drawing.Size($textWidth, $bodyHeight)
    $label2.TextAlign = [System.Drawing.ContentAlignment]::TopLeft
    $label2.AutoEllipsis = $true
    $label2.Location = New-Object System.Drawing.Point($textX, $label2Y)

    $form.Controls.Add($label1)
    $form.Controls.Add($label2)

    # Prompt (optional, between title and body). "> " prefix marks it as a
    # quoted echo of the user's message.
    if ($hasPrompt) {
        $labelP = New-Object System.Windows.Forms.Label
        $labelP.Text = '> ' + $promptText
        $labelP.Font = $promptFont
        $labelP.ForeColor = [System.Drawing.Color]::LightGray
        $labelP.AutoSize = $false
        $labelP.Size = New-Object System.Drawing.Size($textWidth, $promptHeight)
        $labelP.TextAlign = [System.Drawing.ContentAlignment]::TopLeft
        $labelP.AutoEllipsis = $true
        $labelP.Location = New-Object System.Drawing.Point($textX, $labelPromptY)
        $form.Controls.Add($labelP)
    }

    $forms.Add($form) | Out-Null
}

foreach ($f in $forms) { $f.Show() | Out-Null }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({
    foreach ($f in $forms) { $f.Close() }
    [System.Windows.Forms.Application]::Exit()
})
$timer.Start()

[System.Windows.Forms.Application]::Run()`;

  return { bin: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", ps] };
}
