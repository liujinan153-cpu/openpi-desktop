# OpenPi Desktop —— 实施进度

> 方案总纲见 `E:/pi2/PI_DESKTOP_PLAN.md`

## P64：并行工作流三件套 ✅（2026-09-16，随 0.53.0 发布）

### ⑥⑦ 并行 worker + 多角色
- **#117（本轮最大坑，三层坑）**：
  1. **tool execute 内 await 子 LLM 流必卡死主会话**——tool result 后主会话不再回喂（第二轮 LLM 请求永不到 mock）。对照实验实锤：同工具同参数，**直接 await 通 / `Promise.all([p])` 挂**——SDK 轮转对 microtask 时序敏感，多一层 then 就翻转。绕开：**后台跑 + worker 完成后 `session.prompt(结论, {streamingBehavior:"followUp"})` 自动回喂**——结论作为 user 消息注入，AI 派发后可先干别的，无需轮询
  2. **followUp 队列不自唤醒**：`followUpQueue.drain()` 只在 agent loop 收尾时消费，loop 已退出则入队无人消费；并发 prompt 撞重入保护（"Agent is already processing"）时错误消息明示解法——**始终带 `{streamingBehavior:"followUp"}`**
  3. **内置 bash 不能给 worker 会话**（tools 白名单含 "bash" 激活即卡死主会话）——自定义 **run_cmd** 替代（execFileSync shell:true；RISKY 正则拒绝；spawnSync 拿全 stdout/stderr——execFileSync 异常对象经 SDK 序列化后 message/stdout 全空，诊断无门）
- **形态**：`subagent({batch:[{prompt,task,role}]})` 一次派多（每父上限 4），立即返回派发确认；WORKER_ROLES 四角色（explore/coder/tester/reviewer）各带 extraTools 白名单+角色前缀；readonly 档降级纯只读（权限继承父会话）；worker 会话 inMemory 零残留、同 agentDir/modelRuntime（#99）
- e2e-p64 6/6：mock 按 worker 角色前缀路由（tester run_cmd 写盘铁证 + explore read），断言 followUp 注入的结论含双方输出+role 标注

