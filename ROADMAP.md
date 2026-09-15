# Harness 缺口补齐路线图（0.40.0 起）

> 创建于 2026-09-14。背景：对照 pi CLI / Claude Code / Cursor 盘点出 5 项缺口，按价值排序推进。
> 数据源：会话「UI 设计系统改造 → harness 缺口盘点」。

## 总览

| # | 项目 | 状态 | 备注 |
|---|------|------|------|
| 1 | 联网检索（webfetch/websearch） | ✅ 已发布 0.40.0 | e2e-p47 8/8 |
| 4 | 用量/成本面板 | ✅ 已发布 0.40.0 | 与 1 同批 |
| 2 | auto-compact（长会话自动压缩） | ✅ 已发布 0.41.0 | **SDK 默认已开**（threshold+overflow 双路）；补设置页开关 + pending 缓存 |
| 3 | 子代理（agent-as-tool） | ✅ 已发布 0.41.0 | subagent 工具：inMemory 独立上下文 + 只读白名单 + 并发锁 + 8min 超时；e2e-p49 7/7 |
| 5 | Hooks（工具调用前后钩子） | ✅ 已发布 0.41.0 | ~/.pi/agent/hooks.json（before 可 block）；设置页示例创建；e2e-p49 覆盖 after 副作用 |
| 6 | 内置浏览器控制（P52，追加） | ✅ 已发布 0.42.0 | CDP 受控 Chromium + ref 标注；10 工具；写类操作审批确认；e2e-p52 7/7 |
| 7 | git 检查点（P53，追加） | ✅ 已发布 0.43.0 | 写前自动快照（独立 ref 不污染历史）+ git_status/git_diff/git_rollback；改动可自证可撤销；e2e-p53 8/8 |

| 8 | 验证闭环 + 项目记忆（P54/P55，追加） | ✅ 已发布 0.44.0 | 改码自证约定 + hooks 验证模板；MEMORY.md 跨会话注入 |
| 9 | 电脑操作（P56，追加） | ✅ 已发布 0.45.0 | 截图/点/输/键/列窗口/激活；写类审批 + 审计日志；e2e-p56 6/6 |

## 后续池（用户提过/可选，未排期）

- **Blender MCP 实测**：blender-mcp 需先装 Blender 本体；uvx 已有（hermes/bin）；用户说后面再弄
- **公网发布**：用户拍板「会做，先等等」——GitHub Releases 路线半天工作量（provider 或自建）；备选 VPS ¥10-30/月
- **真机验证 0.42.0**：浏览器控制在用户真机跑一轮（找 Chrome/Edge、弹审批、截图）

## 已完成项的实现要点（防遗忘）

### 1. 联网检索
- `src/main/web-tools.mjs`：webfetch + websearch，经 `createAgentSession({ customTools })` 注入（agent-host.mjs），SDK 零改动
- webfetch：HTML 剥标签转纯文本、截断 2 万字符；SSRF 拦截内网/环回/169.254 元数据（按 hostname 字符串；**未做 DNS 二次校验**，诚实边界）
- websearch：Tavily（key 在 设置→联网检索，存 `~/.pi/agent/openpi-settings.json`，worker 启动时读 + `reloadSettings()` 即时生效）→ 无 key 兜底 DDG（被墙报错引导，**故意不加 Bing**：实测返回风控垃圾，静默给错比报错糟）
- worker 设置注入：agent-worker.mjs 顶部读 settings → `setWebSettings()`
- 测试后门：`OPENPI_TAVILY_BASE` 环境变量指向 mock（e2e 用）
- 渲染层：设置页 `#web-card`（Tavily key 输入 + 保存）

### 4. 用量/成本面板
- 数据源：message_end 事件 `msg.usage`（pi-ai 内置价格表算好 `usage.cost.total`）+ `AgentHost.getUsage()` 从会话树聚合全部 assistant 消息（含历史轮）
- 渲染层：`state.usageTotal` 加 `cost` 字段；状态栏 `#usage` 显示 `$x.xx`（cost>0.0005 才显示）；hover title 明细
- 恢复会话回填：resumeSession 后调 `window.openpi.getUsage()`
- 诚实边界：模型单价不在价格表 → 不显示 $，只显示 token

### 测试
- `scripts/e2e-p47.mjs`（PORT 9347）：mock LLM（openai-completions SSE 带 tool_calls 流式）+ mock Tavily，全离线确定性，8 断言
- 已注册 `e2e-all.mjs`（现 **22 套**）
- 回归绿：p43/p45/p35/p30/office/p40（p30 首跑 FAIL 为真模型抖动，重试即绿）

## 0.40.0 发布收尾清单（下次开工第一件事）

- [x] `package.json` version → **0.40.0**（2026-09-14 完成）
- [x] `node scripts/dist.mjs --fast` → `node scripts/publish.mjs`（更新源自检通过 v0.40.0；发布源 server.bat 手动重启过一次）
- [x] CHANGELOG.md 加 0.40.0 段（联网检索 + 用量面板）
- [x] PROGRESS.md 加 P47+P48 段；AGENTS.md 快照更新（22 套 e2e，踩坑至 #98）
- [ ] e2e-p47 的 FAIL 自动重试机制已验证有效，无需处理

## 后续批次的设计备忘

### 2. auto-compact（下一个动手的）
- 目标：上下文用到 ~85% 自动触发摘要压缩，长任务不中断
- 红线：pi SDK 零改动。先查 SDK 是否暴露 `compact()` / compaction 事件（`agent-session.d.ts` 里见过 `tokensBefore`/`createCompactionSummaryMessage`，SDK 侧有压缩能力，桌面端可能只需「监听用量+调 compact」）
- UI：压缩时状态栏提示「正在压缩上下文…」，压缩后 sys-line 记录

### 3. 子代理
- 形态：主 agent 通过工具派生子任务（探索/调研类），子代理独立上下文，结果摘要回主会话
- 地基：P43 utilityProcess 架构；子代理可复用 AgentHost 轻量实例
- 风险：并发模型实例的费用；需要并发上限

### 5. Hooks
- 形态：`~/.pi/agent/hooks/` 下声明式钩子（工具名匹配 + 前置/后置 + 命令）
- 触发场景：写文件前自动 lint、bash 后自动记录
- 优先级低：单人使用感知不强，公网发布前做

## 待办事项（下次接力从这里挑）

- **公网发布**：用户已拍板「会做，先等等」（2026-09-15）。倾向 GitHub Releases 路线（半天工作量：建仓库 + 改 publish.mjs 下载地址指向 + 完整更新链路验证一次）；备选公网 VPS/对象存储（¥10-30/月，国内快）
- 用户真机验证：0.41.0 的 subagent / Hooks / 自动压缩开关体感

## 相关历史决策（避免踩重复坑）

- SDK 零改动：所有能力经 `customTools` / 扩展工厂 / RPC 注入
- 真模型 e2e 抖动：FAIL 先重跑一次再定性（p30/p35/p38 都出现过）
- `#ensure()` 无返回值——调用它拿 session 要分开写：`this.#ensure(); this.session.xxx`
- Bing 抓取废弃记录在 web-tools.mjs 注释里，别再试
