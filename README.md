# OpenPi Desktop

基于 [Pi coding agent](https://pi.dev) SDK 的 Windows 桌面 AI Agent。**不修改 Pi 源码**，集成会话、终端、Git、浏览器/电脑操作、MCP、并行 worker 与办公技能。

> 当前为公开 Beta。安装包尚未购买 Windows 商业代码签名证书，首次安装可能出现 SmartScreen「未知发布者」提示；请只从本项目 GitHub Releases 下载并核对版本。

## 下载与更新

- 下载：<https://github.com/liujinan153-cpu/openpi-desktop/releases>
- 更新：应用内 **设置 → 检查更新**，默认使用上述 GitHub Releases；`~/.pi/agent/updater.json` 可覆盖为自建 generic/GitHub 源。
- 支持 Windows 10/11 x64，提供 NSIS 安装版与便携版。

## 开发与构建

```bash
npm install          # 安装依赖
npm run start        # 开发模式启动
npm run test:ci      # 无付费模型的语法检查 + 单元测试
npm run e2e:mock     # 本地 mock E2E（不调用真实模型）
npm run dist         # 全量 E2E 门槛 + Windows 安装版/便携版 → dist/
npm run smoke:package # 检查打包依赖、更新清单与运行时
npm run licenses:audit # 生成/校验第三方许可证清单
```

> 在 pi Desktop / 其他 Electron 宿主的终端里启动时，需先 `unset ELECTRON_RUN_AS_NODE`，否则 electron.exe 会以纯 Node 模式运行。

## 功能（M0 + M1 已验证）

**对话核心**

- ✅ Electron 壳 + Pi SDK 内嵌（`createAgentSession` + `ModelRuntime`）
- ✅ 流式对话：文本 delta、思考块（折叠）、工具卡（bash 输出实时滚动、错误标红）
- ✅ steer 插话 / 中断 / 新会话 / 思考等级切换（off → xhigh）
- ✅ Token 用量实时统计（in / cache / out）——pi 的压缩与缓存机制可观测
- ✅ Markdown 渲染 + 代码高亮（marked + DOMPurify + highlight.js，全本地化，CSP 限 'self'）
- ✅ edit 工具彩色 Diff 视图；write/read/bash 工具卡

**会话**

- ✅ 会话列表侧栏（扫 pi 原生 sessions 目录：预览/工作区/相对时间）
- ✅ 点击恢复历史会话 + 消息回放；会话文件与 pi CLI/Desktop 双向互通

**模型与供应商（配置中心 ⚙）**

- ✅ L1 API 密钥：写入 `auth.json`（0600，支持 `$ENV` 引用），密钥打码展示
- ✅ L2 自定义供应商：表单 → `models.json`（4 种 API 协议 / compat 兼容开关 / 一键测连通）
- ✅ L4 本地模型：Ollama / LM Studio / vLLM / llama.cpp 预设卡，自动拉取已装模型列表
- ✅ 配置即契约：只写 Pi 标准文件（写前自动备份 .bak），↻ 重载模型目录即时生效，与 CLI 双向兼容

**M2：安全与上下文管理**

- ✅ 危险命令审批：内联扩展拦截高风险 bash（rm -rf / format / mkfs / curl\|sh 等），图形弹窗确认，拒绝则阻断回传
- ✅ 会话树面板：可视化分支结构，点击节点 `navigateTree` 切换分支并重放历史
- ✅ 上下文进度条：占用/窗口比例实时显示，<70% 绿 / <90% 黄 / ≥90% 红
- ✅ 手动压缩：一键 `compact()` 生成摘要释放窗口
- ✅ HTML 导出：完整会话导出至下载目录并自动定位文件
- ✅ 会话改名（写入 pi 原生 session_info，CLI 可见）

**M3：多窗口并行（对标超越）**

- ✅ 多窗口并行会话：⧉ 每窗口独立 AgentHost / 会话 / 工作区 / 模型，IPC 按 webContents.id 路由，关窗即释放
- ✅ 会话树导航：点击分支节点重放历史，导航到用户消息时消息撤回输入框可编辑重发
- ✅ 内核版本检查：设置页一键对比 npm 最新版，提示升级路径
- ⏳ 后续增强：RPC 子进程池（进程隔离）、模型市场、自动更新（Linux/macOS 包按需求取消，仅出 Windows 包）

**M4：UI 全面升级（对标 Codex 设计语言）**

- ✅ Composer 浮动卡片：上下文胶囊（工作区/分支/审批）+ 模型选择内嵌输入卡，圆形发送钮
- ✅ 亮/暗双主题一键切换（设计令牌系统，记忆偏好）
- ✅ 欢迎屏「今天想做点什么？」+ 示例任务一键填入
- ✅ 侧栏渐变新对话按钮、消息头像与时间戳、模态动画、自定义滚动条等全套细节

**M5：实时预览 + 会话管理**

- ✅ 右侧实时预览面板：自动探测本地服务、刷新/外开/设备尺寸切换
- ✅ 会话右键菜单：重命名 / 置顶 / 删除（回收站）
- ✅ 顶部会话标题 tab、侧栏「项目/分组」双视图

**M4.2：侧栏信息架构 + zcode 折叠条**

- ✅ 侧栏「项目 / 最近」双区（Codex 同款）：项目按工作区聚合、可折叠、项目内一键新会话、搜索过滤
- ✅ zcode 风「⚙ 已工作 N 秒 · M 次工具调用 ›」折叠条，消息流清爽不噪音
- ✅ 空轮次清理、用户消息轻胶囊、Ctrl+N/K 快捷键

**M3.5：对标 Codex 补强**

- ✅ 审批模式四档（只读 / 自动编辑 / 全自动 / 计划模式）——对标 Codex suggest/auto-edit/full-auto，顶栏一键切换
- ✅ Git 面板：分支 / 变更着色 / 展开 diff / 最近提交 / 一键 commit（不烧会话上下文）
- ✅ 图片输入：粘贴或拖拽随消息发送（steer 亦支持），本地截图直接发给 Agent
- ✅ 工具卡输出渲染修复（content blocks 递归提取）

**P 系列：对标深化与产品化（v0.14 → v0.26）**

*电脑控制与办公*

- ✅ 电脑控制（v0.14-0.19.1）：12 个 computer_* 工具（截图/点击/拖拽/打字/键盘/滚动/窗口管理/剪贴板），UIA 元素定位优先 + 截图回读验证，随包自带 PS 守护进程
- ✅ 内置办公技能（v0.21/0.32）：docx/pdf/pptx/xlsx 四技能随软件自带，启动自动部署，删除不复活、修复可重装；**内置 Python 运行时（v0.32），安装即用零依赖**
- ✅ skill-creator 技能（v0.21.1）：教你写自己的技能（本土化 pi 语境）

*上下文与效率*

- ✅ 上下文自动接力（v0.20）：占用过 80% 自动压缩出交接摘要开新会话，弹窗确认；会话标题带「· 接力N」链
- ✅ @ 文件引用补全（v0.23）：输入 @ 弹工作区文件菜单（git ls-files / 目录遍历兑底，60s 缓存）
- ✅ 系统通知（v0.22）：窗口最小化时 Agent 完成弹系统通知，点击聚焦；AGENTS.md/CLAUDE.md 清单面板 + 一键让 Agent 生成（v0.22）

*安全与可回滚*

- ✅ 文件快照回滚 checkpoint（v0.23）：AI 改文件前自动快照，审核面板 ⏪ 一键恢复到 AI 首次修改前（多轮编辑全撤）
- ✅ Git 分支保护（v0.23）：🌿 一键切到 openpi/agent-* 保护分支，改完 ⇥ 合并回 main（--no-ff）
- ✅ full-auto 护栏（v0.25）：20 条危险命令正则在全自动档也强制确认且不记忆
- ✅ 安全审计日志（v0.25）：非只读工具调用全落 ~/.pi/agent/audit/（按日 JSONL），设置页一键打开

*MCP 与并行*

- ✅ MCP 桥（v0.24）：接 ~/.pi/agent/mcp.json（对齐 Claude Desktop 格式），stdio / streamable HTTP，工具自动注册为 mcp__<server>__<tool>；设置页状态卡 + 重连
- ✅ 后台并行任务（v0.26）：⚡ 任务面板发起，最多 3 个并发，与主会话互不阻塞；会话独立目录不污染列表；完成弹通知

*质量门与打磨*

- ✅ 自动更新器（v0.28）：electron-updater，更新源运行时可配（GitHub / 任意 HTTP 目录，~/.pi/agent/updater.json）；检查/下载（带进度）/重启安装
- ✅ diff 块级 accept/reject（v0.28/0.29）：按改动块（hunk）渲染，可单块撤销、单块采纳暂存；智能提交：index 有采纳内容时只提交这些块
- ✅ 跨会话消息搜索（v0.29）：侧栏搜全部历史会话的消息内容，命中带片段可直接恢复
- ✅ Claude Code 取经三部曲（v0.30/0.31）：TodoWrite 任务清单（AI 多步任务实时勾选）/ Plan Mode 计划模式（结构化计划卡，批准后执行）/ # 快捷记忆（# 开头固化进 AGENTS.md，空 # 管理记忆）
- ✅ 打包质量门（v0.27）：npm run dist 前强制跑全量 E2E 回归（11 套 141 断言），失败禁止出包

## 安全与许可证

- OpenPi 是高权限本地 Agent。处理陌生项目时优先使用「只读」或「自动编辑」，谨慎启用「全自动」。
- 会话和配置保存在 `~/.pi/agent/`；Pi 兼容的 API key 默认存于本地 `auth.json`，分享日志前请脱敏。
- 安全报告方式和信任边界见 [`SECURITY.md`](SECURITY.md)。
- OpenPi 源码采用 AGPL-3.0-only；捆绑技能/依赖保留各自许可证。部分 Z.ai 办公技能仅允许个人、教育、非商业使用，详见 [`NOTICE.md`](NOTICE.md)。

## 已知限制

- 后台任务列表存内存：应用重启后任务记录清空（会话文件保留在 ~/.pi/agent/sessions-tasks/，可手动回溯）
- MCP 重连后需新会话才能拿到新增工具（会话启动时注册）
- 仅出 Windows 包（安装版 + 便携版）

## 结构

```
src/
├── lib.js                # 工具函数库（mul：两数相乘，`import { mul } from './lib.js'`）
├── main/
│   ├── main.mjs          # Electron 入口 + IPC 路由
│   ├── agent-host.mjs    # Pi SDK 封装（会话生命周期 + 事件转发 + 模型目录重载）
│   ├── config-store.mjs  # 配置中心（auth.json/models.json 读写 + 连通测试）
│   └── preload.cjs       # contextBridge（渲染进程隔离）
├── renderer/
│   ├── index.html / style.css / app.js   # 聊天 UI + 会话侧栏 + 设置模态框
scripts/
├── poc-node.mjs      # 无头 SDK 验证
└── e2e*.mjs          # CDP 驱动 E2E（开发/打包版均可）
```

## 模型配置（全部零代码）

| 方式 | 位置 |
|---|---|
| API Key（30+ 内置供应商） | 应用内 ⚙ → API 密钥，或 `~/.pi/agent/auth.json`，或环境变量 |
| 自定义供应商 | 应用内 ⚙ → 自定义供应商表单（测连通/拉模型列表） |
| 本地模型（Ollama、LM Studio、vLLM、llama.cpp） | 应用内 ⚙ → 本地模型预设卡，一键接入 |
| 订阅登录（ChatGPT/Claude Pro/Copilot…） | pi 的 `/login`（写入 auth.json 自动刷新） |

所有配置最终落在 Pi 标准文件 `auth.json` / `models.json`，CLI 与桌面端双向兼容。