### ⑧ 会话导入
- **session-import.mjs**：Claude Code（~/.claude/projects/*.jsonl）→ 解析（text 对话为主，isMeta/tool_use/thinking/坏行滤）→ 转 pi 原生格式落 `sessions/<slug>--imported/` → listSessions 天然可见；**幂等**（目标文件名含源路径 hash，二次导入 skipped）；首行 head 带 openpiImported 标记
- **UI**：侧栏 tab 条「⬇」按钮 → detectImportSources 探测 → miniConfirm → 导入 → sysline 统计 → 列表/回看/搜索全通
- **e2e 隔离坑**：USERPROFILE 覆写会让 **Electron 静默死**（无输出无 CDP）——用 **PI_HOME**（源 ~/.claude）+ **OPENPI_SESSIONS_ROOT**（落盘根，main.mjs 早有此 env）双 env 隔离，零污染真实 HOME
- e2e-p64b 6/6（连跑 2 次绿）+ unit-p64b 4 断言（探测/解析过滤/幂等/落盘格式）

## P38.7：办公技能一劳永逸（去安装化）✅（2026-09-14，随 0.34.2 发布）

## P52：内置浏览器控制 ✅（2026-09-15，随 0.42.0 发布）

用户：「不仅要做，而且要做好」。CDP 路线（chrome-remote-interface 已有依赖）+ 受控独立 profile 实例，SDK 零改动（customTools 注入）：

- **browser-tools.mjs（10 工具）**：browser_open / snapshot / click / type / select / press / scroll / tabs / screenshot / wait；懒启动受控 Chromium（自动探测本机 Chrome/Edge 五路径，`--remote-debugging-port=0` 从 stderr 解析 ws 端口），独立 profile `~/.pi/agent/browser-profile/` 不污染日常浏览器；元素用 `data-openpi-ref` 标注代替坐标猜测；快照截断 SNAPSHOT_MAX 12000；`Page.javascriptDialogOpening` 自动接受防卡死；进程退出自动清状态下次重启（崩溃自愈）
- **审批分类**：browser_open/snapshot/screenshot/wait/scroll 只读全档位直通（browser_tabs 含 switch/close 归写类）；click/type/select/press 写类在 readonly/auto-edit 弹确认、full-auto 直通+审计；子代理不带浏览器工具（单实例防冲突）；webfetch/websearch 补进 READ_ONLY_TOOLS（P47 时 full-auto 档没暴露的 auto-edit 拦截问题）
- **坐坑 #101**：`CRI({target: id})` 必须带 `port`，否则内部静默回落 9222 → ECONNREFUSED；CRI 域对象无 `.off`，解绑事件用 `client.removeAllListeners("Page.loadEventFired")`
- **坐坑 #102（e2e 三重假雷，差点冤枉产品）**：调试中「审批弹窗被拒/不弹」反复摇摆，深挖后确认产品审批链路本身通畅（打点实测 ui_request→弹窗→uiRespond→resolveUi 命中=true→confirm=true 秒级闭环；proxy 通用 RPC 本就转发 resolveUi）。三重坑全在 e2e 侧：① 渲染层 sendText() await prompt RPC 不 settle，而 CDP Runtime.evaluate 即使不写 awaitPromise 也会等返回值 promise settle → e2e 被卡死 5 分钟 → 弹窗早已出现却被 worker 侧 5min 超时拆掉 → 迟到的点击命中=false；② lastText 未等新一轮流式就开始查旧气泡，agent 快时抓到上一轮 END52 消息；③ stderr/stdout 双流重定向行序不可靠，打点必须带时间戳。修复=e2e 侧 sendText 改同步 IIFE fire-and-forget + lastText 先等流式开始再等结束；顺带保留 worker stderr 转发作排障基建
- **坐坑 #103**：断言媒介被渲染层 HTML 转义污染——快照里 `<input type=text>` 被气泡 innerHTML 解析吃掉，textContent 拿不到字面量；断言只锚定转义安全的文本/格式
- **P53 git 检查点（0.43.0）**：git-checkpoint.mjs——commit-tree 构造独立提交链挂 refs/openpi/checkpoints（不动 HEAD 不污染历史）；approvalExtension 放行点前 autoCheckpointIfNeeded（30s 节流）；工具 git_status/git_diff（只读直通）+ git_rollback（走通用审批）；**cwd 必须经 setGitWorkspace 注入**（ctx.cwd 实测=进程 cwd，坐坑 #105：boot() 硬编码 startSession(null) 任务模式，e2e 需 ev 驱动 startSession(workspace)）；干净仓库也建基线快照（首写可撤销）；回归 p52 7/7（间歇失败=受控浏览器残留，杀进程+清 lock 后重跑即绿）
- **坐坑 #104**：chrome-remote-interface 误放 devDependencies——打包不进 asar，源码/e2e 全绿但真机浏览器工具报 Cannot find package；0.42.1 修复（移入 dependencies，asar 验证 36 项打包）；真机 0.42.1 验证 browser_open 成功（Example Domain 标题+正文）
- **e2e-p52**（PORT 9352，LLM 9492，SITE 9530，7 断言）：open 快照含标题+ref → type 审批弹窗+提交成功 → tabs 审批+列表 → webfetch 回归；approveBrowserWrite 轮询=独立短 evaluate 循环（渲染层响应性~1ms/次）；注册 e2e-all 现 **24 套**；打点移除后复跑全绿

## P49-P51：auto-compact 开关 + 子代理 + Hooks ✅（2026-09-15，随 0.41.0 发布）

Harness 缺口五项全部完成：

- **P49 auto-compact**：调研发现 SDK 默认已开（threshold+overflow 双路自动压缩，`compaction.enabled ?? true`），桌面端早有事件提示 + 手动🗜；真正缺的只是开关：设置页「上下文管理」卡 + `setCompactionEnabled`（持久化）；无会话时开关值存 pending，#ensure() 后补写（getAutoCompact 无会话返默认 true，不抛错）
- **P50 subagent**：agent-host 内 `buildSubagentTool(host)` → `runSubagent()`：`SessionManager.inMemory` 独立上下文（零文件残留）+ 只读工具白名单 `tools:["read","grep","find","ls"]`（不绕审批）+ 并发锁 + 8min 硬超时 + abort 传播；结果取最后一条 assistant 文本回主会话
- **P51 hooks**：`hooksExtension` 扩展工厂：`~/.pi/agent/hooks.json` 数组（on/phase/command/timeoutMs/blockOnError），before（tool_call 可 block）+ after（tool_result）两阶段，模板变量 {{input.path}}/{{input.command}}；设置页示例创建 + 打开配置
- **坐坑 #99**：子代理 createAgentSession 不传 agentDir → SDK 回退 ~/.pi/agent 真目录配置，与沙箱主会话 baseUrl/auth 脱节（401 静默失败，报错藏在 message_end.errorMessage）；且用户真机默认 provider 是欠费的 cc-switch——**默认链解析错误不会在主会话暴露**（SDK fallback 救场），但在子代理里直接炸；子代理同链路解析 + 沙箱 settings.json 显式 defaultProvider=zhipu 后全通
- **坐坑 #100**：脚本批量 patch 用单引号锚点改双引号代码——replace 无匹配但报告 patched（假成功）；**sed/node replace 后必须 grep 验证目标串真的出现**（#96 同类坑再现）
- **e2e-p49**（PORT 9349，7 断言）：mock LLM 多层剧本（SUBAGENT-X→subagent 调用→REPORT-MARK 子代理轮→结论回主）；注册 e2e-all 现 23 套；回归 p47/p43 绿

## P47+P48：联网检索 + 用量面板 ✅（2026-09-14，随 0.40.0 发布）

Harness 缺口盘点五项（ROADMAP.md）的先行两项：

- **webfetch/websearch**：`src/main/web-tools.mjs`，经 `createAgentSession({ customTools })` 注入，SDK 零改动；SSRF 拦截内网/环回/元数据；websearch = Tavily（设置页配 key）→ DDG 兑底（被墙报错引导，**故意不加 Bing**：实测返回风控垃圾，静默给错比报错糟）；测试后门 `OPENPI_TAVILY_BASE`
- **用量面板**：状态栏 `in x · out x · $x`，hover 明细；`AgentHost.getUsage()` 从会话树聚合全部 assistant 消息（含历史轮）；resume 后回填
- **坐坑**：`#ensure()` 无返回值——`walk(this.#ensure().sessionManager...)` 拿到 undefined 直接抛错，必须 `this.#ensure();` 后用 `this.session.xxx`（e2e 抓住）
- **e2e-p47**（PORT 9347，8 断言）：mock LLM（openai-completions SSE 带 tool_calls 流式）+ mock Tavily 全离线；e2e-all 现 **22 套**；受影响回归 6 套绿（p30 首跑真模型抖动重试即绿）

## P46：UI 设计系统改造 ✅（2026-09-14，随 0.39.0 发布）

用户确认不换语言、要 UI 更好看 → 装 anthropics/skills 的 **frontend-design** 技能（Apache 2.0）作设计方法论，按其流程「token 方案 → 自审避开 AI 默认款 → 动代码 → 截图自检」改造：

- **图标**：Lucide UMD（vendor）+ data-lucide；静态 47 处 + 动态点全部收敛 refreshIcons()（highlightIn 末尾 + 各插入点）；theme 按钮 sun/moon 双图标按 data-theme CSS 切换；select option 无法渲染 SVG → 去 emoji 留纯文本
- **色彩**：砍蓝紫渐变（--grad 改单色 accent）、brand 纯色、阴影单色——对照技能「AI 默认款」清单自审后动刀
- **细节**：focus-visible ring（color-mix）、tabular-nums、reduced-motion 尊重、--t-fast 动效 token
- **坐坑 #97**：mcp-msg `<div></span>` 错配 → tab-skills 不闭合、电脑控制 tab 嵌套空白；静态标签配对扫描 + 运行时卡片高度审计双保险（脚本已留审计模式）；e2e 断言不查可见性所以多年没抓
- 视觉模型截图验收通过；p17/p34/p35/p40/p45/office/p30 全绿

## P45：聊天内可视化（内置「可视化」技能）✅（2026-09-14，随 0.38.0 发布，--fast）

用户贴了一张「可视化」技能卡截图（把数据/流程/机制/架构/关系/时间线转成 ECharts 或 HTML/SVG）→ 落地为内置技能 + UI 渲染升级：

- **渲染层**：vendor 化 echarts.min.js（1.1MB，离线）；AI 回复里 ```` ```echarts ```` 代码块（JSON option）自动替换为 .echarts-box 交互图表（canvas，tooltip/图例可用），挂在 highlightIn 首位（KaTeX 同管线）；liveCharts 上限 60 防泄漏，resize 自动适应
- **降级链**：JSON.parse 失败 / 缺 series / 容器宽度 <80px → 保留原代码块；幂等标记在**确认替换后**才置位（失败/隐藏可重试）
- **viz 技能**：resources/skills/viz/SKILL.md——按数据形态选图（柱/线/饼/桑基/关系/时间线）、严格 JSON 规则、大数据降采样、复杂仪表盘改走文件卡；OFFICE_ZH.viz 中文描述，随包自动部署
- **坐坑 #96**：尾逗号容错正则写成 `,(\s*[\]}])` 才对——首版 `,[\s\]}]` 把「逗号+空格+下一键」当尾逗号吃掉，合法 JSON 全灭（图表永远不渲染，全靠断言 canvas 数量才抓到；教训：清洗正则必须打印替换后字符串验证）
- e2e-p45 10/10（渲染/降级/共存/部署），office-skills 断言 6 行→7 行（viz 入列）

## P43/P44：Agent 独立进程 + SQLite 会话索引 ✅（2026-09-14，随 0.37.0 发布，全量）

取经清单六项收官。架构与坐坑：

| 项 | 实现 | 关键点 |
|---|---|---|
| P43 独立进程 | agent-worker.mjs（utilityProcess.fork 入口）+ agent-proxy.mjs（main 侧透明代理：方法→RPC、workspace 缓存属性、事件转发）；AgentHost 仅 3 个切口（emitFn/toolNames/hostPid）；崩溃自动重启 + 渲染层提示 | **踩坑 #94**：worker 内 host.userDataDir 必须由 boot 消息注入（P41 沙箱依赖它），全量回归 p31/p30 抓住；MCP 状态必须走 RPC（否则 main 侧双 mcpManager 连接）；`import { utilityProcess } from "electron"` 在 ESM 正常，但 node 模式跑会炸——调试时先确认 ELECTRON_RUN_AS_NODE 已剥 |
| P44 SQLite 索引 | sessions-index.mjs：better-sqlite3 + FTS5 trigram（中文子串）；files 表增量比对，启动后台同步 + **搜索前轻量同步**（变更重索引/删除即 prune）；<3 字符回退 LIKE；返回形状兼容旧搜索；native 失败自动降级 | **踩坑 #95**：electron-rebuild 报「找不到 Python」——`PYTHON=resources/runtime/python/python3.exe` 内置运行时直接可用；rebuild 后为 electron ABI，node 进程勿直接 require；SESSIONS_ROOT/OPENPI_SESSIONS_ROOT env 可覆盖（e2e 隔离） |

- 测试：e2e-p43 9/9（含 process.kill(workerPid) 真崩涥恢复）；e2e-p44 11/11；**打包产物冒烟**：OPENPI_EXE=win-unpacked/OpenPi\ Desktop.exe 跑 e2e-p43 验证 asar+fork+native unpack（e2e 脚本已支持 OPENPI_EXE 环境变量）
- 全量 20 套绿；archive 套首跑 1 败为真模型回复抖动，单跑复绿

## P41/P42：混合式沙箱 + 办公产物预览 ✅（2026-09-14，随 0.36.0 发布，--fast）

用户拍板后置四项全做（本轮完成两项，P43 独立进程 / P44 SQLite 索引待做）：

| 项 | 实现 | 备注 |
|---|---|---|
| P41 沙箱 | workspace-store.mjs：createSandbox（8位 id + .openpi-sandbox.json）/ bindSession 回填 / cleanupExpired（45天，启动时）；P30 后台任务改用沙箱（OPENPI_SANDBOX_ROOT 可覆盖，e2e 隔离用） | 混合式：主会话仍共享工作区；「非沙箱目录不误删」用元数据缺失当白名单 |
| P42 预览 | main.mjs preview:convert IPC：docx→mammoth、xlsx/xlsm/csv→SheetJS sheet_to_html、md→marked；缓存 userData/preview-cache/{sha1}.html；PV_FILE_RE 加新扩展名，navToPreviewFile 统一分流（原生直接 file://，办公类先转换） | **CJS interop 坐坑**：Electron main ESM 里 `await import("xlsx")` 的 readFile 在 `.default` 上（mammoth 同理）；xlsx ESM 直 writeFile 需 set_fs，测试夹具改用 openpyxl |

- 测试：e2e-p41 17/17（store 单元 5 + 后台任务沙箱真链路 3 + 转换 6 + 渲染层链路 2 + 启动）；--fast 只跑受影响 4 套（p30/p37/p40/p41）
- 待做：P43 Agent 独立进程（utilityProcess，auditLog 同步写盘是真实痛点）、P44 SQLite FTS5 会话索引（trigram 对中文）

## P40：向 pi Desktop 取经快赢批 ✅（2026-09-14，随 0.35.0 发布）

用户提出对标 pi Desktop v0.5.8 反解结论（openpi-learn-from-pi.md，6 项），核实后采纳：快赢批先做，沙箱/独立进程/SQLite 后置；SDK 锁版本零成本立即采纳。

| 项 | 实现 | 备注 |
|---|---|---|
| KaTeX 公式 | vendor 化（katex.min.js/css + auto-render + 20 个 woff2），highlightIn 里挂 mathRender，throwOnError=false | app.js 是非模块脚本（vendor 全局），不能用 import；CSP 加 style-src 'unsafe-inline'（KaTeX 依赖内联 style 属性排版） |
| 代码块复制 | highlightIn 里挂 codeCopy：pre 加 .code-copy 按钮 + chat 单个事件委托 | |
| PATH 保险 | shell-env.mjs：PowerShell 读 HKCU\Environment PATH + 常见目录探测，存在才追加 | **踩坑 #93**：前插会抢 injectPythonRuntime（模块顶层已置 PATH 首位）的内置 Python 运行时优先级，e2e-p36 实测抓包——改为尾部追加，只兑底缺失项 |
| SDK 锁版本 | ^0.85.1 → 0.85.1 | 上游小版本可能悄悄改事件结构 |

- 已评估后置：沙箱工作区（与「产物收进共享工作区」理念冲突，改混合式后做）、Agent 独立进程（auditLog 同步写盘是真实痛点）、办公产物预览（docx/xlsx，现有预览 dock 已覆盖 html/img/pdf）、SQLite FTS5（现状搜索 2s 预算够用）
- 测试：e2e-p40 9/9（注册进 e2e-all 共 17 套）；首跑全量时 #93 被 p36 抓住——全量回归对 feature 版依然值得

## P39：向 Cursor 取经三件套 ✅（2026-09-14，随 0.34.5 发布，--fast 首次实战）

用户对标 Cursor（扒官方文档：Agent Review/Planning/Rules/Skills/Subagents/Hooks/MCP 等），拍板移植三个高性价比能力：

| 能力 | 实现 | 文件 |
|---|---|---|
| **本轮改动卡**（对标 Agent Review） | checkpointExtension 换出 turn_file_change 事件 → 渲染层收集 → agent_settled 渲染汇总卡（文件列表 + 打开审核面板 + 全部回滚=逐文件 checkpointRestore） | agent-host.mjs / app.js renderTurnCard |
| **命令允许清单**（对标 allowlist） | ⚙ 允许清单弹层（index.html allow-mask）→ localStorage → agent:approval-allowlist → 审批扩展：isExec && !risky && 前缀命中 → 免确认（readonly/auto-edit 生效；full-auto 本就直通；危险命令任何档位拦截） | agent-host.mjs approvalExtension / app.js openAllowModal |
| **失败重试** | finalizeAssistant 检到 stopReason=error → 挂「↻ 重试本轮」→ 重发 state.lastPrompt（sendText 时保存） | app.js mountRetryChip |

- 已确认不学的：Tab 补全/inline 编辑（无编辑器）、embedding 索引（工作区规模 ripgrep 够用）、Cloud/Bugbot/Mobile（场景不符）
- 测试：e2e-p39.mjs 11/11（沙箱 + echo + CDP：真实回合不误弹卡 / 模拟两文件改动画卡开面板 / 清单 UI→持久化 / 重试钮挂载）；发布走 dist --fast（用户指示：改动小不跑全量，省 token）

用户反馈每次办公任务 AI 都先跑环境检查/安装。根因：技能 SKILL.md 自带「Quick Setup: 运行 setup.sh（环境检查+安装）」引导。

| 项目 | 状态 | 说明 |
|---|---|---|
| **运行时补齐**：DEPS + pikepdf/pdfplumber/defusedxml（121→158.8MB） | ✅ | 技能脚本全部 import 盘点后补缺；pdf2image 不入（需外部 poppler） |
| **SKILL.md 去安装化**：四份的 Quick Setup/Dependencies 全换「Ready — Do Not Install」 | ✅ | pptx 依赖清单重写（markitdown/LibreOffice/Poppler 均不需）；pdf 778 行 pymupdf 提示同步改 |
| **安装脚本秒退化**：setup.sh×3 + env_check.sh×3 + setup_windows.ps1×3 | ✅ | env_check 保留变量导出（XLSX_SKILL_DIR 等），其余全部一秒返回「已就绪」 |
| **pdf.py form.render 改用 fitz** | ✅ | 替代 pdf2image+poppler；env_fix 模块表移除 pdf2image |
| **版本标记强制重部署**：SKILLS_DIR/.office-deploy-ver ≠ app.getVersion() → force 重部署一次 | ✅ | 解决已装用户技能目录永远停留旧版 SKILL.md 的问题 |
| e2e-office-skills 增 5 断言（去安装化声明/pip 残留/setup.sh 秒退/fitz 替代/新库在 runtime），15 套全绿 | ✅ | |



## P38.5：贴图 400 全链路排查与修复 ✅（2026-09-14，随 0.34.0 发布）

用户在 OpenPi Desktop 给 glm-5.3-flash 贴图报 400（1210「API 调用参数有误」/ 1214「.file必须传入file_id、file_url、file_data至少之一」），全链路排查定位双根因并修复。

| 项目 | 状态 | 说明 |
|---|---|---|
| **根因一（1210）**：空文本+图片组合被智谱拒收 | ✅ | `session.prompt("", {images})` → SDK 生成 `[text(""),image]`；curl 实验实锤：`[text(""),image]`→1210，`[image]` 单独发→200（婚纱照 7.3MB 也能过，**不是**尺寸限制）。修法：`#sanitizeVisionPayload` 空文本+图时补占位文本「请看这张图片。」，模型自行领会意图 |
| **根因二（1214）**：空 data 图片进入请求 | ✅ | 实锤于 pi Desktop 会话 JSONL：历史里存了 `image(data:0)`，后续每条消息全 400。修法：agent-host 发送前剔除空 data 图，全空则整包不发 |
| **e2e-p385-vision**：沙箱 agent 目录（PI_CODING_AGENT_DIR 重定向，不碰用户配置）+ 本地 echo 抓包 + CDP 真实链路，9/9 全绿（场景①空文本+图→发占位文本、②空 data 图→整包不发、③带字+图→文本保留） | ✅ | 截图 `e2e/p385-vision.png`；已注册 e2e-all（15 套） |
| **pi Desktop（上游工具）结论**：其 1214 是自身附件链路问题（附件读取失败仍把空图写进历史），纯文本模型或压缩上下文后自愈；旧会话历史已污染不可救，新会话正常 | ✅ | OpenPi 自身链路（renderer→IPC→SDK 抓包）从未发出过空图 |
| **排查方法沉淀**：echo 服务器 + `PI_CODING_AGENT_DIR` 沙箱重定向 + CDP 驱动真实 renderer；智谱错误码速查：空 url=1214「url cannot be empty」、非 data URL=1210 解析错、空 base64/空 file 对象=1214、`[text(""),image]`=1210 | ✅ | Connection error 与 400 无关，是到 open.bigmodel.cn 网络间歇不通 |

**踩坑**：
89. 智谱 glm 系拒收 `[text(""),image]` 组合（1210），单独 `[image]` 反而正常——发图前必须清洗空文本 part；带空 data 的图片会以「.file必须传入…」(1214) 形式报错。
90. git-bash 会把 `taskkill /PID` 的 `/PID` 当 POSIX 路径转换成 `C:/Program Files/Git/PID` 且不报错退出码也不明显——taskkill 在 git-bash 里必须写 `//PID`。曾导致测试实例+echo 服务器未杀干净，用户对着残留脚手架测试出一堆假报错。
91. 调试 spawn 的常驻测试实例必须用 `taskkill //PID <pid> //T //F` 收尾并复查 `netstat` 端口监听清零；「echo 服务器关了没」不能只看脚本退出，要验端口。

## P38：压缩包技能（archive）✅（2026-09-14 实现，随 0.34.0 发布）

| 项目 | 状态 | 说明 |
|---|---|---|
| **archive_tool.py**（零依赖 CLI：list/extract/create + `--password`） | ✅ | zip/tar 系标准库；7z 走 py7zr 1.1.3（`writeall()` 才递归，`write()` 不递归）；rar 只读尽力而为，失败明确告知 |
| **GBK 乱码修复**（中文用户头号痛点） | ✅ | zip 无 0x800 标志位时 cp437 还原原始字节→utf-8→gbk 严格解码；create 置 UTF-8 标志位 |
| **安全** | ✅ | zip-slip 防护 `safe_join()`；解压默认落 `output/<压缩包名>/`；绝不覆盖已有文件；密码包先问不穷举 |
| **runtime 重建** | ✅ | 121.0 MB 含 py7zr；`main.mjs` OFFICE_ZH + `agent-host.mjs` 技能映射 |
| **e2e-archive** 11/11 全绿（含真实模型解压 GBK zip、打包 UTF-8 zip、3 张文件卡） | ✅ | 截图 `e2e/p38-archive.png`；GBK 夹具由宿主 Python 构造（`zi.flag_bits = 0`） |

**P38 踩坑**：
- py7zr `write()` 不递归必须 `writeall()`；`FileInfo.is_directory` 是 bool 属性。
- e2e 用 JS 模板字符串生成 Python 代码时 `\n` 要写 `\\n`。

## P37.2：真实更新链路发布 ✅（2026-09-13 晚，发布设施 + 打包修复，重出 0.33.1）

用户拍板「搞」：把「应用内检查更新 → 下载 → 重启安装」整条链路真机走通，并建常驻发布设施。

| 项目 | 状态 | 说明 |
|---|---|---|
| **常驻发布源**：`E:/pi2/openpi-releases/`（release-server.mjs + server.bat），HTTP/1.1 keep-alive + Range（blockmap 差分下载必需）伺服于 `http://127.0.0.1:9355/`；用户启动文件夹放 OpenPiReleaseServer.vbs 开机自启（无需管理员；schtasks 被拒后换此方案） | ✅ | python -m http.server 会 ERR_EMPTY_RESPONSE（踩坑 #87），必须用 node 版 |
| **发布工具**：`scripts/publish.mjs`（三件套校验/拷贝/服务自检/updater.json 指向自检）；发布流程 = `npm run dist` → `node scripts/publish.mjs` | ✅ | curl 本机自检必须 `--noproxy`（shell 代理变量劫持回环） |
| **打包修复**：`scripts/after-pack.cjs`（package.json build.afterPack）写 resources/app-update.yml | ✅ | 踩坑 #86，缺失则下载阶段 ENOENT 升级链断；写 win-unpacked + 重打 NSIS 的方案被 builder 清空重建冲掉，钩子才是正道 |
| **真机升级 0.32.0 → 0.33.1**：CDP 驱动已装版（注意 spawn 必须 `env -u ELECTRON_RUN_AS_NODE` + 摘除 proxy 环境变量）→ 检查更新发现 0.33.1 → 下载 244MB → 重启安装 → app.asar 验证 0.33.1 + 自动重启 | ✅ | `scripts/manual-update-test.mjs`（一次性保留） |
| **下一跳链路终验**：99.0.0 fixture（fake exe + 匹配 sha512 的 latest.yml）→ 0.33.1 检查/发现/下载/ready 全通；终验后恢复 latest.yml + 删 fake + 清下载缓存 | ✅ | `scripts/manual-update-final.mjs`；不清缓存会残留「新版已下载 v99.0.0」状态（electron-updater 读磁盘缓存） |
| **e2e 加固**：e2e-p33 换端口 9355→9398（不再撞常驻发布源）+ 跑完恢复 updater.json 指向 9355；publish 自检修正 updater.json | ✅ | 踩坑 #88：e2e-p33 原本写完不还原，历史上把 updater.json 留在死端口 9398 |
| **应用内凭证截图**：0.33.1 已装版设置页「当前版本 v0.33.1 · 已是最新版 ✓」（p372-updater-uptodate.png） | ✅ | |

**更新器发现的新边界**：electron-updater 无代理豁免逻辑但系统 ProxyOverride 含 127.* 时不走代理（OK）；`ELECTRON_RUN_AS_NODE` 环境变量会把已装版 exe 打回 node 模式（bad option），仅工具链 shell 会遇到，真实用户双击无碍。

**踩坑**：
86. electron-updater 打包版下载阶段必读 `resources/app-update.yml`（builder 仅在配置 publish 字段时生成，我们运行时 setFeedURL 只救得了检查阶段）→ 缺失报 `ENOENT app-update.yml` 下载必挂。修法：afterPack 钩子写入。存量 0.32.0 用户跨坑：手动跑新 Setup 一次即可。
87. `python -m http.server` 不兼容 electron-updater（ERR_EMPTY_RESPONSE），且不支持 Range 请求（blockmap 差分下载必需）——发布源必须 node/正规静态服务器。
88. e2e-p33 写 updater.json 后不还原 + 首次撞端口崩溃未走还原逻辑 → 把指向留在死端口 9398，用户侧「检查更新」报网络不可达。修法：套件尾部恢复 9355 + publish 自检自动修正。

## P37.1：办公技能品牌洗白（去 ZCode/Z.ai 痕迹） ✅（v0.33.1）

用户贴 ZCode 截图拍板：技能是 ZCode 生态搬来的，痕迹要洗成 OpenPi 自有。

| 项目 | 状态 | 说明 |
|---|---|---|
| **痕迹清单**：grep 两份副本（resources/skills 安装包源头 + ~/.pi/agent/skills 活技能）共 41 处/17 文件——SKILL.md 引用章节（4 套各一整节 ::zcode-file-citation 体系）、author: Z.AI 元数据、pdf.py/报告模板里 Z.ai 元数据（PDF /Author//Creator//Producer、简历 pdfauthor、VBA 注释）、setup.sh 署名 | ✅ | |
| **替换**：scripts/rebrand-skills.mjs（一次性，两份同步跑）——引用章节整体替换为「Final response — artifact reporting (OpenPi)」（报告绝对路径，与 P37 文件卡联动）；author/元数据/URL → OpenPi；__pycache__ 陈旧缓存清除 | ✅ | 终检 0 残留（LICENSE 除外）；pdf.py py_compile 通过 |
| **边界**：LICENSE.txt 依上游专有许可要求原样保留（main.mjs 部署注释已注明「非商业分发，LICENSE 原样保留」） | ✅ | 法律文件不动 |
| **渲染层兑底保留**：FCARD_CITE_RE 对 ::zcode/z:code 两种标记的兼容不动（旧会话历史与模型习惯的兑底安全网） | ✅ | |

**注意**：部署逻辑是「已装不覆盖」——老用户升级安装包后，活技能不会自动换新（要删 ~/.pi/agent/skills/{docx,xlsx,pptx,pdf} 重启应用才重新部署）；本机已手动同步两份。后续若做「技能更新」机制可参考。

**E2E**：改动仅为技能文本内容，e2e-office-skills（文件断言）+ 全量回归后打包。

## P37：产物文件卡 + 贴图视觉提示 + 办公产物规范 ✅（v0.33.0）

对标 ZCode 文件引用体验（用户贴截图拍板）：生成物在对话里直接成卡、可点开、可定位本地。

| 项目 | 状态 | 说明 |
|---|---|---|
| **产物文件卡**：渲染层 mountFileCards——TreeWalker 扫文本节点（跳过 pre/思考/工具卡），PATH_RE 匹配绝对路径/家目录路径（doc/xlsx/pptx/pdf/md/txt/zip/json 等 15 类扩展名，中文文件名含全角标点兼容），行内 code 整体替换；卡片 = 类型色块图标 + 文件名 + 徽标 | ✅ | 左键 shell.openPath 系统默认程序打开；缺失自动灰置（app:fileStat 异步检查） |
| **右键菜单**：复用 showCtx —— 打开 / 在资源管理器中显示（app:showItemInFolder → shell.showItemInFolder）/ 复制绝对路径 / 复制相对路径（仅工作区内文件显示，纯前端算相对） | ✅ | 4 项菜单 E2E 实测 |
| **ZCode 标记兑底**：glm 系模型会吐 docx 技能规定的 `::zcode-file-citation{path="..." purpose="output"}` 私有标记（也有 z:code 变体）——CITE_RE 兑底成纯路径再统一成卡，无残片 | ✅ | 实测踩坑 #84：标记是 `::zcode`（无中间冒号），首版正则写 `z:code` 差一个字符没匹配 |
| **贴图视觉提示（待办①）**：agent-host start 返回 model 补 input 数组；ingestFiles 前调 warnIfNoVision——input 无 image → sysline 警告「当前模型不支持图片输入」，不再静默丢失 | ✅ | |
| **办公产物规范（待办②）**：officePromptExtension before_agent_start 每轮注入——「写个文档」默认 Word（.docx）而非 .md；表格/幻灯片/PDF 关键词映射对应技能；产物强制收进工作区（推荐 output/）；回复报告完整绝对路径（供文件卡） | ✅ | 真实模型实测：产物落 p37-e2e/output/p37.docx ✅ |

**E2E**：`scripts/e2e-p37.mjs` **17/17 绿**（确定性 DOM 注入 4 项：绝对路径卡/缺失灰置/标记兑底+无残片/右键菜单 4 项 + 真实模型闭环：start.input 透传/贴图警告开关/产物落工作区/卡片指向真实文件/复制路径回读/左键打开）；截图 e2e/p37-fcard.png。e2e-all 增至 **13 套**。

**踩坑**：
84. ZCode 引用标记真身是 `::zcode-file-citation`（无中间冒号，docx 技能文档规定语法），不是想当然的 `z:code-file-citation`；兼容写法 `/:{0,2}z:?code-file-citation\s*\{/`。另：路径可能包在 `**加粗**` 里，markdown 渲染后单独成文本节点，PATH_RE 天然能抓到——两路兑底都留。
85. E2E 左键打开测试会拉起 Word 锁住产物文件，下一轮 rmSync 工作区 EBUSY——套件开头 rm 失败时温和 taskkill Office（WINWORD/wps/wpp/et）后重试。

## P36.5：贴图视觉修复 ✅（2026-09-13，运行时配置修复，不发新版本）

用户真机贴图后模型完全「看不见」，且无任何报错——静默失败。

| 项目 | 状态 | 说明 |
|---|---|---|
| **根因定位**：`~/.pi/agent/models.json` 里 zhipu/glm-5.3-flash 被标 `"input": ["text"]`，pi 依此标记把消息里的图片内容**静默丢弃**（不报错） | ✅ | 但该模型官方文档称原生多模态，API curl 直调读图正常——标记错了 |
| **修复**：input 改为 `["text", "image"]` | ✅ | models.json 是 pi 标准用户配置文件（软件只读写不分发），不改软件代码、不动版本号 |
| **生效条件确认**（读 pi 源码）：模型对象会话启动时固定（`getModel(){ return this.model }`），改配置后须 **/model 重选或 /new 新会话**才生效 | ✅ | |
| **真机验证**：新会话读剪贴板图（pi-clipboard-c0f69e42-*.png）→ 模型完整说出截图细节：会话列表条目、20:20~20:21 的 docx 生成对话（质检 9/9 ✅）、底部 glm-5.3-flash·128k 选择器、状态栏 token 统计 | ✅ | 2026-09-13 会话验证通过 |
| **通用看图工具**：scripts/vision.mjs（node scripts/vision.mjs <图> [问题]） | ✅ | 注意 cc-switch 的 kimi-k2.7-code 余额不足，zhipu API 直调可用 |

