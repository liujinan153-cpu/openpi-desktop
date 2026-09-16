# PLAN P62–P64：编程能力 + 工作流增强（对标 PI-Desktop）

> 2026-09-15 制定。背景：0.50.1 完成生图/贴图/电脑控制后，与 PI-Desktop 对比的差距集中在
> 「编码工作区深度」与「工作流模式」。8 条增强分三批落地，原则：pi SDK 零改动、工具注入路线、
> 每批独立可发布、e2e 全量过门槛。

## 总览

| 批次 | 条目 | 来源 |
|---|---|---|
| **P62（0.51.0）** | ① repo map 自动注入 ② ast-grep 结构化编辑 ③ 测试自动跑 | 编程 5 条中的三个轻量项 |
| **P63（0.52.0）** | ④ LSP 实时诊断 ⑤ Goal 模式 | 编程最重一项 + 工作流 |
| **P64（0.53.0）** | ⑥ 并行 worker（Session Orchestrator）⑦ 多角色并行（coder/tester/reviewer）⑧ 会话导入 | 工作流三件套（⑥是⑦的前置） |

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

### ⑥ 并行 worker（Session Orchestrator 取经）
- 子代理升级为可观察的持久 worker：spawn/查询/等待/接受报告/取消；每 worker 独立会话文件可回看
- 上限护栏（如每父 4 个、全局 16 个）；权限继承父会话

### ⑦ 多角色并行（依赖⑥）
- 预设三角色编排：coder 改码 / tester 跑验证 / reviewer 对抗审查，结论互相咬合
- 本质是 ⑥ + 角色系统提示模板 + 编排工具

### ⑧ 会话导入（截流竞品用户）
- 读 Claude Code / Codex / OpenCode / 官方 pi 的本地会话格式（JSONL 逆向），转成 OpenPi 会话列表展示（只读回看起步，可续聊为进阶）
- 难点：各家格式差异 + 内容映射（tool_use/image part）

## 发布纪律
- 每批独立版本 + fast 发布；**每两批跑一次 e2e-all 全量**（#114 教训）
- e2e 新套件随批交付，纳入 e2e-all 清单
