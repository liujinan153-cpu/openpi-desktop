# OpenPi Desktop

桌面 AI Agent —— 基于 [pi coding agent](https://github.com/badlogic/pi-mono) SDK 的 Electron 应用。会话、终端、Git、浏览器控制、电脑操作、办公技能（docx/xlsx/pptx/pdf）一体化，自带自动更新。

## 下载

到 [Releases](https://github.com/liujinan153-cpu/openpi-desktop/releases) 下载最新的 `OpenPi Desktop Setup x.y.z.exe` 安装。

## 自动更新

应用内置更新器：**设置 → 检查更新**，检测到新版本后一键下载、重启即装。更新清单与安装包都发布在本仓库 Releases。

## 功能一览

- 多窗口并行会话，树状对话导航，会话导入（Claude Code / Codex / OpenCode）
- 审批三档（只读 / 自动编辑 / 全自动），写操作前 Git 自动快照、一键回滚
- 联网检索（Tavily / DDG）、MCP 桥、子代理、Hooks
- 浏览器控制（CDP 受控 Chromium）、电脑操作（截图/点击/输入）
- 办公技能：Word / Excel / PPT / PDF 生成（内置 Python 运行时，开箱即用）
- 用量成本统计、minimap 对话轨道、亮暗主题

## 平台

Windows 10/11 x64（NSIS 安装包 + 便携版）。