**踩坑**：
83. 模型元数据 `input` 标记错（多模态模型只标 ["text"]）→ pi 把图片静默丢弃，无任何报错线索；修复后还必须新会话/重选模型才生效——「静默失败 + 配置不热更」双重坑，排查先查 models.json 标记、再查审计日志、最后 curl 直调 API 对照。

## P36：办公技能安装即用（内置 Python 运行时） ✅（v0.32.0）

用户需求：软件只要安装，办公功能就能用，技能自带、不需要额外操心。

| 项目 | 状态 | 说明 |
|---|---|---|
| **内置 Python 运行时**：scripts/prepare-python-runtime.mjs 构建 resources/runtime/python（官方 embeddable CPython 3.12.10 + ._pth 启用 site-packages + pip --target 预装 8 个依赖 + python3.exe 别名），113.7MB，幂等可重建 | ✅ | 打包经 NSIS 压缩后安装包仅增 26MB（217→243MB） |
| **PATH 注入**：main.mjs app.whenReady 前把 runtime 目录注入 process.env.PATH 最前（打包版 process.resourcesPath/runtime/python，dev 版项目根 resources）——pi 内核的 bash 子进程继承，python3 全链路可用 | ✅ | 一处注入全局生效，不改 pi 内核 |
| **打包配置**：files 排除 resources/runtime + extraResources 复制到安装目录（不进 asar，exe 需真实路径） | ✅ |
| **干净机模拟 E2E**：启动时从 PATH 摘除一切含 python 的段 → python3 可用且依赖自检 DEPS-OK → AI 真调 docx 技能生成 p36.docx → 宿主 python-docx 读回（跨运行时互认）；另直验打包产物 win-unpacked 内 runtime 全依赖 import 成功 | ✅ | e2e-p36 8/8 |

**E2E**：e2e-all 增至 **12 套 155 断言**全绿；产物 Setup/portable 0.32.0（243MB）+ latest.yml

## P35.1：体验优化四连（计划卡片 / 记忆管理 / latest.yml / dist 清理） ✅（v0.31.0）

用户点单的四项体验优化：

| 项目 | 状态 | 说明 |
|---|---|---|
| **计划卡片结构化**：新增 plan_submit 工具（goal/steps/risks 结构化参数，plan 系统提示改为强制引导调用）；渲染层 plan-bar 升级为计划卡片（goal + 可勾选步骤列表 + 风险区），重复提交以最后一次为准 | ✅ | plan_submit 进只读白名单；E2E 抓到真实卡片（goal + 2 步） |
| **记忆管理**：发空 # 打开记忆面板（列表 + 时间戳 + 单条删除）；后端 agents:list-memory 解析 `- （时间）内容` 行 / agents:delete-memory 解析后内容全等才删（防前缀误删） | ✅ | |
| **latest.yml 生成**：scripts/dist.mjs 打包总调度（e2e-all → electron-builder → gen latest.yml，全部强制 node-lts）；yml 格式与 electron-updater generic 源一致，sha512 真值校验一致 | ✅ | 发布 = 把 Setup exe + blockmap + latest.yml 丢 HTTP 目录 + updater.json 配 url |
| **dist/ 清理**：删除 0.8.0~0.30.0 全部旧安装包（38 个 exe 约 8GB） | ✅ | |

**附带修复**：electron-builder 在系统 node16 下崩溃（clear-cache require 失败）——dist.mjs 统一 node<20 时重入 node-lts（#79 的补全）。

**E2E**：e2e-p35 增至 **18 项**（计划卡片 goal/步骤数断言 + 记忆面板打开/列出/删除/关闭 4 项）；npm run dist 全流程（含全量回归）一次通过

**打包产物级实测**（scripts/manual-v031.mjs，portable 0.31.0 + 真实模型，18 项全 PASS）：多步清单 3 项勾选 + greet 真实写入；计划拦截 → 结构化卡片（goal + 3 步）→ 批准自动执行 → 模式切回；# 记忆写入/面板/删除；更新器连本地 HTTP 真实发布目录（真 Setup exe + latest.yml）→ up-to-date 正确判定。截图 v031-1~5.png

**办公技能真机实测**（v0.31.0 发布后首次真跑，此前机器无 Python 从未能跑）：

| 前置 | 状态 |
|---|---|
| winget 静默装用户级 Python 3.12.10 + pip 装 python-docx/openpyxl/python-pptx/lxml/Pillow/pypdf/reportlab/PyMuPDF；复制 python.exe → python3.exe（技能脚本调 python3） | ✅ |

| 技能 | 产物 | 读回验证 |
|---|---|---|
| docx | intro.docx（标题+两段） | python-docx 读回 3 段落 ✅ |
| xlsx | sales.xlsx（大标题+加粗表头+5 行数据） | openpyxl 读回表头行+5 数值+加粗 ✅ |
| pptx | demo.pptx（3 页） | python-pptx 读回 3 页 ✅ |
| pdf | hello.pdf（单页） | pypdf 读回 1 页含文本 ✅ |

截图 office-1~4.png；实测脚本 scripts/manual-office.mjs + verify-xlsx.mjs（产物宽容断言）

**踩坑**：
81. node → python 子进程传含中文的 -c 源码：argv 编码链路不可靠，比较字面量用 unicode 转义（\u4ea7）更稳。
82. python -X utf8 在 Windows 的 stdout 是 \r\n——node split("\n") 后每行尾部残留 \r，`=== "HDR"` 恒 false；必须 split(/\r?\n/) + trim。

## P35：向 Claude Code 取经三部曲 ✅（v0.30.0）

对标 Claude Code 最具性价比的三个工作流特性，全部用 pi 官方扩展点实现（零底层改动）：

| 项目 | 状态 | 说明 |
|---|---|---|
| **① TodoWrite 任务清单**：注册自定义工具 todo_write（promptSnippet + promptGuidelines 强引导：3 步以上任务先建清单、始终保持恰一项 in_progress）；状态经 host.pushEvent → agent:event → 渲染层输入框上方清单条（☑ 进度 + ◐ 进行中高亮 + done 删除线，可折叠）；新会话自动清零 | ✅ | 只读档工具（不弹审批）；计划模式下也可用（建计划清单） |
| **② Plan Mode 计划模式**：审批模式第四档——tool_call 拦截层：非只读工具（写/执行/未知）一律硬拒绝（不弹窗）+ reason 引导输出计划；before_agent_start 按轮注入系统提示（只读探索 → 输出目标/步骤/涉及文件/风险点 → 停下等批准）；AI 说完话后亮出「☑ 批准执行」条 → 点击自动切回原档位并发送“计划已批准”；「继续讨论」留在计划模式补充要求 | ✅ | setApprovalMode 白名单漏加 "plan" 导致静默失败（踩坑 #78）；切换失败时 select 回滚不再吞错 |
| **③ # 快捷记忆**：输入框 # 开头的一句话不发给模型，直接追加进工作区 AGENTS.md（不存在则创建，带时间戳 bullet）；sysline 反馈；后续所有会话自动加载生效 | ✅ | IPC agents:append-memory（workspace/AGENTS.md，截断 500 字） |

