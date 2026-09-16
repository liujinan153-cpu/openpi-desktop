# PLAN P62–P64：编程能力 + 工作流增强（对标 PI-Desktop）

> 2026-09-15 制定。背景：0.50.1 完成生图/贴图/电脑控制后，与 PI-Desktop 对比的差距集中在
> 「编码工作区深度」与「工作流模式」。8 条增强分三批落地，原则：pi SDK 零改动、工具注入路线、
> 每批独立可发布、e2e 全量过门槛。

## 总览

| 批次 | 条目 | 来源 |
|---|---|---|
| **P62（0.51.0）** | ① repo map 自动注入 ② ast-grep 结构化编辑 ③ 测试自动跑 | 编程 5 条中的三个轻量项 |
| **P63（0.52.0）** | ④ LSP 实时诊断 ⑤ Goal 模式 | 编程最重一项 + 工作流 |
| **P64（0.53.0）✅ 已发布** | ⑥ 并行 worker（Session Orchestrator）⑦ 多角色并行（coder/tester/reviewer/explore）⑧ 会话导入（Claude Code） | 工作流三件套（⑥是⑦的前置） |

---

## P62：轻量三件套（全部工具注入，无 UI 大改）

### ① repo map 自动注入（Aider 取经）
- **做什么**：会话启动时生成工作区地图（目录树 ≤3 层、gitignore 感知、≤200 条 + code_symbols 提取的关键符号清单），经 systemPrompt 扩展注入
- **价值**：5.3flash 在大仓库不迷路——弱模型边际收益最大的一项
- **实现**：`repo-map.mjs` 导出 `repoMapSystemPrompt(cwd)`；agent-host 的 before_agent_start 链挂载（与 memory/checkpoint 同构）；带 mtime 缓存避免每次全扫
- **e2e**：新套件 e2e-p62（断言系统提示含目录树、超大仓库被截断、gitignore 生效）

### ② ast-grep 结构化编辑
- **做什么**：新工具 `ast_edit`（pattern → rewrite，语法树替换，天然不错配引号/缩进）——#100 家族的根治
- **实现**：ast-grep 单二进制 `sg.exe` 进 extraResources（下载 release 或 npm @ast-grep/cli 落 bin）；工具层校验匹配数（0 处/多处报错要求加上下文，绝不静默）
- **降级**：二进制缺失时工具返回明确提示（让 AI 用 edit）
- **e2e**：e2e-p62 内含（JS/TS 各一例：函数重命名 + JSX 属性改写）

### ③ 测试自动跑
- **做什么**：新工具 `run_tests`——探测测试命令（package.json scripts.test / pytest / cargo test / go test）→ 支持 `--only <文件>` 只跑受影响测试 → 失败输出截断回喂
- **约定升级**：P54 的「改码自证」系统提示里明确「改代码后优先 run_tests 而不是 code_diag」
- **e2e**：e2e-p62 内含（npm 项目跑 vitest/占位脚本 + pytest 项目）

## P63：LSP + Goal 模式

### ④ LSP 实时诊断（最大杠杆）
- tsserver（JS/TS）+ pyright（Python）按需起停，新工具 `lsp_diag`（文件→诊断数组含行列/严重度/快速修复提示）
- 与 code_diag 合流：code_diag 保留轻量语法检查，lsp_diag 是语义级
- 难点：server 进程生命周期管理、多语言探测、启动延迟（懒启动 + 首次调用预热）

### ⑤ Goal 模式（PI-Desktop 取经）
- 审批档位加第四档 goal：用户锁「目标 + 验收标准」，agent 自主迭代到验收通过
- 复用 plan 模式机制（before_agent_start 注入 + 专属系统提示）；验收判据不满足时禁停（软约束：提示注入）
- UI：档位选择器加一项

## P64：并行工作流三件套

### ⑥⑦ 实施记录（完成于 0.53.0）
- **形态与计划不同**：#117 实锤 tool execute 内 await 子 LLM 流必卡死主会话（Promise.all 包装即触发）——放弃「spawn/查询/等待」手动收结果，改为 **batch 派发 + 后台跑 + 完成后 prompt(streamingBehavior:"followUp") 自动回喂**；每 worker 独立 inMemory 会话（零文件残留）；护栏每父 4
- **角色**：explore（只读基座）/ coder（+write/edit/run_cmd）/ tester（+run_cmd）/ reviewer（无额外），各带角色前缀提示；readonly 档降级纯只读
- **run_cmd**：内置 bash 不能给 worker 会话（激活即卡死）——自定义 execFileSync/shell 工具，RISKY 正则拒绝危险命令

### ⑧ 实施记录（完成于 0.53.0）
- Claude Code（~/.claude/projects）起步，官方 pi 同源零成本；Codex/OpenCode 检测留后续
- session-import.mjs：解析→转 pi 原生格式落盘 sessions/<slug>--imported/，listSessions 天然可见；幂等（同源文件 hash）
- UI：侧栏 tab 条导入按钮；隔离：PI_HOME（源）+ OPENPI_SESSIONS_ROOT（落盘）

## 发布纪律
- 每批独立版本 + fast 发布；**每两批跑一次 e2e-all 全量**（#114 教训）
- e2e 新套件随批交付，纳入 e2e-all 清单
