# P53–P56 规划：补齐 Harness 短板（2026-09-15）

> 来源：八项能力审计。结论：#1 Loop / #3 上下文 / #6 子代理 / #7 Skill 已强；
> #2 电脑操作中「OS 级 computer-use」与「IDE 分析」缺；#4 记忆弱；#5 Checkpoint 无；#8 自我验证最弱。

## P53 git 基建 + Checkpoint（~1 天）⬅ 当前
**目标**：让「改好了」变成「改好了，这是 diff，可回滚」。

- [ ] P53a OpenPi 项目自身 `git init` + `.gitignore`（node_modules/dist/e2e 产物）+ 基线提交
- [ ] P53b 产品能力：工作区 checkpoint
  - 会话启动检测工作区是否 git 仓库；不是则提示可初始化
  - Agent 修改文件前自动 `git add -A && git commit`（checkpoint 快照，`--no-verify` 跳钩子）
  - 新增只读工具 `git_diff`（checkpoint 对照）+ `git_rollback`（写类，走审批）
  - UI：工具栏显示「已建 N 个检查点」，点击看最近 diff
- [ ] 验收：e2e 新套件（改文件 → diff 有内容 → rollback 还原 → 内容一致）
- 坑位预案：#90 taskkill //PID；git 在系统 PATH（#93 尾部追加规则，不抢）

## P54 验证闭环（~半天）
**目标**：会话收尾前强制自证。
- [ ] 系统提示词注入约定：改动代码后必须跑测试/构建并贴证据，跑不了要说明原因
- [ ] hooks.json 默认模板（P51 基建）：写类工具后自动 lint（可开关，默认关）
- [ ] 验收：mock LLM 场景断言「改码后发起了测试命令」

## P55 项目记忆（~半天）
**目标**：跨会话记住项目约定/决策。
- [ ] 只读+写两类 memory 工具（存 `<workspace>/.openpi/MEMORY.md`）
- [ ] 会话启动注入 MEMORY.md 摘要（超长则截断头部+目录）
- [ ] UI 不加面板，Agent 自主维护
- [ ] 验收：会话 A 写记忆 → 会话 B 能答出

## P56 OS 级 computer-use（大，~2–3 天）
**目标**：启动应用 → 操作 UI → 截图 → 读日志。
- [ ] screenshot（全屏/窗口）、click、type、key、list_windows（PowerShell + UIA，复用 pi-driver 思路）
- [ ] 写类操作走审批（同 P52 模式）
- [ ] 子代理不带（同 P52 决策）；审计日志全量落盘
- [ ] 验收：自动打开记事本 → 输入文字 → 截图断言 → 关闭

## 不做（本轮）
- LSP/IDE 深度分析（成本高，读文件+grep 已够中小仓库）
- 浏览器 console 读取（并入 P56 或后续小版本）

## 发布节奏
P53a+P53b → 0.43.0（dist --fast + 真机验证）；P54/P55 → 0.44.0；P56 → 0.45.0