**E2E**：`scripts/e2e-p35.mjs` 12 项全绿（todo 三项勾选 + mul 真实写入；plan 拦截 now.txt 不存在 + 批准后自动生成 + 模式切回；# 记忆入 AGENTS.md + 无 streaming）；截图 p35-todo/plan/plan-approved/memory.png；e2e-all 11 套 **141 断言**全绿

**踩坑**：
77. 真实模型依赖套件全量串跑偶发失败（glm-5.3-flash 轮次不遵循，单轮 5 套挂）：先单跑复核——单跑全绿 + 二次全量绿才放行，不要直接当回归修代码。
78. setApprovalMode 白名单数组忘了加新档位 "plan" → IPC 抛错被渲染层 catch 吞掉 → select 显示 plan 但主进程仍是 auto-edit（审计日志抓出 mode:auto-edit 真值）——新增档位必须同步白名单，UI 失败必须回滚 select 显示。
79. npm run dist 用系统 node16（无全局 fetch）跑 e2e-all：waitReady 的 fetch 抛错被吞 → 全部套件"60s 未就绪"假死。e2e-all 开头自检 node<20 时自动用 LOCALAPPDATA/node-lts 重入自己。
80. MCP 套件首部一次性查 mcp:status 遇 stdio spawn 慢（CPU/杀扫拖累）必炸——改轮询等就绪（上限 30s）再断言。

## P34.1：git 身份缺失引导补配 ✅（v0.29.1）

实测真人流程（真实模型真实交互路径）抓到的体验问题：git 身份未配置时 commit 失败，sysline 直接吐 git 英文教程。

| 项目 | 状态 | 说明 |
|---|---|---|
| **identity 缺失识别**：gitCmd 捕获 "Author identity unknown / tell me who you are / user.useConfigOnly" 抛 GIT_IDENTITY_MISSING 前缀错误 | ✅ | |
| **双输入表单**：mini-modal 扩展 fields 模式（姓名/邮箱双输入）；commit 捕获后弹「配置 git 身份（本仓库）」表单，gitSetIdentity 写入本仓库局部 config 后**自动重试提交** | ✅ | E2E 用 user.useConfigOnly=true 稳定复现 identity 缺失场景 |

**E2E**：e2e-p34 增至 15 项（identity 场景 4 项：表单弹出/重试成功/身份写入/作者正确）；截图 p34-identity.png + 人工实测 5 张 manual-*.png

## P34：块级采纳（accept 向）+ 跨会话搜索 ✅（v0.29.0）

对标 Codex IDE 扩展 accept/reject 双向的另一半：

| 项目 | 状态 | 说明 |
|---|---|---|
| **块级采纳**（git add -p 的 GUI 化）：diff 按 vs-index 视角渲染待处理块（✓采纳/↩撤销）+ 已采纳段（只读绿标）；采纳单块 = git apply --cached 暂存进 index；**智能 commit**：index 有内容时只提交已采纳块（miniConfirm 提示），否则维持 add -A 全量旧行为；未采纳块留在 worktree 可继续编辑/撤销 | ✅ | 真值断言：commit 只含 KEEP-A 不含 DROP-B，worktree 保留 DROP-B |
| **跨会话消息搜索**：侧栏搜索框输入 ≥2 字符即触发深搜（300ms 防抖），扫全部历史会话 jsonl 的消息内容（mtime 降序优先扫最新、单文件 1MB 上限、总 2s 超时、30 条上限）；命中结果置顶展示匹配行片段，点击直接恢复会话 | ✅ | marker 词全链路验证 |

**E2E**：`scripts/e2e-p34.mjs` 11/11（已纳入 e2e-all 清单）；截图 p34-search.png

**踩玵**：
74. jsonl 搜索循环里不能用 `line.includes(needle)` 粗筛后再 parse：session 头行不含搜索词被 continue 跳过 → head 永远 null → `if (head && match)` 永假返回空——每行都必须 parse，head 提取与 needle 匹配解耦。
75. UI 结构化中间态断言（如「采纳后待处理块剩 N 个」）受 refreshReview 折叠重绘 + Promise.all 异步渲染双重时序干扰，不值得硬等——改断言 sysline 反馈 + git 真值（diff --cached / diff）。
76. jsonl 文件名时间戳 ≠ mtime（文件名是 UTC，mtime 随 pi 运行时触碰更新），按 mtime 排序扫描即可，别用文件名猜新旧。

## P33：自动更新器 + diff 块级撤销 ✅（v0.28.0）

对标 Codex 剩余差距的性价比前二项（沙箱在 Windows 投入产出比最低，继续维持护栏+审计方案）：

| 项目 | 状态 | 说明 |
|---|---|---|
| **自动更新器**（electron-updater 6.8.9）：独立模块 updater.mjs，更新源运行时可配 ~/.pi/agent/updater.json（github owner/repo 或 generic url）；状态机 idle→checking→available→downloading(p%)→ready→重启安装；设置页「⬆ 关于与更新」卡（检查/下载/重启安装/配置源按钮 + 进度条）；下载需用户点击（版本自主权）；状态经 agent:event 通道推送 | ✅ | E2E 用本地 fixture HTTP 伺服 latest.yml+假包全链路验证（含 sha512 校验），不真装 |
| **diff 块级撤销**：审核面板 diff 按 hunk 结构化渲染（.hunk 块 + ↩ 撤销此块）；后端 splitDiffHunks + gitRevertHunk（重构单 hunk patch，git apply -R 打回 worktree，行号偏移靠 git apply 上下文搜索）；untracked 文件不支持块级（纯文本展示） | ✅ | 两块改动撤销一块、另一块保留，真值断言 |

**E2E**：`scripts/e2e-p33.mjs` 11/11（已纳入 e2e-all 清单）；截图 p33-update.png / p33-hunks.png

**踩玵**：
68. electron-updater 是 CJS 包，ESM 具名导入报 does not provide export——需 `import pkg from ...; const { autoUpdater } = pkg`。
69. 开发模式（未打包）下 electron-updater 静默跳过检查（"Skip checkForUpdates because application is not packed"），且下载要求工程根有 dev-app-update.yml——`autoUpdater.forceDevUpdateConfig = true` + 补该文件即可调试全链路；打包版不受影响。
70. 事件监听必须在 initUpdater 无条件注册：更新源若晚于启动才写入（E2E 运行时写配置），提前 return 会导致 checkForUpdates 后状态永远卡 checking（事件无人接）。
71. 动态渲染的子树不能在父渲染时绑定事件：hunk 块随 diff 展开（点行后异步 outerHTML 替换）才存在，refreshReview 时绑定 querySelectorAll 恒空绑——事件委托挂 #review-body（innerHTML 重绘不清除 body 自身监听）。
72. E2E 佐证撤销类断言要轮询等文件变化而非固定 sleep：miniConfirm 自动点 500ms 延迟 + IPC 链，固定 1.5s 边界不稳。
73. E2E 断言禁止硬编码版本号：p33 的“当前版本 v0.27.0”断言在升版 0.28.0 后全量回归立即失败——从 package.json 动态读。全量回归门第 2 次兑现价值。

## 质量门固化：打包前全量 E2E 回归 ✅（v0.27.0）

| 项目 | 状态 | 说明 |
|---|---|---|
| **e2e-all.mjs 调度器**：8 套代表套件（p31/p26/p29/p27/office/p28/handoff/p30，共 103 项断言）串行跑，每套独立干净实例（只杀 9333 占用者不误伤其他 Electron 应用），FAIL 自动重试 1 次，末尾汇总表 + 非零退出码 | ✅ | `npm run e2e:all`，支持 `--only p30` 单套调试 |
| **打包硬门槛**：`npm run dist` = `node scripts/e2e-all.mjs && electron-builder --win`，回归失败禁止出包；`dist:skip-e2e` 是明确命名的逃生门 | ✅ | |
| **回归首航抓到 2 个真问题**（全量回归的价值当场兑现）：① p27 残留状态（上次失败留下的同名文件+保护分支）导致 nothing to commit 静默失败——脚本前置加残留清理 + 特性文件带时间戳；② gitCmd 错误信息丢失：git 把 "nothing to commit" 输出到 stdout，且 execFileSync 的 err.stderr 为**空串**时 `??` 不回退 message——改为 stderr\|stdout\|message 三路合并 | ✅ | |
| **MCP 夹具自备**：p28 套件 before 钩子自动写 ~/.pi/agent/mcp.json（echo 条目，保留用户其他 server） | ✅ | |

**首航结果**：8/8 套全绿（103 断言）→ 0.27.0 正常打包。旧里程碑一次性脚本（m2/m3/p0…）不纳入，纳入标准：当前功能体系的代表套件。

**踩玵**：
66. 回归只跑当版 E2E 是漏洞：p26 之后五版无人回头跑旧套件，期间 dock/设置页 HTML 改动多次——新功能过 ≠ 旧功能还活着。e2e-all 每套独立实例是为了不让状态共享制造假阳性。
67. execFileSync 失败时 err.stderr 可能是空串（git 的 "nothing to commit" 走 stdout），`err.stderr ?? err.message` 不会回退空串——错误信息要 stderr\|stdout\|message 多路合并。

## P2 后收尾打磨：隔离修复 + 文档欠账 ✅（v0.26.1）

P2 收官后发现的真实欠账（无预设 P3，先修真问题）：

| 项目 | 状态 | 说明 |
|---|---|---|
| **幽灵会话污染修复**：后台任务的 session 文件此前落默认 sessions 目录，每次任务都在主会话列表留幽灵；改用 `SessionManager.create(cwd, <agentDir>/sessions-tasks)` 独立目录，主列表零污染，文件保留可回溯 | ✅ | E2E：列表 43→43，文件落 sessions-tasks |
| **审计日志 UI 入口**：设置页「🛡 安全审计」卡 + 一键打开日志文件夹（audit:open IPC） | ✅ | |
| **README 补全**：功能清单从 M3.5 一路补到 P 系列（电脑控制/办公技能/接力/通知/AGENTS/回滚/分支保护/@补全/MCP/护栏/审计/并行任务）+ 新增「已知限制」段（任务重启丢失/MCP 重连需新会话/办公技能需 Python/仅 Windows） | ✅ | |
| **CHANGELOG.md 新建**：用户视角里程碑（0.8.0 → 0.26.1） | ✅ | |

**E2E**：`scripts/e2e-p31.mjs`（6 项：任务回归、产出、sessions-tasks 隔离、列表零污染、审计卡片；截图 p31-polish.png）

## P2 收官：后台并行任务 ✅（v0.26.0）

对标 Codex P2 最后一项：单窗口内多任务并行，主会话不被阻塞。

| 项目 | 状态 | 说明 |
|---|---|---|
| **后台并行任务**：`AgentHost.startBackground(prompt)` 创建独立 session（跟随主会话当前模型，最多 3 个并发），fire-and-forget 跑完自动 dispose；事件订阅累积工具调用数 + 最近 3 条 assistant 文本（≤300 字/条）；状态流转 running → done/error | ✅ | E2E 实测：后台任务跑工具的同时主会话照常可用（并行真值） |
| **⚡ 任务面板**：dock 新 tab（徽标显示运行中数）；任务行（状态点🟡/🟢/🔴 + 标题 + 状态/工具数/耗时）点击展开最近输出；底部输入框直接发起；完成/失败且窗口最小化时弹系统通知（复用 P26 通知通道） | ✅ | |
| **后台护栏语义**：后台 session 不传 uiContext（hasUI=false）→ 审批弹窗无处弹 → 危险命令被护栏直接拒绝（审计 blocked），普通命令照常；同时 approvalExtension 无 UI 分支从"不拦截"改为"危险拒绝" | ✅ | 靶目录存活验证；此前无 UI 一律放行是个安全盲区，顺手堵上 |
| **错误显性化**：assistant stopReason=error（额度耗尽/401/key 错）不再被误标 done，任务状态置 error + errorMessage 透出 | ✅ | 排查中被 401 CreditsError 空响应假 done 误导多轮后加上 |

**E2E**：`scripts/e2e-p30.mjs`（13 项断言：发起/运行中/完成流转、并行真值（后台跑工具时主会话同时跑完）、产出文件内容、危险命令拒绝+审计 blocked、面板渲染/状态标签/输出展开；截图 p30-tasks.png）

**踩坑**：
63. 后台任务秒回空响应（stopReason=error）被误标 done——根因两层：① createAgentSession 不传 model 时 pi 默认链选到未配置额度的 provider（cc-switch 401 Insufficient balance），而主会话用的是用户在 UI 选的 zhipu——后台任务必须跟随主会话 model；② 工程侧：fire-and-forget 任务必须检查 stopReason=error，否则假 done 比真失败更隐蔽。
64. 后台任务若绑 uiContext，审批弹窗会弹到主窗口且无人响应 → 任务永久卡 running；不绑则护栏自动拒绝——后者才是后台任务的正确语义。
65. 排查 LLM 空响应的真值链：任务面板显示（会撒谎）→ 事件日志（半真）→ **session jsonl 文件里的 errorMessage 字段（真值）**；401 错误详情只在那里。

## P2 第一批：full-auto 护栏 + 安全审计日志 ✅（v0.25.0）

P2 沙箱项的务实落地（pi API 层无沙箱，先堵 full-auto 裸奔）：

| 项目 | 状态 | 说明 |
|---|---|---|
| **危险命令护栏**：RISKY 正则扩至 20 条（新增 git reset --hard / git clean -f / stop-computer / restart-computer / iex / downloadstring / irm\|iex 管道下载执行等）；**full-auto 模式下 RISKY 命中仍强制弹确认且不记忆**，弹窗标题「⚠ 危险命令确认」，拒绝即 block；普通命令 full-auto 照旧直通（不伤流畅） | ✅ | 确认/拒绝路径均写审计；unknown 工具照旧弹窗 |
| **安全审计日志**：所有非只读工具调用落 `~/.pi/agent/audit/<日期>.jsonl`（ts/session/tool/mode/decision/input摘要≤200字）；decision 四态：auto-allow / confirmed / blocked / risk-confirm；失败不阻断执行 | ✅ | 与反撒谎真值体系天然一对：事后可查 Agent 到底跑过什么 |
| **审批模式文案**：确认弹窗按档位/危险度区分标题与说明 | ✅ | |

**E2E**：`scripts/e2e-p29.mjs`（12 项断言：普通命令直通无弹窗、靶目录创建、RISKY 触发「危险命令确认」弹窗（MutationObserver 事件化捕获+自动批准，不与人竞速）、批准后目录删除、审计三态记录与字段完整性；截图 p29-guard.png）

