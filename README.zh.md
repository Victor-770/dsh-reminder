# dsh-reminder

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 peon-ping 声音通知插件 —— **忠实移植**自 pi 插件 [`pi-peon-ping-win`](https://github.com/Gohan/pi-peon-ping-win)。

在生命周期事件时播放主题音效（魔兽争霸 III 苦工、GLaDOS、Duke Nukem、星际争霸等），并显示桌面通知 —— 支持原生 Windows（三级音频回退：`ffplay` → `mpv` → `winmm.dll PlaySound`，Windows 原生 Toast 通知）。

## 致谢

本项目是**移植作品**，并非原创。所有底层功能的功劳归于原作者：

- **[pi-peon-ping](https://github.com/joshuadavidthomas/pi-peon-ping)** —— [Josh Thomas](https://github.com/joshuadavidthomas)，pi 编程代理的 peon-ping 通知扩展原作。
- **[pi-peon-ping-win](https://github.com/Gohan/pi-peon-ping-win)** —— [cppgohan](https://github.com/Gohan)，添加原生 Windows 支持的 fork（音频回退、WinForms 弹窗、事件感知通知）。
- **[peon-ping](https://github.com/PeonPing/peon-ping)** 与 [OpenPeon](https://github.com/PeonPing/og-packs) 音效包 / 音效库。

感谢以上项目以 MIT 许可证开源，使本移植成为可能。

## 功能

| 事件 | 音效分类 | 桌面通知 | 默认音效 |
|-------|----------|----------|----------|
| 会话开始 | `session.start` —— “Ready to work?” | — | 关 |
| Agent 开始工作 | `task.acknowledge` —— “Work, work.” | — | 关 |
| 单个工具失败 | `task.error` —— 错误音效 | `error` —— 正文标明出错工具 | 关（声音和弹窗都跟随 `tool_error_sounds` 开关） |
| 快速连续提问（10 秒内 ≥3 次） | `user.spam` —— 不耐烦语音 | — | 关 |
| **任务完成** | `task.complete` —— 完成音效 | `done` —— 正文显示助手最后回复（截断） | **开** |
| **任务意外终止**（出错 / 取消 / 阻塞 / 达到 token 上限） | `task.error` —— 错误音效 | `error` —— 正文标明失败原因 | **开** |
| 上下文压缩 | `resource.limit` —— 极限音效 | `compacted` —— 正文：“Context compacted” | 关 |

**dsh 移植默认：保持安静 —— 只有任务「完成」或「意外终止」时会响。** 其余事件（会话开始、每次提问的 ack、快速提问、单个工具出错、压缩）默认关闭，可用 `/peon toggle <category>` 重新开启（工具出错用 `/peon tool-error on`）。

功能表与 pi 插件一致，只是宿主换成了 dsh，且默认开关集合不同。事件映射：

| pi 事件 | dsh 事件 |
|----------|----------|
| `session_start` | `session/created`（顶层会话） |
| `before_agent_start` | `user/message`（kind `user`） |
| `agent_start` | `turn/start` |
| `tool_execution_end`（出错） | `tool/result` 且 `isError` |
| `agent_end` | `turn/end` |
| `session_compact` | `compaction/end`（**压缩完成后**触发） |

## 环境要求

- DeepSeek Harness（任意 profile —— 插件以 profile bundle 方式安装）
- 系统装有音频播放器（见下方平台支持）。Windows 上推荐 `winget install Gyan.FFmpeg`。

## 安装（npm）

以 profile 插件方式安装：

```bash
dsh plugin --profile web add dsh-reminder
```

重启 harness（或重载 profile），让新的 bundle 层挂载。bundle patch（`cordis.patch.yml`）会自动插入 `peon-ping` 插件行 —— 无需手动编辑 `cordis.patch.yml`。

从本地目录安装：

```bash
dsh plugin --profile web add D:/1codeprojects/dsh-plugins/dsh-reminder
```

卸载：

```bash
dsh plugin --profile web remove dsh-reminder
```

## 使用方法

所有设置都在**网页设置页**里：打开设置（侧边栏齿轮图标），在 **Agent 预设** 下面找到 **peon-ping 声音** 一节。在那里可以：

- 查看当前状态（音效包、音量、开关、中继模式）和宿主返回的通知信息；
- **安装默认音效包**（从 [peon-ping registry](https://peonping.github.io/registry/) 下载 10 个默认包）；
- 从已安装的音效包中选择当前使用的包；
- 调节音量；
- 开关桌面通知、工具出错响铃，以及每个音效分类；
- 暂停/恢复声音、设置静默窗口与中继模式；
- **试听** 当前音效包的 session.start 声音。

改动会立即写入 `~/.config/peon-ping/config.json`，下一次事件即生效，无需重启。已删除 `/peon` 斜杠命令 —— pi 的 TUI 面板改成了这个网页页面。

> **设置页的传输通道**：设置页通过插件自带的 `/peon/api` HTTP 路由读写配置（与网页同源，走浏览器信任篱笆），**不依赖** dsh 宿主向网页客户端暴露的设置命名空间白名单（`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 只放行内置 namespace，第三方插件的 namespace 即使注册成功也会被过滤）。因此本插件在未把 `peon-ping` 加入白名单的 dsh 版本上，设置页也能正常显示和操作。

## 平台支持

| 平台 | 播放器 | 通知 |
|----------|--------|------|
| macOS | `afplay`（内置） | `osascript` |
| Linux | `pw-play`、`paplay`、`ffplay`、`mpv`、`play`、`aplay`（按顺序探测） | `notify-send`（需要桌面环境） |
| WSL | PowerShell `MediaPlayer` —— WSL 路径会先经 `wslpath -w` 转换成 Windows 视图（`\\wsl.localhost\<发行版>\...` 或 `D:\...`），Windows 侧才能真正打开文件 | Windows Toast（纯文本，无图标 —— WinRT 对 WSL 路径的图标会静默丢弃） |
| **Windows（原生）** ⭐ | `ffplay`（推荐，`winget install Gyan.FFmpeg`）→ `mpv` → `winmm.dll PlaySound` 回退（无音量控制） | Windows 原生 Toast 通知（右下角 + 通知中心；已静音，只保留音效包的声音） |

WSL 音频在任意发行版上开箱即用：`\\wsl.localhost\<发行版>\...` 前缀、用户名、`/mnt/<盘符>` 挂载都由 `wslpath -w` 在每台机器上动态解析 —— **没有任何写死的路径**。

## 配置与数据

配置、状态与音效包与 pi 插件共用**同一目录**，已安装过 pi-peon-ping 的机器可直接复用音效包与设置：

- `~/.config/peon-ping/config.json`
- `~/.config/peon-ping/state.json`
- `~/.config/peon-ping/packs/`

| 选项 | 默认值 | 说明 |
|--------|---------|-------------|
| `default_pack` | `"sc_kerrigan"` | 当前音效包（本移植版推荐的音效包，安装默认包时排在最前） |
| `volume` | `1.0` | 音量（0.0–1.0） |
| `enabled` | `true` | 总开关 |
| `desktop_notifications` | `true` | 任务完成时显示系统通知 |
| `categories` | `task.complete` + `task.error` 开，其余关 | 各事件的声音与弹窗开关（见功能表） |
| `tool_error_sounds` | `false` | 单个工具调用失败：开启时响铃+弹窗，关闭时完全静默 |
| `silent_window_seconds` | `0` | 对短于 N 秒的任务抑制 `task.complete` |
| `annoyed_threshold` | `3` | 触发“快速提问”音效的连续提问次数 |
| `annoyed_window_seconds` | `10` | 快速提问检测时间窗口 |
| `relay_mode` | `"auto"` | 中继模式：`"auto"`、`"local"` 或 `"relay"` |
| `playback_wait_seconds` | `2` | `Play()` 之后 PowerShell 播放进程存活秒数 |

旧配置中的 `active_pack` 会在加载时自动迁移为 `default_pack`。若存在 `~/.claude/hooks/peon-ping/packs`（Claude Code），也会自动读取其中的音效包。

## 远程开发

插件自动检测 SSH 会话、devcontainer 与 Codespaces，并通过本机运行的 peon-ping 中继转发音频（参见 [peon-ping 远程开发文档](https://github.com/PeonPing/peon-ping#remote-development-ssh--devcontainers--codespaces)）。用 `/peon relay` 配置。

## 开发

仓库完全自包含：所有类型声明来自 npm devDependencies（`tsconfig.json` 中没有 vendored 或机器相关的路径）。

```bash
npm install
npm test              # 运行测试
npm run typecheck     # 类型检查
npm run build         # 构建 lib/（宿主端）
npm run build:client  # 构建 lib/client.js（浏览器端）
npm run publish:dry-run  # 检查 npm 包内容
```

## 许可证

MIT。原插件版权归 [joshuadavidthomas](https://github.com/joshuadavidthomas)（pi-peon-ping）与 [cppgohan](https://github.com/Gohan)（pi-peon-ping-win，原生 Windows 支持）。