**踩坑**：
59. 审批弹窗**不是** mini-modal——`ctx.ui.confirm` 走 `ui_request` 事件 → `uiModal()` 动态创建 `.modal-mask`（按钮 `.ui-ok`/`.ui-no`，用完即移除）；mini-modal 只管重命名/输入类。盯错元素断言恒假。
60. `fixed` 定位元素 `offsetParent` 恒为 null——用 `offsetParent !== null` 判可见必假；动态创建用完即删的元素，`存在即可见`。
61. E2E 弹窗断言与人竞速必输（用户手速 > 90s 轮询）：改 MutationObserver 事件化捕获（dataset 防重 + 延时自动点击），断言从“轮询窗口内是否可见”变为“弹窗是否发生过”。
62. bash -e 内嵌反引号模板会被 shell 命令替换吞掉（`await ev()` 变空）——生成/重写含反引号代码用 write 工具，不走 bash 字符串拼接。

## P1 收尾：MCP 桥 ✅（v0.24.0）

P1 最后一项：pi SDK 无 MCP 客户端，用 extensions 机制自建桥，Agent 可接外部 MCP 生态工具。

| 项目 | 状态 | 说明 |
|---|---|---|
| **MCP 管理器**：读 `~/.pi/agent/mcp.json`（对齐 Claude Desktop / Codex 的 mcpServers 格式）→ 官方 SDK（@modelcontextprotocol/sdk 1.30）连接 stdio / streamable HTTP server → listTools → 每工具注册为 pi 工具（`mcp__<server>__<tool>`，Type.Unsafe 包装 JSON Schema）；连接/listTools 各 20s 超时，单 server 失败不阻断会话；全局共享连接，SDK 懒加载（未配置零开销） | ✅ | |
| **审批语义**：MCP 工具对审批扩展是「未知工具」→ readonly/auto-edit 弹确认、full-auto 放行——外部工具天然纳入既有审批体系，无安全缺口 | ✅ | 用户实测时点过弹窗（echo 工具首次调用），验证了链路 |
| **设置页状态卡**：server 列表（●绿已连接+工具数 / ✖红错误信息）+「↻ 重连全部」（新会话生效）；配置格式提示 | ✅ | |
| **E2E 夹具**：scripts/fixtures/mcp-echo-server.mjs（零依赖 stdio JSON-RPC server：initialize/tools/list/tools/call，echo+add 两工具），不依赖 npx 下载 | ✅ | |

**E2E**：`scripts/e2e-p28.mjs`（11 项断言：连接状态/工具数、Agent 感知 mcp 工具名、Agent 真实调用 echo 返回 ECHO:PING-42、调用后连接健康、设置卡片渲染、重连 API；全自动无人工点击；截图 p28-mcp.png）

**踩坑**：
55. 多块 edit 被整批拒绝后只重发了部分：renderMcpSection 调用行写入了但函数定义本体没写入（页面 ReferenceError/undefined）——每批编辑被拒后必须逐块核对重发，否则半接线最隐蔽。
56. heredoc 写 JSON 时 Windows 路径反斜杠（\U \A）非法转义致 JSON.parse 失败且被 catch 静默吞掉——用 printf + 正斜杠路径，写完必须 JSON.parse 自检。
57. MCP 工具在 auto-edit 档弹审批窗会阻塞 E2E——工具调用轮前先切 full-auto（select value + dispatchEvent change），保证 E2E 全自动。
58. pi 生态的 TypeBox 包名是 **typebox**（1.3.7，无 @sinclair 前缀）而非 @sinclair/typebox，且不在根 node_modules——从 agent-host 引用时需自装同版本。

## P1 第一批：checkpoint 回滚 + Git 分支保护 + @ 文件补全 ✅（v0.23.0）

对标 Codex 差距 P1 中三个纯本地功能（MCP 桥独立到 0.24.0，隔离外部依赖风险）：

| 项目 | 状态 | 说明 |
|---|---|---|
| **文件快照/回滚（checkpoint）**：内联 `checkpointExtension` 挂 pi `tool_call` 事件，edit/write 执行前快照目标文件（含 full-auto，与审批无关；快照失败不阻断工具）；存储 `~/.pi/agent/checkpoints/<sessionId>/manifest.jsonl` + `<ts>-<basename>`；snap=null 表示执行前文件不存在（回滚=删除）。回滚语义 = **恢复到 AI 首次碰它之前**（entries[0]，多轮编辑全撤）而非最后一次动作前。审核面板文件行出现「⏪」按钮（仅 AI 碰过的文件有），确认后恢复 + sysline | ✅ | 修 bug：snapshotFile 误用 `this.session.workspace`（pi session 无此字段，应为 AgentHost 的 `this.workspace`）→ path.join(undefined) 抛异常被 try 吞掉，快照静默失效 |
| **Git 分支保护**：审核面板新增「🌿 保护分支」（工作区必须干净；当前在 main/master 时切到 `openpi/agent-<时间戳>`）+「⇥ 合并主分支」（仅在 openpi/* 分支显示；自动找 main/master 基线，merge --no-ff，冲突则提示终端 git merge --abort） | ✅ | 保护 full-auto 场景下主分支不被改坏 |
| **@ 文件引用补全**：composer 输入 `@` 弹工作区文件菜单（复用 slash 菜单模式：token 检测/↑↓/Enter/Tab/Esc/mousedown，与技能菜单互斥）；数据源 `files:flat` IPC（git ls-files -co --exclude-standard 优先，非 git 目录手写递归兜底，跳过 node_modules/.git 等，上限 800），60s 缓存；含空格路径自动加引号 | ✅ | |

**E2E**：`scripts/e2e-p27.mjs`（23 项断言：checkpoint 双场景 = AI 新建回滚即删 + 预置文件被改回滚恢复 V0、审核面板 ⏪ 按钮计数、保护分支→提交→合并回 main 全链路、@ 补全三步；截图 p27-p1.png）

**踩坑**：
52. 快照扩展静默失效排查套路：先看 tool_call 是否触发（审批扩展的 stderr 日志可当探针）→ 再查目录是否创建 → 最后怀疑字段名：AgentHost 的 workspace 是自有字段，pi 的 session 对象上没有（`this.session.workspace` = undefined，path.join 直接 throw 被 try 吞）。
53. E2E 断言 UI 按钮要在**状态仍成立时**做：回滚后文件与 HEAD 一致 → porcelain 干净 → 文件行都不渲染，事后断言必然落空；且回滚语义下「AI 新建文件回滚=删除」是正确行为，断言不能写成“内容回到旧值”。
54. E2E 仓库身份配置（git config user.name/email）必须幂等地设在 init 块外——仓库是上轮 E2E 建的话 init 不执行，gitCommit 会炸 Author identity unknown。

## P0 对标 Codex：系统通知 + AGENTS.md 呈现 ✅（v0.22.0）

用户需求：对标 Codex 找差距。盘点结论：核心 agent 能力已追平或反超（压缩+80% 自动接力、多模型、电脑控制、办公技能、会话树均领先），真实缺口在"产品化外壳与安全边界"。P0 清单执行时发现：变更面板（审核 dock）**此前版本已实现**（状态/diff/还原/提交全套），不重复造，纳入回归；实际新做两项：

| 项目 | 状态 | 说明 |
|---|---|---|
| **P0-1 审核 dock 回归**：git 变更列表 + 逐文件 diff 展开 + 还原/提交按钮，探针文件全链路验证 | ✅ | 已有功能，12 项断言中 5 项回归 |
| **P0-2 系统通知**：main 进程 Notification + `app:notify` IPC（点击通知聚焦窗口）+ `app.setAppUserModelId("dev.openpi.desktop")`（Windows toast 来源标识）；渲染层 agent_settled 时 `document.hidden` 才弹（前台不打扰），标题带会话名 | ✅ | 长任务可切走，完成不必盯屏 |
| **P0-3 AGENTS.md 呈现**：查证 pi 内核**原生支持** AGENTS.md/CLAUDE.md（全局 + 工作区向上 + override），桌面版此前不可见。agent-host 新增 `contextFiles()` 直接调 pi 的 `loadProjectContextFiles`（与内核同一实现零偏差）→ `ctx:agentsFiles` IPC → composer `📜 AGENTS×N` chip + dock 新 tab「📜 指令」pane（文件列表/系统编辑器打开/重新扫描）+「🪄 让 Agent 生成/更新 AGENTS.md」按钮（预置中文摸底指令走 sendText） | ✅ | |

**E2E**：`scripts/e2e-p26.mjs`（12 项断言：审核 dock 5 项回归 + notify 通道 + AGENTS.md 清单/chip/面板/生成按钮 6 项；截图 p26-agents.png）

**剩余差距**（未排期）：P1=文件快照回滚/checkpoint、MCP 客户端（pi SDK 无，需自建桥）、Git 产品化分支保护；P2=执行沙箱（full-auto 裸奔）、并行任务/best-of-n（依赖 subagent 基建）。

## 内置办公技能：docx/pdf/pptx/xlsx + skill-creator 随包自带 ✅（v0.21.1）

用户需求：办公基础技能软件自带，装完即有。技能源取自本机 ZCode 官方插件缓存（document-skills 0.1.0 + skill-creator 0.1.0）。

| 项目 | 状态 | 说明 |
|---|---|---|
| **资源入库**：resources/skills/{docx,pdf,pptx,xlsx,skill-creator}（含各自 LICENSE.txt，共 ~2.2MB），asarUnpack 随包分发 | ✅ | 开发模式直接用项目根 resources/skills |
| **skill-creator 本土化改写**：原版是 ZCode 语境（.zcode/skills 目录规则、/skill 命令等），照搬会教 Agent 往错误位置建技能——已改写为 pi/OpenPi Desktop 语境（~/.pi/agent/skills 主位置、新会话才注入技能提示词、composer / 菜单强载、description-zh 扩展字段、无 description 不加载）；frontmatter 无 license 字段，纯方法论文档，改写无许可障碍 | ✅ | |
| **启动自动部署**：ensureOfficeSkills() 把缺失的技能复制到 ~/.pi/agent/skills/ 并注入 description-zh（中文描述供列表与触发判断）；已装/已忽略的不覆盖 | ✅ | 部署在 whenReady 内同步执行，毫秒级 |
| **删除不复活**：用户删除内置技能时记入 .office-dismissed.json 忽略名单，重启不骚扰；officeReinstall 重装时自动清名单 | ✅ | skills:delete 钩子 + scan/reinstall 联动 |
| **设置页状态卡**：技能 tab 显示 4 个内置技能状态（✓/○/已忽略）+「修复（覆盖重装全部）」按钮 | ✅ | skillsOfficeScan / skillsOfficeReinstall IPC |
| **许可口径**（如实记录）：技能 LICENSE 为 Z.ai 专有（仅限个人/教育/非商业使用，禁商业性分发），随免费安装包非商业分发、版权文件原样保留；若日后商业化需换 Apache-2.0 同源原版（anthropics/skills）或取得授权 | ⚠️ 决策 | 用户拍板：办公基础技能必须自带 |
| **打包 v0.21.1** | ✅ | Setup + portable |

**E2E**：`scripts/e2e-office-skills.mjs`（清环境→重启→12 项断言：5 技能自动部署+中文描述、UI 卡片 5 行全 ✓、重装 API、dismissed 识别与清除、技能列表含内置项；证据 p25-office.png）

**变更**：删除 scripts/install-office-skills.mjs（硬编码他人用户路径且功能已被内置部署完全取代）。

**新增踩坑记录**
46. cpSync 源在 asar 内不可靠：随包资源进 asarUnpack，运行时从 process.resourcesPath/app.asar.unpacked 取；双路径判断必须先查 unpacked 再查项目根（开发时 process.resourcesPath 指向 node_modules/electron/dist/resources）。
47. node 16 的 --check 把 .mjs 当 CJS 解析（import 直接报错），不代表语法问题——语法检查用 node-lts 22。
48. 引入外部技能不能原样照搬：skill-creator 原版教的是 ZCode 目录规则与命令，照搬会让 Agent 在错误位置建技能——自带前先核对技能正文与自身机制是否一致，不一致必须本土化改写（纯文档技能无许可障碍，有 LICENSE 声明的除外）。
49. E2E 前置状态自检：应用 localStorage 会记住「不在项目中工作」任务模式（workspace=null）→ E2E 开头检测并 resetChat+startSession(默认工作区)；默认工作区目录可能从未创建（mkdirSync recursive）；可能是非 git 目录（init -b main + 空基线 commit，否则 diff HEAD 无基线）。
50. 审核面板 diff 断言要按文件名定位行（列表按 porcelain 序，AGENTS.md 会排在时间戳探针前盲取首行必点错）+ 轮询等 pre 展开（900ms 固定 sleep 撞上游渲染时序偶发空 diff）。
51. node -e 里 CDP({...}) 返回 Promise 必须 await，否则 Runtime.enable 直接炸（chrome-remote-interface 构造器是异步工厂）。

## 上下文接力：占用过阈值自动切新会话继续 ✅（v0.20.0）

用户需求：上下文满了自动切换新会话，任务不中断。三层真值闭环：元素定位 → 控件落点 → （本版）会话级接力。

| 项目 | 状态 | 说明 |
|---|---|---|
| **agent-host.handoff()**：old.compact() 取 {summary, tokensBefore} → start() 同工作区/同模型/同思考级开新会话；摘要为空时抛错，渲染层保留原会话不换 | ✅ | compact 返回 CompactionResult{summary,tokensBefore} 直接可用 |
| **IPC + preload**：agent:handoff / window.openpi.handoff() | ✅ | |
| **渲染层触发器**：updateCtxBar 存 state.ctx={pct,used,win}；agent_settled 时 maybeAutoHandoff()：pct≥80%（HANDOFF_PCT，赶在 pi 原生压缩线 ~89.6% 前）且非 streaming/非 busy 才触发；三态 op-handoff（auto/ask/off）+ 顶栏 handoff-select 下拉；ask 用 uiModal 确认，拒绝则 pct=0 本会话不再问 | ✅ | handoffBusy 防重入；接力后 ctx=null、usageTotal 清零 |
| **接力动作**：旧会话标题解析 ` · 接力N` 计数 → 新会话 meta 标题 `xxx · 接力N+1` + sessionsMetaSet；sysline 报告；种子消息走 sendText(全文, [], 短胶囊)——摘要全文注入但只显示胶囊，不打屏 | ✅ | 标题「(空会话) · 接力1」实测 |
| **E2E**：scripts/e2e-handoff.mjs —— 3 轮真实消息铺垫 → 强制 ctx=95% 触发 → 断言 sessionId/会话文件已换、胶囊、sysline、标题接力N、旧会话在侧栏、ctx 重置为真实占用 | ✅ | 13/13 硬断言全过 + 暗号 ZEBRA-7391 随摘要跨会话（摘要忠实度）PASS；证据 p24-handoff.png |
| **打包 v0.20.0** | ✅ | Setup + portable |

**关键读码结论**（pi chunk-JVUZSMYM.js）：
- `prepareCompaction`：findCutPoint 从尾部往前累计估算 token（**estimateTokens2=字符数/4，不分语言**），够 keepRecentTokens（**默认 2e4**）即停，**切点必须落在条目 0 之后**——切点前的内容才拿去生成摘要；单轮会话无论多大都返回空 → `Nothing to compact (session too small)`
- `shouldCompact2`：tokens > window - reserveTokens（128k 窗即 ~89.6%）——这是**原生自动压缩线**；手动 compact 只要 prepareCompaction 通过就执行，不受此线约束
- 接力线 80% 设计依据：必须赶在原生压缩线之前，否则原生压缩先动手，接力永远轮不到

**新增踩坑记录**
42. pi compact 拒绝单轮会话：无论内容多大（实测 111k/128k 也拒），切点算出来是 0 就报 session too small——E2E 必须铺垫 ≥3 轮且倒数第二轮累计估算 token 跨过 keepRecentTokens(2万)，实测每轮 ~7.1 万字符×3 稳定触发。
43. E2E 用 CDP Runtime.evaluate 往页面注入模板字符串代码时，外层模板字面量会把 `\n` 解释成真实换行注入页面双引号字符串 → SyntaxError；页面侧用 `Array.from().join()` 构造长文本，不手写 `\n`。
44. 本机无 rg 命令（Git Bash），`rg -l ... || find ...` 的 rg 静默失败会让 find 结果误导排查——确认工具存在再用。
45. 接力瞬间 ctx 归零后，种子回复的 usage 事件马上写入新会话真实占用——E2E 断言「ctx===null」必败（时序），应断言 win>1000 且 pct 小（强制值 {win:1} 已消失）。

## 桌面控制精准化：UIA 元素定位 + 程序化回读 ✅（v0.19.1）

| 项目 | 状态 | 说明 |
|---|---|---|
| **computer_elements 工具**（第 11 个）：UIA 枚举窗口元素（类型/名称/中心点精确坐标/禁用态，≤200 个；省略 pid=前台窗口）——Agent 用元素坐标点击，不再从截图猜像素 | ✅ | 真实记事本枚举 69/110 控件，Document「文本编辑器」拿精确坐标 |
| **computer_read 工具**（第 12 个）：读焦点控件文本（ValuePattern→TextPattern 兑底，400 字截断）——输入后程序化回读验证，比截图更硬 | ✅ | 回读含标记文本 ✓；自绘控件不支持时回退截图 |
| **click 控件级落点**：原报窗口 pid → 现加 AutomationElement.FromPoint 命中控件类型+名称 | ✅ | click 落点=Document「文本编辑器」 |
| **type/focus 焦点控件回传**：paste/focus 结果加 feType/feName，文字进了哪个控件一目了然 | ✅ | focus→Document「文本编辑器」 |
| **部署**：resources → ~/.pi/agent/extensions/computer-use/ 已同步，新会话生效 | ✅ | |
| **打包 v0.19.1** | ✅ | Setup + portable |

**E2E**：`scripts/test-cu-elements.mjs`（daemon 直连免起 Electron，真实记事本 10 项断言全过；证据 cu-elements-proof.jpg）

**新增踩坑记录**
38. UIA 元素枚举必须过滤 IsOffscreen/空矩形/无名非可交互控件，否则 Chrome 等大窗口一次返回数千元素撑爆模型上下文；控件名要压平换行并截断。
39. Win11 记事本是多 tab 单进程：spawn 新实例会并入已有进程（标题带 * 未保存标记），`taskkill /T /F` 会连带杀掉用户已开的 tab——测试断言别依赖「全新窗口」。
40. 传递依赖漂移：@noble/hashes 升到 2.x 后变 ESM-only，electron-builder 的 require() 直接炸——package.json 用 `overrides: {"@noble/hashes": "1.8.0"}` 钉住即愈。
41. 本机 PATH 首个 node 是微信开发者工具的 16.13.1（无 readline/promises），electron-builder 跑不起来——用 `%LOCALAPPDATA%\node-lts\node-v22.14.0-win-x64\node.exe` 全路径跑；ELECTRON_RUN_AS_NODE=1 + electron.exe 当 Node 会撞 default_app.asar 校验，不可行。

## 电脑控制反撒谎改造 ✅（v0.19.0，用户实测 Agent 假报成功）

用户实测「打开记事本输入 123」Agent 假报完成但记事本是空的。根因：type/click 是盲操作，不验证落点。

| 项目 | 状态 | 说明 |
|---|---|---|
| **聚焦多策略**：Alt 解锁 → WScript AppActivate → 最小化再还原（后者最可靠），每次都回 verified 真值 | ✅ | E2E 真实记事本 verified=true |
| **type 防RYPT盲粘**：新增 pid 参数，先聚焦验证，失败直接抛错拒输入；粘贴落点回传（targetPid/target/title），粘到 OpenPi 自己窗口也报错 | ✅ | E2E 落点=记事本 pid ✓ |
| **click 落点报告**：WindowFromPoint 拿实际命中窗口所属进程，Agent 能看到点偏没点偏 | ✅ | |
| **工具描述铁律**：「未截图验证不得宣称完成」写入 computer_type 描述与 promptGuidelines | ✅ | |
| **踩坑 #36**：daemon.ps1 必须 UTF-8 with BOM（PS 5.1 无 BOM 按 GBK 读，中文注释乱码破坏语法）；#37：本机 PATH 里 Git 的假 notepad 抢在 System32 前面，脚本必须用显式路径 | ✅ | |
| **打包 v0.19.0** | ✅ | Setup + portable |

**E2E**：`scripts/e2e-p23.mjs`（真实记事本全链路：聚焦→粘贴→落点校验→截图→假 pid 拒绝）

## / 技能引用菜单 + 办公技能 + 中文描述 ✅（v0.18.0）

| 项目 | 状态 | 说明 |
|---|---|---|
| **办公技能安装**：docx/pdf/pptx/xlsx 从本机 ZCode 官方插件缓存导入 pi 技能库（带完整脚本/references/模板，非摆设） | ✅ | `scripts/install-office-skills.mjs` 可重复跑；docx 658K/pdf 1.2M/xlsx 324K 含 scripts |
| **中文功能描述**：SKILL.md frontmatter 新增 `description-zh` 字段；skills:list 解析；技能页 + / 菜单优先显示中文（悬停看英文原文），搜索中英文都命中 | ✅ | 4 个办公技能已全部注入中文 |
| **/ 技能引用菜单**（对标 ZCode slash 弹层）：输入 / 弹出技能列表（名称+描述），过滤、↑↓/Enter/Tab 选择、Esc 关闭；选中填入 `/技能名 `；发送时自动展开为「请使用「xx」技能完成以下任务：」确保 Agent 必定感知 | ✅ | E2E：/doc → docx 选中 → /docx ；展开验证 ✓ |
| **打包 v0.18.0** | ✅ | `dist/OpenPi Desktop Setup 0.18.0.exe` / portable |

**注意**：办公技能首次使用时 Agent 会按 SKILL.md 指引跑 setup.sh 装依赖（需 Python 环境）。技能变化对**新会话**生效。

**E2E**：`scripts/e2e-p22.mjs`（证据 p22-skills-zh.png / p22-slash-menu.png）

## 电脑控制重写 + 技能 GitHub 安装 + tab 拆分 ✅（v0.17.0，用户真实使用反馈）

用户实测反馈的三个问题全部修复：① 截图工具真故障（Agent 靠 PowerShell 兕底才成功）② 点击「被 pi 窗口挡住」（后台进程 SetForegroundWindow 被前台锁拒）③ 打字「没有新建没看到写入」（焦点错 → Ctrl+V 粘到别处）。

| 项目 | 状态 | 说明 |
|---|---|---|
| **tab 拆分**：「技能与能力」→「技能」+「电脑控制」两个独立 tab，后者带 9 工具清单和聚焦提示 | ✅ | E2E ✓ |
| **常驻 daemon 重写**：每次冷启动 PowerShell（1~2s/次）→ 常驻进程 stdin/stdout JSON 行协议，操作后 ~100ms；崩潰自动重启+重试 | ✅ | 实测 8 操作含冷启动共 1.7s |
| **截图修复+提速**：4K 全屏 PNG（~388KB）→ 缩放宽≤1600 的 JPEG（~155KB），超时/坏行重试；支持区域截图参数 | ✅ | E2E：154KB JPEG ✓ |
| **聚焦修复（关键）**：focus 前先模拟 Alt 键击破解 Windows 前台锁，置前后验证返回 verified；工具描述强制 Agent「先 focus 再 type/click」 | ✅ | daemon 单测 verified 输出 |
| **新能力**：computer_drag（拖拽）/ computer_clipboard（读写剪贴板）/ computer_focus（置前+验证）/ 区域截图；工具总数 7→10 | ✅ | E2E：10 工具全注册 |
| **技能 GitHub 真实安装**：贴仓库地址（可带 /tree/branch/subdir）→ API 取默认分支 → codeload 下载 zip → Expand-Archive → 递归找 SKILL.md → 装入技能库；同名跳过 | ✅ | E2E：pi-skills 仓 8 技能 1.7s 真实装完 |
| **打包 v0.17.0** | ✅ | `dist/OpenPi Desktop Setup 0.17.0.exe` / portable |

**E2E**：`scripts/e2e-p21.mjs`（证据 p21-tabs.png / p21-installed.png）

**新增踩坑记录**
34. Windows 前台锁：后台进程 SetForegroundWindow 会被拒（窗口切不过去，后续打字/点击全落到原前台窗口）——经典解法：SetForegroundWindow 前模拟 Alt 键按下+松开，再用 GetForegroundWindow 对比验证。
35. 常驻子进程行协议易错点：分隔符长度（@R@ 是 3 字符不是 4）、JSON 坏行要 catch、stdin.write 前先注册 pending；E2E 前要归零开关状态（上次残留会让 click 变成「关闭」）。

## 技能管理 + 电脑控制 ✅（v0.16.0，对标 ZCode）

| 项目 | 状态 | 说明 |
|---|---|---|
| **技能管理页**（设置 →「技能与能力」tab） | ✅ | 扫描三组：已安装（`~/.pi/agent/skills/`，可启停可删）/ 已停用（`skills-disabled/`）/ 外部来源（`~/.agents/skills`，只读）；搜索过滤；↻ 重扫 |
| **技能新建**：表单（名称+描述）→ 生成标准 SKILL.md 骨架；pi 规则同步（无 description 不加载；名称规则校验） | ✅ | E2E：创建/落盘/列表/删除（回收站）全过 |
| **启停机制**：pi 无原生开关 → 目录移动 `skills` ⇄ `skills-disabled`（新会话生效） | ✅ | E2E：关→已停用组+目录移动，开→回来 |
| **电脑控制**（对标 ZCode computer-use 插件）：内置 pi 托展，纯 PowerShell+user32 零依赖；设置页开关 → 安装/移除 `~/.pi/agent/extensions/computer-use/` | ✅ | E2E：开关安装/移除，状态文案「● 已连接并可用」 |
| **7 个工具**：computer_screenshot（PNG 回传给模型看）/ _click（左/右/中/双击）/ _type（剪贴板+Ctrl+V，支持中文）/ _key（组合键含 win）/ _scroll / _windows（列出/置前）/ _wait | ✅ | E2E：真实新会话 getAllTools 全部注册 |
| **截图管线真实验证**：同款 PowerShell 独立运行 → 388KB 合法 PNG | ✅ | PNG 复正确 |
| **打包 v0.16.0**（resources/**/* 已入构建清单） | ✅ | `dist/OpenPi Desktop Setup 0.16.0.exe` / portable |

**E2E**：`scripts/e2e-p20.mjs`（证据 p20-skills-page.png）

**新增踩坑记录**
32. main.mjs（ESM）的 `__dirname` 指向 `src/main`，访问应用根下 resources 要两级 `..`；electron-builder files 需显式包含 `resources/**/*`，asar 内源文件可被 `copyFileSync` 读出。
33. PowerShell 子进程结果不回 stdout（避免编码坑）：脚本给 `$cuResult` 蒙值 → 写 UTF8 临时文件 → Node 回读；-Sta 开关保证剪贴板/SendKeys 可用；-EncodedCommand（UTF16LE base64）规避引号转义。

## 预览 pane 升级为内置浏览器 ✅（v0.15.0）

| 项目 | 状态 | 说明 |
|---|---|---|
| **定位重定义**：开发服务器监视器 → 内置浏览器（网页浏览 / 代码生成物预览 / dev server 实时预览三层） | ✅ | |
| **地址栏可输入**：任意网址（补协议）/ Windows 绝对路径→file:// / 相对文件名→自动拼当前工作区；path-ish 判定避免裸域名误判 | ✅ | E2E：4 种规范化全对 |
| **后退/前进**：webview goBack/goForward，按导航历史自动置灰 | ✅ | E2E：后退→第1页→前进→第2页 |
| **历史 chips**：导航过/探测到的地址记入 chips（≤8，点击回访）；多服务不抢当前页面 | ✅ | E2E：chips 条数 2 |
| **生成物探测**：Agent 输出中的 html/图片/pdf 绝对路径 → 自动打开预览（首次自动弹 Dock） | ✅ | E2E：探测→自动弹预览 |
| **文件 tab 🌐 按钮**：html/图片/pdf 等可预览文件 → 一键在内置浏览器打开（修掉二进制文件只能看 "(binary)" 的问题） | ✅ | E2E：文件→预览跳转 |
| **打包 v0.15.0** | ✅ | `dist/OpenPi Desktop Setup 0.15.0.exe` / portable |

**E2E**：`scripts/e2e-p19.mjs`（证据 p19-browser.png / p19-files-preview.png）

**新增踩坑记录**
31. 相对文件名规范化要有 path-ish 判定（含分隔符或已知扩展名），否则裸域名 example.com 会被当成工作区文件拼成 file://。

## 命名修正 + 顶栏精简 ✅（v0.14.0，按用户标注图）

| 项目 | 状态 | 说明 |
|---|---|---|
| **「任务」→「聊天」** | ✅ | 对照 ChatGPT/Codex 的双模式区分（ChatGPT=创建学习探索 / Codex=构建调试发布）：我们按「是否绑定本地项目」区分，语义等价——聊天≈ChatGPT、项目≈Codex；但「任务」听起来像待办工作项，改「聊天」更贴切，「项目」保留 |
| **顶栏三按钮移除**（🌐 预览 / 🔍 审核 / ⧉ 新窗口） | ✅ | 预览/审核由 Dock 标签 + 分支 chip + 快捷键（Ctrl+T / Ctrl+Shift+G）承接；新窗口保留 Ctrl+= 快捷键 |
| **预览被动打开闭环**：Agent 输出中首次检测到本地服务 → 自动弹出 Dock 预览标签 | ✅ | E2E：maybeDetectPreview → Dock 自动弹预览 |
| **打包 v0.14.0** | ✅ | `dist/OpenPi Desktop Setup 0.14.0.exe` / portable |

**E2E**：三按钮移除后其余按钮完好；分支 chip→审核、Ctrl+T→预览、Dock 标签直点均可达

## 项目/任务彻底区分 + 工作区选择器 ✅（v0.13.0，按用户标注图）

| 项目 | 状态 | 证据 |
|---|---|---|
| **工作区选择器**（输入框左下角 📁 chip 点击弹出，ZCode 式）：搜索工作区 / 已知项目列表（会话历史去重，按最近使用排序，当前项 ✓）/ 🗂 打开文件夹（系统对话框可新建）/ 💬 不在项目中工作 | ✅ | E2E + `p17-1-picker.png`：弹出/搜索过滤/外点关闭/选中切项目全过 |
| **任务模式**：`workspace=null` 贯穿 main/agent-host/渲染层（不再回退默认工作区）；chip 显示「💬 不在项目中工作」；会话元数据打 `task:true` 标记（存 openpi-meta.json） | ✅ | E2E：state.session.workspace=null、chip 文案、meta 标记 |
| **项目/任务互不重合**：会话按 task 标记二选一归入 tab——项目 tab 只有绑定工作区的会话，任务 tab 只有普通聊天；搜索仍跨两类 | ✅ | E2E：任务会话「hello-task-check」在任务 tab 有、项目 tab 无 |
| **会话身份同步**：发现 SDK 在首条消息落盘前 sessionId 不稳定（返回 id ≠ 文件 head.id）→ 新增 `agent:info` IPC，`agent_settled` 后同步真实 id + 补 task 标记 | ✅(代码+E2E) | meta 中 task id 与磁盘文件 id 一致 |
| **打包 v0.13.0**（NSIS + portable） | ✅ | `dist/OpenPi Desktop Setup 0.13.0.exe` / `dist/OpenPi Desktop 0.13.0.exe` |

**E2E**：`scripts/e2e-p17.mjs`

**新增踩坑记录**
29. pi SDK 新会话在首条消息发出前不落盘，且返回的 `sessionId` 在落盘前后会变（UI id ≠ 文件 head.id）——依赖会话 id 做持久化关联时，必须在 `agent_settled` 后用实时 `session.sessionId`（SessionManager getter）重新对账。
30. 元数据分类（task 标记）存自有 openpi-meta.json（listSessions 时合并），不动 pi 会话文件。

## UI 修正：侧栏 项目/任务 双 tab + 去重新会话入口 ✅（v0.12.0，按用户标注图）

| 项目 | 状态 | 证据 |
|---|---|---|
| **侧栏「分组」→「任务」**：任务 = 普通聊天（平铺列表、无 📁 项目徽标、置顶区保留）；项目 = 会话按本地工作区分组（去掉原「最近」混杂平铺区）；无工作区会话在项目 tab 底部归入「📝 普通聊天（无项目）」 | ✅ | E2E + `p16-sidebar-tasks.png` / `p16-sidebar-projects.png` |
| **去掉重复新会话入口**：移除顶栏「＋ 新会话」，保留侧栏「✏️ 新对话」（ChatGPT/Codex 风格主入口）；Ctrl+N / 项目组「＋」不受影响 | ✅ | E2E：btn-new 不存在、btn-new-side 开新会话正常 |
| **打包 v0.12.0**（NSIS + portable，asar 内容验证含全部改动） | ✅ | `dist/OpenPi Desktop Setup 0.12.0.exe` / `dist/OpenPi Desktop 0.12.0.exe` |

**E2E**：`scripts/e2e-p16.mjs`

> 注：P3「侧边聊天」按用户指示取消，不做。

## P1.5：终端历史 + 文件树自动刷新 + 打包 v0.11.0 ✅

| 项目 | 状态 | 证据 |
|---|---|---|
| **终端历史 ↑↓ 翻阅**：上下键在历史命令间导航，底部时保留正在输入的草稿；localStorage 持久化（≤100 条，跨会话可用） | ✅ | E2E：↑↑/↓↓ 导航正确、草稿保留还原、localStorage 落盘 |
| **文件树自动刷新**：主进程 `fs.watch(recursive)` 监听工作区（忒掉 .git/node_modules 噪声，500ms 防抖），Agent/终端/外部改动 → `fs:changed` → 渲染层失效缓存 + **保留展开状态**重染；面板没开则下次打开自动取新；顺手联动审核角标（bash 工具改文件也能触发） | ✅ | E2E：面板开着时外部写入根/子目录文件均自动出现、展开态保留、删除后自动收敛、角标计数同步 |
| **打包 v0.11.0**：NSIS 安装包 + portable，asar 内确认含全部新代码 | ✅ | `dist/OpenPi Desktop Setup 0.11.0.exe` / `dist/OpenPi Desktop 0.11.0.exe` |

**E2E**：`scripts/e2e-p15.mjs`（终端历史 / 文件树自动刷新 / 角标联动，全链路实机验证）

**新增踩坑记录**
27. electron-builder 需要联网拉 winCodeSign 等二进制，GitHub 直连会超时——设置 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 与 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后构建正常。
28. 懒加载文件树的缓存必须能被外部事件失效：打开面板时强制 readdir 根目录（不信任旧缓存），否则"建目录→立即开面板"的窗口内会看到旧列表。

## P1：终端标签 + 文件标签 + 面板开关 ✅（v0.10.0，对标 Codex 桌面版）

| 项目 | 状态 | 证据 |
|---|---|---|
| **右上角「显示/隐藏侧边面板」按钮**（▤，对标 Codex Ctrl+Alt+B）：关闭后再开恢复上次的标签 | ✅ | E2E：开→关→开，恢复 review 标签；`Ctrl+Alt+B` 同效 |
| **终端标签**（Dock 第 3 个 tab）：工作区内独立执行命令，stdout/stderr 流式回传 + 退出码；■ 终止（Windows `taskkill /T /F` 杀进程树）/ Ctrl+C / 🧹 清空 | ✅ | `p1-2-terminal.png`：echo + ping 输出 + `[进程退出 · 码 0]`，长命令终止成功 |
| **终端中文乱码修复**：Windows 下 `chcp 65001` 包裹命令，GBK→UTF-8 | ✅ | ping 中文输出乱码 → 干净英文/UTF-8 |
| **文件标签**（Dock 第 4 个 tab）：懒加载文件树（忽略 node_modules/.git/dist 等，每层≤500）、📁折叠、🔍 文件名递归搜索（≤50 结果）、点击文件只读预览（256KB 截断 + 二进制检测）+ ← 返回 | ✅ | `p1-3-fileview.png` / `p1-3-search.png`：展开 p1sub → 预览 nested.md → 搜索 p1demo.txt |
| **快捷键补齐**：`Ctrl+P` 文件标签+聚焦搜索框、`Ctrl+T` 预览标签、`Ctrl+Alt+B` 面板开关 | ✅ | E2E 全过 |
| 竞态防御：极短命令的 exit 事件可能先于 IPC invoke 返回 → `termRunningId` 占位方案 | ✅(代码) | `termExec` |

**E2E**：`scripts/e2e-p1.mjs`（面板开关 / 终端 echo+长命令终止 / 文件树展开+预览+搜索 / 三个快捷键，全链路实机验证）

**新增踩坑记录**
25. Windows cmd 子进程输出默认 GBK，UTF-8 解码必乱码——spawn 时用 `chcp 65001>nul && <cmd>` 包裹即可（子进程会继承 UTF-8 代码页）。
26. CDP `Input.dispatchKeyEvent` 对 Ctrl+Alt 组合（Windows AltGr 语义）注入不可靠，验证快捷键用页面内合成 `KeyboardEvent`。

## P0：右侧 Dock（标签坞）+ Codex 式审核面板 ✅（v0.9.0，对标 Codex 桌面版）

> 对标来源：Codex 桌面版右侧面板（审核/终端/浏览器/文件/侧边聊天标签 + 快捷键）

| 项目 | 状态 | 证据 |
|---|---|---|
| **统一右侧 Dock 容器**（标签页：🔍 审核 / 🌐 预览，✕ 关闭，同一容器互斥切换） | ✅ | `p0-3-diffs.png`：右侧标签坞，原独立预览面板已整体迁入 |
| **审核 pane**（原 Git 弹窗升级为常驻面板）：分支行 / 变更列表（状态着色）/ 点击展开逐文件 diff / 一键提交全部 | ✅ | `p0-1-review.png`：main 分支、2 个变更、角标计数 2 |
| **审核角标**：Agent 调 edit/write 后自动刷新计数徽标（`tool_execution_end` + `agent_settled` 双钩子，600ms 防抖） | ✅ | E2E：变更项数 2 → 角标 "2" |
| **untracked 文件 diff**：纯 Node 生成干净伪 diff（`+++ b/相对路径` + 全 "+" 行，600 行截断，二进制检测） | ✅ | E2E：`--- /dev/null\n+++ b/p0-new.md\n@@ -0,0 +1,2 新文件 @@` |
| **单文件还原**：已跟踪 `git checkout HEAD --`；新文件移入回收站（可恢复），还原前 miniConfirm 确认 | ✅ | E2E：还原后变更项数 2→1，消息流「↩ 已还原」 |
| **快捷键 Ctrl+Shift+G** 切换审核面板（与 Codex 一致） | ✅ | 合成 KeyboardEvent 验证：preventDefault 触发 + 面板打开 |
| **「打开」按钮**：用系统默认程序打开变更文件（`shell.openPath`，路径白名单校验） | ✅(代码) | IPC `shell:open-workspace-file` |
| 顺手修复：渲染层 `state.session.workspace` 用入参（null）而非主进程回退后的默认工作区 | ✅ | E2E 首跑发现，已修 |

**E2E**：`scripts/e2e-p0.mjs`（造变更→开面板→逐文件 diff→标签互斥切换→快捷键→还原，全链路实机验证）

**新增踩坑记录**
22. CDP `Input.dispatchKeyEvent` 的 modifiers 是位掩码（Ctrl=2, Shift=1, Alt=4），Ctrl+Shift 要传 3；且部分快捷键用 `keyDown` 注入不触发时，可改用页面内合成 `KeyboardEvent` 验证处理逻辑。
23. E2E 跨多次运行时，前一个实例的 UI 状态（如 Dock 开着）会残留——重启实例后脚本不要用 `toggleXxx`，要用确定性的 `showXxx`。
24. git `--no-index` 对 Windows 路径输出的 diff 头是转义的绝对路径（`"a/C:\\Users\\..."`），不适合直接展示——untracked 文件自己生成伪 diff 更干净可控。

## M0 技术验证 ✅（2026-09-11 完成）

| 验证项 | 结果 | 证据 |
|---|---|---|
| SDK 内嵌（纯 Node） | ✅ | `npm run poc`：1365 模型目录 / 11 个鉴权可用 / 流式+工具+用量 |
| Electron 壳 | ✅ | Electron 44.3.0（内置 Node 24），进程组正常 |
| 渲染进程 UI | ✅ | `renderer-proof.png`：完整聊天界面 |
| 端到端对话（CDP 驱动） | ✅ | 用户消息→流式思考(296字)→回答→用量条 `in 1755 (cache 0) · out 93` |
| 自定义供应商零代码接入 | ✅ | zhipu + my-proxy 均来自 `models.json`，应用零改动 |
| 会话与 pi 生态互通 | ✅ | 会话文件写入 `~/.pi/agent/sessions/`，pi CLI/Desktop 可直接恢复 |
| Ollama 实机 | ⏸ 本机未运行；接入路径与 zhipu 完全相同（models.json），留 M1 实测 |

**踩坑记录**
1. `ELECTRON_RUN_AS_NODE=1`（pi Desktop 宿主环境注入）会让 electron.exe 变纯 Node → 启动脚本必须 unset。
2. CDP 调试端口 9222 被 Adobe UXP 占用 → 用 9333。
3. PrintWindow 对被遮挡/未刷新窗口截不全 → 用 CDP `Page.captureScreenshot` 从渲染器内部取证。

**代码**
- `E:/pi2/openpi-desktop/`（Electron + SDK，主进程 3 文件 + 渲染层 3 文件，共约 700 行）

---

## M1 MVP ✅（2026-09-11 全部完成）

| 项目 | 状态 | 证据 |
|---|---|---|
| 会话列表侧栏（扫 pi 原生 sessions 目录，预览+目录+相对时间） | ✅ | `m1-final.png`：侧栏 12 条历史，实时刷新（10→11→12） |
| 点击恢复历史会话 + 消息回放 | ✅ | 恢复后消息回显，活动项高亮 |
| Markdown 渲染（marked + DOMPurify + hljs 代码高亮） | ✅ | `m1-proof.png` / 打包版 `dist-proof.png` |
| edit 工具彩色 Diff 视图（`details.diff` 渲染加/减/块行） | ✅ | E2E-2: Diff卡×1，+2/-1 行，正是标题替换+追加 |
| write/read/bash 工具卡 | ✅ | 截图中 read 卡显示文件内容 |
| 状态栏 [object Object] 修复 | ✅ | 显示 `就绪 · glm-5.3-flash` |
| Token 缓存可观测 | ✅ | `in 4036 (cache 9728) · out 612` —— cache 命中 9728 |
| steer/followUp 队列徽标 | ✅ | queue_update → 计数显示 |
| **配置中心 L1**：API 密钥（auth.json, 0600，支持 $ENV 引用） | ✅ | E2E-3：zhipu/agnes 打码展示，状态灯，点击载入 |
| **配置中心 L2**：自定义供应商表单（4 种 API 协议 + compat 开关 + 测连通） | ✅ | zhipu 端点 ✓ 69ms·10 模型（真实密钥主进程解析，渲染层仅见打码值） |
| **配置中心 L4**：本地模型预设（Ollama/LM Studio/vLLM/llama.cpp） | ✅ | 一键填表+自动拉取已装模型；Ollama 未启动时正确报 ECONNREFUSED |
| 配置即契约：只写 Pi 标准文件，写前自动备份 .bak | ✅ | `src/main/config-store.mjs`；↻重载模型目录即时生效 |
| **electron-builder 打包** | ✅ | `dist/OpenPi Desktop Setup 0.2.0.exe`（NSIS 安装版）+ `OpenPi Desktop 0.2.0.exe`（便携版），各 205M |
| **打包产物 E2E** | ✅ | 便携版 exe 独立运行：11 模型发现 → 真实对话 → Python 代码块高亮 → 用量统计（`dist-proof.png`） |
| E2E 驱动脚本 | ✅ | `scripts/e2e.mjs` / `e2e-edit.mjs` / `e2e-config.mjs` / `e2e-dist.mjs` |

**新增踩坑记录**
4. write 工具无 `details.diff`（只有 edit 有）→ write 卡显示路径+内容即可。
5. CDP 驱动脚本必须写文件执行，内联到 bash 会被反引号/转义损坏。
6. Windows 上 Electron 44 内置 Node 24.20，pi engines 要求 ≥22.19，满足。
7. electron-builder v26 的 `win.target` 只接受字符串数组，`{target,archs}` 对象会被 schema 拒绝。
8. electron-builder 271 个依赖包，npm 装约 1 分钟，首次 `--win` 构建约 3 分钟。
9. 打包版支持 `--remote-debugging-port` 透传，可直接 CDP 驱动验证。

**代码规模**：主进程 3 文件 + 渲染层 3 文件 + vendor（marked/dompurify/hljs 本地化，CSP 允 'self'），约 1100 行。

## M2 完整版 ✅（2026-09-11 完成）

| 项目 | 状态 | 证据 |
|---|---|---|
| **危险命令审批**（内联扩展 + `bindExtensions({uiContext})` 桥接图形弹窗） | ✅ | E2E-5/7：`rm -rf hello.md` → 弹窗显示完整命令 → 「拒绝」→ agent 收到 block reason；「允许」→ 放行执行 |
| **会话树面板**（`sessionManager.getTree()` 精简渲染） | ✅ | 打包版截图 `m2-dist-proof.png`：6 节点（model_change/消息/工具/回复） |
| 树导航（`navigateTree` 同文件内分支切换 + 历史重放） | ✅(代码) | 面板点击节点已接线，SDK 官方方法；未单独 E2E |
| **上下文进度条**（in+cacheRead+cacheWrite / contextWindow，分档变色 + 触发线提示） | ✅ | `1.9k / 128k (1%) · 触发线 87%` |
| **手动压缩**（`session.compact()`） | ✅ | 链路通；空会话正确报 "Nothing to compact" |
| **HTML 导出**（`exportToHtml` → 下载目录 + `showItemInFolder`） | ✅ | 279KB 真实文件落在 `Downloads/openpi-exports/` |
| **会话改名**（`setSessionName`） | ✅ | `✏ 会话已改名: M2-E2E-测试会话` |
| 扩展 UI 图形化（select/confirm/input → 渲染层模态，5 分钟超时保护） | ✅ | 审批弹窗即走此通道 |
| 打包版 0.3.0 全量回归 | ✅ | 审批弹窗 + 放行执行 + 树面板全部在便携版 exe 中验证 |

**新增踩坑记录**
10. SDK 模式扩展 UI：`createAgentSession` 后调 `session.bindExtensions({mode:"tui", uiContext})`，宿主自行实现 `ExtensionUIContext` 的四个必须方法（select/confirm/input/notify）。
11. 内联审批扩展走 `DefaultResourceLoader({extensionFactories})`，是纯 JS 工厂不涉及文件扫描，打包 asar 后照常工作。
12. 便携版 exe 进程名是 "OpenPi Desktop"（非 electron.exe），旧实例不清会触发 Electron 单例锁，新进程只聚焦旧窗口 —— E2E 前必须 `Get-Process | Where-Object Name -like '*OpenPi*' | Stop-Process`。
13. write 工具生成的 `index.html`（E2E 副产物）曾让 asar 抽查误判；验证打包内容用 `@electron/asar extract`。

## M5：实时预览 + 会话管理全家桶 ✅（2026-09-11 完成，v0.8.0）

| 项目 | 内容 |
|---|---|
| **右侧实时预览面板** | webviewTag + `<webview>`；从 Agent 文本/工具输出自动探测 localhost/127.0.0.1 服务（含 ::1），顶栏 🌐 亮绿点提示；🔄 刷新 / ↗ 系统浏览器打开（仅 http(s) 白名单）/ 尺寸切换（填满/平板 768/手机 390） |
| **会话右键菜单** | ✏️ 重命名（迷你弹窗，Promise 化；当前会话同时调 pi setName）、📌 置顶/取消、🗑 删除（shell.trashItem 进回收站可恢复，路径白名单校验） |
| **会话元数据** | `~/.pi/agent/openpi-meta.json`（自有文件，不动 pi 会话数据），主进程合并进 listSessions 结果 |
| **顶部会话标题 tab** | chat 区上方轻量 tab：绿点 + 标题 + ✕（=开新会话）；标题取 meta.title > preview |
| **侧栏「项目/分组」tab** | 项目=按工作区聚合（Codex 树）；分组=📌置顶区+全部会话平铺；选择记忆在 localStorage `op-side-tab` |

## M4.2 侧栏信息架构 + zcode 折叠条 ✅（2026-09-11 完成，v0.7.0）

| 项目 | 内容 |
|---|---|
| **侧栏 Codex 信息架构** | 「项目」区按工作区聚合会话（📁 名称 + 计数徽章 + 折叠/展开 + 悬停「＋」在该项目直接开新会话）+「最近」区按时间倒序；顶栏 ✏️ 新对话按钮；🔍 搜索框实时过滤（标题/路径） |
| **欢迎屏 Codex 双大卡** | 「探索并理解代码」「构建新功能、应用或工具」图标大卡（对标 Codex 经典欢迎页） |
| **zcode 工具折叠条** | 每轮消息完成后所有工具卡折叠成「⚙ 已工作 N 秒 · M 次工具调用 ›」一行，点击展开/收起；顺带修复长存隐患：finalize 时 markdown 重渲染会销毁 body 内工具卡 DOM（现在折叠先于重渲染把它们移出） |
| **空轮次清理** | 纯工具轮隐藏头像行（toolonly）；完全空轮次整条移除——消息流不再有空气泡 |
| **用户消息轻胶囊** | 去边框、浅蓝底、右上圆角、max-width 78%（zcode 风） |
| **快捷键** | Ctrl+N 新对话 / Ctrl+K 搜索会话 / Ctrl+= 新窗口 |

## M4 UI 全面升级 ✅（2026-09-11 完成，v0.6.0，对标 Codex 设计语言）

| 项目 | 内容 |
|---|---|
| **Composer 浮动卡片** | 输入区改为大圆角浮动卡片（聚焦发光）；工作区📁/分支🌿/审批🛡 作为上下文胶囊贴在输入框上方（Codex 同款布局）；模型/思考等级移至卡片右下角；圆形渐变发送钮（运行中变红色 ■） |
| **亮/暗主题** | 完整设计令牌系统，右上 🌙/☀️ 一键切换，localStorage 记忆；亮色下代码块保持暗底（终端嵌入风，one-dark 高亮通用） |
| **欢迎屏** | 新会话空状态居中「今天想做点什么？」+ 4 个示例任务卡（点击填入输入框） |
| **侧栏** | 渐变「＋新对话」按钮、会话项 💬 图标、选中项左侧渐变指示条 |
| **消息流** | 头像（用户 U / 助手渐变 ✦）+ 时间戳；用户消息右对齐蓝紫气泡 |
| **细节** | 原生 select 自定义箭头、自定义滚动条、模态弹出动画+毛玻璃、附件按钮（文件选择器选图）、分支 chip 点击直达 Git 面板、git 面板错误文案友好化 |

**新增踩坑记录**
19. CSS 类选择器（如 .chip { display:inline-flex }）会覆盖 HTML hidden 属性的 UA display:none——凡是靠 hidden 切换显隐的元素必须加全局 `[hidden] { display: none !important; }`。
20. 代码高亮主题按暗色调色，亮色主题下若把代码底色也切浅会出现「浅底浅字」；让代码块在亮色下保留暗底即可复用同一套高亮。
21. 模板字符串里嵌 HTML 属性时内外引号别混用（class="mono" 放进 "..." 字符串直接语法错误）。

## M3.5 对标 Codex 补强 ✅（2026-09-11 完成，v0.5.0）

| 项目 | 状态 | 证据 |
|---|---|---|
| **审批模式三档**（对标 Codex suggest/auto-edit/full-auto） | ✅ | 顶栏下拉：只读=写文件/命令全弹窗（弹窗含完整命令与档位提示）；自动编辑（默认）=改文件自动、仅危险命令与未知工具弹窗；全自动=全放行。三档均实测：拒绝→文件未落盘、允许→落盘、全自动 rm 无弹窗直接执行 |
| **Git 面板**（🌿 顶栏按钮） | ✅ | 分支/变更列表（状态着色）/点击展开完整 diff/最近提交 log/一键 commit（git add -A + commit，在主进程跑不烧会话上下文） |
| **图片输入**（对标 Codex 截图输入） | ✅ | 粘贴/拖拽图片 → 缩略图条可删 → 随消息发送（`prompt(text, {images})` 官方 ImageContent 格式），1x1 PNG 实测模型正确识别颜色；steer 同样支持带图 |
| 修复：工具卡输出 `[object Object]` | ✅ | 新增 `extractTextDeep` 递归提取 content blocks 文本 |
| 修复：审批档位传递 bug | ✅ | handler 误读 `hostRef.approvalMode`（undefined），应为 `hostRef.mode`——曾导致档位形同虚设，已修并三档回归 |

**新增踩坑记录**
17. 审批档位这类"全局策略"用模块级单例对象传引用，handler 读属性名必须与定义一致——undefined 不会报错只会静默放行，安全相关逻辑必须三档逐一实测。
18. `git status --porcelain=v1 -b` 首行 `## branch`，后续行 `XY path`；commit 后立即读 status 可能撞上 git 索引竞态，UI 上二次刷新即可。

## M3 对标超越 ✅（2026-09-11 完成，剩余增强项见下）

| 项目 | 状态 | 证据 |
|---|---|---|
| **多窗口并行会话**（每窗口独立 AgentHost：独立会话/工作区/模型/审批通道，IPC 按 webContents.id 路由） | ✅ | E2E-8：A 流式中开 B，B 换模型（glm-5.3-flash → glm-4-plus）独立对话“并行成功”，A 不受影响；打包版回归同过 |
| ⧉ 新窗口按钮（可开不同工作区） | ✅ | 截图 `m3-dist-proof.png` 顶栏 |
| **树导航补验**（navigateTree 点击 → 分支重放） | ✅ | 导航到首条用户消息：上下文清到分支点，消息撤回输入框可编辑重发（ChatGPT 式） |
| **内核版本检查**（设置页 → npm view 对比） | ✅ | “内核已是最新: 0.85.1”（真实网络验证） |
| 版本号真实化 | ✅ | app.getVersion() 替代硬编码 |
| 打包版 0.4.0（NSIS + 便携） | ✅ | 镜像源构建成功，双窗口并行实测 |

**M3 后续增强（不影响验收基线，排队）**
- RPC 子进程池（每工作区隔离进程，当前进程内并行已满足“多项目同时干活”）
- 模型市场（llama.cpp + HF 下载）、skills/模板管理
- Linux/macOS 包 + electron-updater 自动更新

**新增踩坑记录**
14. electron-builder 在 GitHub 连接不稳时会 ETIMEDOUT，设 `ELECTRON_MIRROR` + `ELECTRON_BUILDER_BINARIES_MIRROR` 到 npmmirror 即可。
15. Windows 下 `execFile("npm", …)` 找不到 npm.cmd，必须 `{shell:true}`。
16. Electron 多窗口单例锁同 app 不同窗口正常共存；CDP 多窗口 E2E 需打标记（`window.__IS_A`）区分 page target。

## P66（0.55.0）渐进流式 + 思考展开（2026-09-16）

**用户报障**：AI 回答流式期间 UI 不实时更新，切会话（重放磁盘历史）才看到内容。

**排查结论（全链路实测）**：
1. **事件链路完全通畅**：慢流 mock（20 块 × 300ms）实测首块 t=600ms 上屏、每 300ms 渐进增长、message_update 全部到达渲染层——worker→proxy→渲染层→DOM 无任何过滤/丢失。e2e-p66 首版 4/4 绿
2. **真实上游 SSE 正常**：直连 open.bigmodel.cn glm-5.2 实测 9.7s 内 84 个增量逐个到达（0.1~1.7s/个），但 **84 个全是 reasoning_content，text=0**——thinking=high 时 glm-5.2 先思考很久才出正文
3. **根因 = 思考期 UX**：思考过程渲染在折叠的 `<details class="thinking">` 里，流式期间正文一直空白，唯一活信号是折叠条里涨字数——体感就是「没流式」；用户中途切走、回来任务早已跑完 → 误判「切会话才能看到」
4. **测试盲区实锤**：此前所有 e2e mock 都把整段回复塞在一个 delta 里一次性发（36 套全绿但从未测过渐进流式）

**修复**：
- appendThinking：思考流式期间 `c.thinkingEl.open = true`（正文 `c.text` 为空时），实时滚动
- appendText：正文首 delta 到达 → thinking 条折叠；finalizeAssistant：结束折叠
- style.css：`.thinking[open] > .content { max-height: 34vh; overflow-y: auto }` 长思考不撑爆气泡
- e2e-p66 扩展为 8 thinking + 12 text 慢流，6/6 绿（①渐进文本 ②updates≥15 ③全文完整 ④思考自动展开+字数涨 ⑤正文/结束折叠）；e2e-all 36→37 套
- 确认 pi-ai 会把 OpenAI 兼容 `reasoning_content` 转 thinking_delta（思考过程一直在事件流里）

**新增踩坑**
- **#119 e2e mock 一次性发全文 = 流式渲染盲区**：mock 必须「分块慢发」（≥2 块、300ms 间隔）才能测出渐进渲染；同理折叠态 UI 会把「功能正常」藏成「体感坏了」——报障先实测事件链路再查 UI 呈现
- bash PATH 被微信开发者工具 node v16 抢占（#93 家族再现）——跑脚本一律显式 node 路径
