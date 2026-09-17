# OpenPi Desktop 更新日志

用户视角的里程碑记录；实施细节与踩坑见 `PROGRESS.md`。

## 0.59.0（2026-09-18）

- **公开发布链闭环（P70）**：默认更新源从本机 `127.0.0.1:9355` 切为公开 GitHub Releases；统一 GitHub 资产名、发布脚本、匿名下载 smoke、包内 `app-update.yml` 与 `build.publish`；保留 updater.json 用户覆盖能力
- **Electron 安全加固**：顶层导航/新窗口拦截，webview 限制协议并强制 sandbox/contextIsolation/no-node，默认拒绝站点权限；文件打开/预览/定位 IPC 增加工作区真实路径和符号链接边界
- **Agent 真恢复**：utilityProcess 崩溃后自动重建 ModelRuntime、恢复最近会话/工作区/模型/思考等级/审批模式/允许清单/自动压缩；中断轮不自动重放，UI 提供明确重试入口
- **工程与合规**：新增 Windows CI/release workflow、统一语法与 unit-p70、打包/public-release smoke、许可证审计、AGPL 项目许可证、NOTICE/SECURITY；清理异常 e2e-ws gitlink和一次性上传脚本
- **测试不污染用户状态**：更新 E2E 与模型闸门改为字节级原样恢复；新增 mock-only E2E 入口，CI 不调用付费真模型
- **公开 Beta 边界**：尚无 Windows 商业代码签名证书，README 明示 SmartScreen 未知发布者风险；签名为外部凭证阻塞项

## 0.58.0（2026-09-16）

- **后台任务取消通道**（P69）：任务面板 running 任务行新增「✕ 取消」按钮 → worker session abort → 状态变「已取消」（主动取消不计为错误）；主进程新增 task:cancel IPC，taskSessions Map 持引用不进序列化
- **Codex / OpenCode 会话导入**（P69，此前仅 Claude Code）：Codex rollout jsonl（response_item，input_text/output_text 全兼容，滤 developer/environment_context 等系统注入）+ OpenCode storage（session/message/part 多布局防御式读取）；探测支持三来源，导入进 pi 会话目录可搜索回看；本机真实 Codex 数据单测验证
- 新增 unit-p69（6断言）+ e2e-p69（8断言），e2e-all 39→40 套

## 0.57.0（2026-09-16）

- **流式跟随智能化**（P68，修 P66 用户痛点另一半）：流式期间用户上滚即停止强拉底部（可边输出边回看历史），接近底部/发新消息/点回底按钮自动恢复跟随；滚动离底 >300px 浮出回底按钮，流式中带脉冲提示点
- **消息操作条**：assistant 消息 hover 浮出「❐ 复制全文 / ❝ 引用到输入框」（引用自动预填 > 前缀并聚焦）
- **图片 lightbox**：点击聊天中任意图片（贴图/markdown 图/生成图）全屏放大，Esc 或点击关闭
- 新增 e2e-p68（8 断言），e2e-all 38→39 套

## 0.56.0（2026-09-16）

- **minimap 对话轨道**（P67，对标 PI-Desktop）：聊天区右侧细轨道按消息类型着色（用户/回复/工具/系统），滚动实时同步视口框；hover 加宽，点击/拖拽按比例跳转；内容不溢出时自动隐藏
- **设置全局搜索**（P67）：设置弹窗顶部搜索框跨 5 个 tab 索引全部卡片/表单/列表，结果弹层（tab 归属 + 标题 + 摘录）点击跳转并闪烁高亮目标卡；↑↓/回车/Esc 键盘操作，无命中显示空态
- 新增 e2e-p67（8 断言），e2e-all 37→38 套

## 0.55.0（2026-09-16）

- **修「流式不实时显示」体感问题（P66）**：排查实锤事件链路（worker→proxy→渲染层→DOM）完全通畅（慢流 mock 实测首块 600ms 上屏），根因是 glm-5.2 thinking=high 时先思考几十秒，而思考过程渲染在**折叠**条里，正文空白——体感是「没流式」。现在**思考流式期间自动展开**（字数实时涨、内容实时滚动），正文首个字到达或结束时自动折叠；思考展开时限高 34vh 滚动不撑爆气泡
- 新增 e2e-p66（渐进流式+思考展开，6 断言；mock 先 8 块 reasoning_content 再 12 块正文慢发）——堵掉「mock 一次性发全文」的流式渲染测试盲区，e2e-all 36→37 套；坐坑 #119

## 0.54.0（2026-09-16）

- **通知中心**（P65）：顶栏铃铛 + 未读徽标 + 收件箱面板；任务完成/失败、子任务完成（P64 worker 结论）、运行异常(ui_notify error/warning)自动留痕，OS 通知之外的持久层；展开即全部已读，支持清空
- **Ctrl+K 全局命令面板**：命令（新建/切主题/设置/侧栏/文件·审核·预览面板/通知中心）+ 会话搜索跳转，↑↓/回车/Esc 键盘操作；原 Ctrl+K 会话过滤并入面板
- 新增 e2e-p65（10 断言）；坐坑 #118：mock LLM 缺 [DONE]+res.end() 时 SDK 等 SSE EOF，message_end/agent_settled 不发（finish_reason=stop 已消费但流不关）——mock 必须 OpenAI 标准收尾

## 0.53.1（2026-09-16）

- **修 worker 结论回喂竞态**：followUp 入队与 agent loop 收尾 drain 存在毫秒级竞态（worker 秒完成时结论可能滞留队列无人消费）——改为延迟 1.5s 注入 + 三态策略（loop 空闲直接 prompt 开新轮 / 忙时转 followUp 排队 / 再降级 steer），实测全量 35 套绿
- **e2e 稳定性**：p62/p63/p49 套件 workspace 从共享的 ~/openpi-workspace 改为独立临时目录（共享导致 agent 首轮偶发卡死，是此前全量 3 套假失败的根因）；p49 断言适配 P64 结论推送语义；p62/p63 轮询窗口加长至 150s

## 0.53.0（2026-09-16）

- **P64 第三批（PLAN-P62-P64.md 收官）**：
  - **并行 worker + 多角色**：subagent 升级为可批量派发的后台 worker——`subagent({batch:[{prompt,task,role}]})` 一次派多个（每父上限 4），真并行执行；**角色系统**：explore（只读调研）/ coder（写改码+命令）/ tester（跑测试）/ reviewer（对抗审查）四预设，各自工具白名单+角色提示；readonly 档下降级为纯只读（权限继承父会话）
  - **worker 命令工具 run_cmd**：替代内置 bash 给 tester/coder（危险命令正则拒绝，spawnSync 同步拿全 stdout/stderr）
  - **结论自动回喂**：worker 完成后结论自动推送进主会话（AI 无需轮询，派发后可先干别的）
  - **会话导入**：侧栏新增导入按钮——一键把 **Claude Code** 的本地会话（~/.claude/projects）转成 OpenPi 会话，出现在列表可回看/可搜索/可续聊；幂等导入（重复点不会产生副本）；Codex/OpenCode 后续批
- 坐坑 #117：**worker 会话阻塞等待会卡死主会话**——tool execute 内 await 子 LLM 流（哪怕包一层 Promise.all）会触发 SDK 轮转竞态，主会话 tool result 后不再回喂；**后台跑 + 完成后 prompt(streamingBehavior:"followUp") 注入**是唯一稳定形态；**内置 bash 不能给 worker 会话**（激活即卡死），用自定义 run_cmd 替代

## 0.52.0（2026-09-16）

- **P63 第二批**（PLAN-P62-P64.md）：
  - **lsp_diag 语义诊断**：内嵌 TypeScript 编译器（typescript 进 dependencies 随包分发），JS/TS/JSX/TSX 类型级错误（行列+TS码），只报 Error 级防噪音；与 run_tests 配套（行为自证+类型自证）
  - **目标模式（Goal 档）**：审批第四档——锁定目标+验收标准，全自动审批（危险命令仍确认），系统提示注入验收清单约定，AI 自主迭代到验收通过输出对照表
- 坐坑：worker 里 async custom tool + 动态 import 有竞态（tool result 不回传致 agent loop 卡死、时好时坏）——一律静态 import + 同步 execute；e2e 断言 mock 端变量而非渲染层气泡（流式渲染截取时机不稳定）

- **P62 编程三件套**（PLAN-P62-P64.md 第一批）：
  - **repo map**：会话自动注入工作区地图（目录树+项目元信息，gitignore 感知、带缓存）——弱模型大仓库不迷路
  - **ast_edit**：ast-grep 语法树批量替换（预览→apply 两段式，0/超30处拒绝），重命名/重构不错配引号缩进——#100 家族根治；二进制随包分发（resources/bin）
  - **run_tests**：npm/pytest/go/cargo 自动探测，改码后行为级自证
- 踩坑 #115：ast-grep 把路径参数当 glob，Windows 反斜杠被视为转义符→静默 0 匹配——传参一律转正斜杠；Applied N changes 走 stderr（execFileSync 捕不到，用 spawnSync）

- **修复：子代理被审批误拦**（e2e-p49 假失败数版未觉——fast 发布通道跳过旧套件的盲区）——subagent 是只读派发，进直通名单；本轮全量 31/31 绿后出包

- **生图工具全面升级**：设置页新增「生图 API」卡（Base URL / 模型 / key 三项，可接第三方 OpenAI 兼容生图服务如 image-2；默认智谱 CogView-4 免配置）
- **尺寸约束实测校准**：API 实测口径 512~2880、16 倍数、总像素≤2097152——工具层强校验，不合法明确报错（不再静默回落）；generate_image 新增 model 参数
- **4K 说明**：cogview-4 官方上限不支持 4K；要 4K 需在设置页配置支持该能力的模型

- **新增：AI 生图工具（generate_image）**——接智谱 CogView-4，文字生图存本地，key 复用 models.json，零新增依赖
- **修复：纯贴图（不写字）必报错**——实测定位 #89 家族：智谱拒收 [text("")+image] 消息组合（HTTP 400/1210），纯贴图时自动补「（见附图）」占位
- **核实：glm-5.3-flash 视觉可用**——models.json 配置已含 image，电脑操控截图自查链路打通（无需换模型）
- **盘点：MCP 桥 P28 已内置**（stdio+HTTP 双模式、全局共享连接），无需重复建设

- **重构：电脑控制 daemon 化**——常驻 PowerShell 进程（stdin JSON 协议），单次操作 ~100ms（此前每次冷启动 1~2 秒），进程崩溃自动重启
- **修复：混合 DPI 多屏点击偏移**——daemon 声明 Per-Monitor V2，UIA 元素坐标与鼠标坐标统一为物理像素（修复点击偏到窗口外的真机问题）
- **修复：Chromium 系应用控件树延迟就绪**——元素枚举全匿名时自动等待 2.5s 重试
- **新增工具**：computer_read（程序化回读焦点控件，反撒谎验证）/ computer_apps + computer_launch（开始菜单搜索并启动应用）/ computer_scroll / computer_drag / computer_clipboard / computer_wait
- **修复：截图相对路径落进安装目录**——强制绝对路径
- **去重**：检测到官方 pi Desktop 的全局 computer-use 扩展时自动剔除，AI 只见一套电脑工具
- **超时兜底**：电脑操作超时会自动重建 daemon 并提示降级方案（自绘 UI 应用改截图+坐标）

- **新增：控件树定位（CUA 强化）**——AI 操作本地应用不再靠截图猜坐标：可读取窗口的控件树（名称/类型/位置），并「按名称点击控件」，精度和可靠性大幅提升（对齐主流 agent 的 computer-use 思路）
- **改进**：输入/按键工具明确提示「审批后先激活目标窗口再输入」，避免文字误入其他应用

- **新增：验证门槛项目化**——AI 可调用「验证门槛配置」检测项目类型（Node/TypeScript/Python），一键生成项目级验证规则（存于项目的 .openpi/hooks.json，与团队共享）；写入即生效，无需重启
- **新增：代码诊断与符号导航**——AI 改完代码可立即自证：js/mjs/cjs 语法检查（自动识别 ESM）、TypeScript 类型诊断、Python 语法检查；大文件可先列函数/类定义再精读
- **修复**：语法检查此前对 .mjs / type:module 项目会误报（node --check 不支持 ESM），现自动按模块类型检查

- **新增：验证硬门槛（P57）**——写代码后的自动检查（如语法检查）失败时，失败信息会作为错误直接返回给 AI 并强制修复，AI 无法忽略或谎报「改好了」；这是从「软约定」到「机制强制」的关键一步
- **新增 5 个官方技能**：MCP 服务构建、网页应用测试、前端产物构建、视觉设计、主题工厂（技能总数 12）

- **新增：电脑操作（P56）**——AI 可以看屏幕（截图）、列出窗口、激活窗口、点击、输入文字、发送按键，帮你操作本地应用；写类操作（点击/输入/按键/激活）每次都需确认；所有电脑操作全量记入 ~/.pi/agent/computer-audit.log 审计日志

- **新增：验证闭环（P54）**——git 项目里 AI 改完代码会被要求先跑测试/构建并附上证据，跑不了要说明原因；设置页 hooks 示例新增「写 JS 后自动语法检查」模板
- **新增：项目记忆（P55）**——AI 可把项目约定/决策/偏好写进 <工作区>/.openpi/MEMORY.md，跨会话生效（写记忆需确认）；每次会话自动注入记忆摘要

- **新增：Git 检查点（P53）**——git 项目里 AI 每次改文件/执行命令前自动打快照（独立 ref，不污染你的提交历史）；AI 可用 git_status / git_diff 查看改动证据、git_rollback 一键回滚（需确认）；「改好了」从此带证据、可撤销
- 新增系统提示约定：改完代码先 git_diff 自证再汇报

- **修复：0.42.0 的浏览器控制不可用**——打包漏带依赖（chrome-remote-interface 误放在开发依赖里），导致「打开网页/点击/输入」报「Cannot find package」；现已随包携带，真机验证通过

## 0.42.0（2026-09-15）

- **P52 内置浏览器控制**：新工具 browser_open / snapshot / click / type / select / press / scroll / tabs / screenshot / wait——AI 能真实打开网页、填表单提交、点按钮、看截图；受控 Chromium 独立实例（自动探测本机 Chrome/Edge，独立 profile 不污染日常浏览器），元素用 [ref] 标注代替坐标猜测，稳定可靠
- **审批链路验证**：readonly/auto-edit 档位弹窗确认→点允许→立即执行，全链路 e2e 验证（打点实测 ui_request→弹窗→uiRespond→resolveUi 命中→confirm=true 秒级闭环）；排查中顺手加固：worker stderr 转发到主进程（排障日志通道）
- 浏览器写类操作（点击/输入/提交）在只读/自动编辑档位需弹窗确认，全自动档位直通+审计；子代理不带浏览器工具（单实例防冲突）
- webfetch/websearch 归类为只读操作：自动编辑档位不再弹确认

## 0.41.0（2026-09-15）

- **P49 自动压缩开关**：长会话接近窗口上限时 SDK 自动压缩历史（此前默默开着，现在设置页可关）；工具栏🗜手动压缩不变
- **P50 子代理**：新工具 subagent——派发独立上下文的子任务（大范围代码探索/多篇调研），只有只读权限，结论摘要回主会话；同一时间一个子任务，8 分钟超时
- **P51 Hooks**：~/.pi/agent/hooks.json 可在每次工具调用前/后执行你的本地命令（自动 lint、记录日志等），设置页可创建示例
- 修复：默认模型指向欠费服务时子代理报错不透明的问题；设置页开关在会话启动前不再报错

## 0.40.0（2026-09-14）

- **P47 内置联网检索**：新工具 webfetch（抓网页→纯文本，自动剥标签/截断，SSRF 拦截内网地址）与 websearch（Tavily API，设置页可配 key；无 key 兌底 DuckDuckGo）；全档位可用，SDK 零改动（customTools 注入）
- **P48 用量/成本面板**：状态栏实时显示 token 用量与美元成本（pi-ai 内置价格表），hover 看明细；恢复历史会话自动回填全部历史轮用量

## 0.39.0（2026-09-14）

- **P46 UI 设计系统改造（frontend-design 技能指导）**：装 anthropics/skills 官方 frontend-design 技能作设计方法论；vendor 化 Lucide 图标（UMD），index.html 47 处 + app.js 全部动态点（work-bar/思考折叠/工具卡/会话列表/搜索结果/改动卡/任务面板/欢迎卡）emoji → 线性 SVG，动态 DOM 收敛到 refreshIcons()；砍蓝紫渐变装饰全局单强调色；统一 focus ring / 数字 tabular-nums / prefers-reduced-motion；theme 按钮双图标 CSS 切换
- **修复坐坑 #97**：index.html mcp-msg `<div></span>` 标签错配 → div 链错位，#tab-skills 永不闭合、#tab-computer 嵌套隐藏（设置页「电脑控制」空白）；教训：结构错配要静态扫标签配对 + 运行时量渲染高度（querySelectorAll 不查可见性，e2e 多年没抓到）

## 0.38.0（2026-09-14）

- **P45 聊天内可视化（内置「可视化」技能）**：vendor 化 ECharts（1.1MB 离线可用）；AI 回复里的 ```` ```echarts ```` 代码块自动渲染成交互图表（KaTeX 同款管线，悬挂 tooltip/图例）；非法 JSON/缺 series 降级保留原码，容器隐藏时不渲染且下轮重试；内置 viz 技能卡（resources/skills/viz，教 AI 按数据形态选图：柱/线/饼/桑基/关系/时间线）随包自动部署 + 中文描述注入

## 0.37.0（2026-09-14）

- **P43 Agent 独立进程（utilityProcess，向 pi Desktop 取经）**：AgentHost 原样移入子进程（agent-worker.mjs，pi SDK 零改动），主进程只剩 MessagePort 转发（agent-proxy.mjs，接口与 AgentHost 同形：~25 个方法 RPC + workspace 缓存属性）；事件流经转发无损；worker 崩溃自动重启 + 渲染层提示；工具名/MCP 状态改走 RPC（避免 main 侧双 mcpManager 连接）；AgentHost 仅加 3 个切口（emitFn 钩子/toolNames/hostPid），auditLog 写盘、模型流、大事件 stringify 不再占主进程
- **P44 SQLite FTS5 会话索引（向 pi Desktop 取经）**：sessions-index.db（WAL）+ trigram 分词（中文子串）；files 表 mtime/size 增量比对，启动后台同步 + 搜索前轻量同步（变更才重索引，删除即 prune）；<3 字符查询回退 LIKE（trigram 最小 token 限制）；返回形状与旧搜索兼容；native 模块不可用自动降级旧全扫

## 0.36.0（2026-09-14）

- **P41 沙箱工作区（混合式，向 pi Desktop 取经）**：后台任务不再共享主工作区——每个任务独立沙箱目录（`userData/sandbox-workspaces/{8位id}/`）+ `.openpi-sandbox.json` 元数据（label/createdAt/kind/sessionId/sessionFile）；任务完成通知与任务面板带「📂 任务文件夹」；启动时自动清理 45 天不活跃沙箱（进行中不受影响）；`OPENPI_SANDBOX_ROOT` 可覆盖根目录。主会话维持共享工作区不变（产物跨会话复用）
- **P42 办公产物预览**：docx→mammoth、xlsx/xlsm/csv→SheetJS 表格、md→marked，主进程转换写缓存（`preview-cache/`，源路径 sha1 寻址），预览 dock 自动打开；生成物探测（文件卡/文本探测/文件面板）全链路识别新扩展名；>10MB 或不支持类型明确报错

## 0.35.0（2026-09-14）

- **向 pi Desktop 取经快赢批**（P40，对齐官方桌面端）：① 数学公式渲染——KaTeX vendor 化接入，`$行内 / $$块级 / \[…\]`，非法公式降级不崩溃；② 代码块悬停「复制」按钮（事件委托）；③ PATH 保险——启动时合并注册表用户 PATH + 常见工具目录（实测本机补齐 Python 用户目录等 5 项），防 GUI 启动丢 PATH 导致 agent "command not found"；④ **SDK 版本锁死** ^0.85.1 → 0.85.1（上游小版本可能悄悄改事件结构，升级时需跑会话回归再放开）

## 0.34.5（2026-09-14）

- **向 Cursor 取经三件套**（P39）：① 本轮改动卡——回合结束汇总 AI 改过的文件，一键打开审核面板或全部回滚（快照回滚沿用 P27 机制）；② 命令允许清单——⚙ 允许清单按钮，命中前缀且非危险的命令在只读/自动编辑档位免确认（Cursor allowlist 同款）；③ 失败重试——报错回合给「↻ 重试本轮」按钮，不再只能重新打字

## 0.34.4（2026-09-14）

- **模型上下文全量标注**：模型列表所有模型都标上真实上下文窗口（GLM 4.x 系 128k/200k、5.x 系 1M）；模型下拉对未标注的模型显式提示「上下文未知」，不再留空白；配合 0.34.3 的状态栏仪表，每个模型用了多少一目了然

## 0.34.3（2026-09-14）

- **上下文仪表显性化**：状态栏新增「上下文 12.3k / 1M · 5%」进度条（绿/黄/红三档），用了多少、总量多少一目了然；切模型即时刷新
- **glm-5.3 系上下文窗口修正为 1M**：此前 SDK 内置注册表按 128k 兜底（因 zhipu 配置未标 contextWindow），压缩/接力阈值随之偏保守；需在 ~/.pi/agent/models.json 给模型标 contextWindow 才不会被默认值替代

## 0.34.2（2026-09-14）

- **办公技能一劳永逸**：内置运行时补齐 pikepdf/pdfplumber/defusedxml 三库，技能说明书全面移除「环境检查/安装」引导——AI 不再每次任务都先跑 setup.sh 或 pip install，拿到任务直接干活，省下大量等待时间；PDF 转图改用内置 PyMuPDF（不再依赖外部 poppler）；应用升级后技能说明自动刷新到最新版

## 0.34.1（2026-09-14）

- **贴图自动压缩**：大图贴入时自动缩到最长边 2048px 并转 JPEG 高质量编码——几 MB 的照片压到几百 KB，发送更快、识别不减清晰度；小尺寸截图保留 PNG 原样；GIF 动图不处理；体积上限从 8MB 放宽到 30MB

## 0.34.0（2026-09-14）

- **新增压缩包技能（archive）**：智能体现在能处理压缩包——把 zip/7z/tar.gz 丢给 AI，它能查看内容、解压、对里面的文件继续加工（如「压缩包里有个 Excel，帮我整理成报表」）；也能把多个文件/目录打包成压缩包发给别人
- **中文乱码自动修复**：老式中文 zip（Windows 资源管理器直接压缩的 GBK 编码）解压不再乱码，这是中文用户的头号痛点
- **安全与细节**：zip 路径攻击防护（zip-slip）；密码压缩包支持（先询问密码）；7z 支持已内置（免装任何东西）；rar 仅支持读取，不可用时明确告知
- **修复：贴图报错「400: content[0].file必须传入…」**：给 glm-5.3-flash 等视觉模型贴图时，空文本+图片组合被智谱拒收（1210）——现在自动补占位文本；带空数据的图片不再发出去（1214 根因）。真实链路抓包验证（e2e-p385-vision，9/9）

## 0.33.1（2026-09-13）

- **应用内自动升级打通**：修复升级下载必挂的缺失文件（app-update.yml），真机验证 0.32.0 → 0.33.1 全链路（检查 → 下载 → 重启安装）；新增本地发布源，后续版本双命令即可发布更新
- **办公技能品牌焕新**：四套办公技能（Word/Excel/PPT/PDF）全面去除第三方痕迹——作者署名、生成文档的元数据（PDF 作者/创建者、简历 pdfauthor 等）统一改为 OpenPi，新产物不再携带外部品牌标识
- **产物报告规范自有化**：技能内置的第三方引用标记语法（`::zcode-file-citation{...}`）替换为 OpenPi 自己的「报告绝对路径」规范，与文件卡联动；AI 不再输出外部产品的私有标记

## 0.33.0（2026-09-13）

- **产物文件卡**：AI 生成的文件在对话里直接渲染成可点击卡片（类型图标 + 文件名 + Word/Excel/PPT/PDF 徽标）——左键用系统默认程序打开；右键菜单支持「打开 / 在资源管理器中显示 / 复制绝对路径 / 复制相对路径」；文件已被移走时自动灰置提示（对标 ZCode 文件引用体验）
- **兼容 ZCode 引用标记**：模型偶尔输出的 `::zcode-file-citation{...}` 私有标记自动兑底成文件卡，不再残留乱码文本
- **贴图不支持提醒**：给纯文本模型贴图时立即提示「当前模型不支持图片输入」，不再静默丢失
- **办公产物规范**：「写个文档」默认生成 Word（.docx）而非 .md；产物统一收进工作区（推荐 output/ 目录），回复报告完整绝对路径

## 0.32.0（2026-09-13）

- **办公技能开箱即用**：安装包内置完整的 Python 运行时与全部依赖（python-docx / openpyxl / python-pptx / pypdf / reportlab / PyMuPDF / lxml / Pillow），无需用户安装 Python 或任何依赖——装完即可让 AI 创建 Word / Excel / PPT / PDF
- 安装包体积 217MB → 243MB（内置运行时经压缩仅增加 26MB）

## 0.31.0（2026-09-13）

- **计划卡片**：计划模式下 AI 会提交结构化计划卡（目标 + 可勾选步骤 + 风险提示），批准后按卡执行
- **记忆管理**：发送单独的 # 打开工作区记忆面板，可查看和删除已固化的记忆条目
- **发布清单**：打包自动生成 latest.yml（含 sha512 校验），把安装包丢进任意 HTTP 目录即可启用自动更新
- **打包流程**：npm run dist 全流程统一用新版 Node 跑，不再依赖系统旧 Node

## 0.30.0（2026-09-13）

- **任务清单**（向 Claude Code TodoWrite 取经）：AI 接到多步任务会先列出清单并实时勾选进度，输入框上方随时可看已完成/进行中/待办
- **计划模式**（向 Claude Code Plan Mode 取经）：审批模式新增第四档——AI 只读探索并输出完整计划，批准后才真正执行；批准后自动切回原档位开工，也可继续讨论调整计划
- **# 快捷记忆**：输入框以 # 开头的一句话（如“# 记住：构建用 pnpm”）不发给模型，直接固化进工作区 AGENTS.md，后续所有会话自动生效

## 0.29.1（2026-09-13）

- **git 身份引导补配**：提交时若 git 未配置用户身份（之前直接报英文错误），现在会弹中文表单填姓名/邮箱，一键写入当前仓库后自动重试提交

## 0.29.0（2026-09-13）

- **块级采纳**（diff 块级 accept/reject 的另一半）：diff 中每块可「✓ 采纳此块」暂存进 index，提交时只包含已采纳块，未采纳的继续留在工作区可编辑/撤销——git add -p 的图形化
- **跨会话消息搜索**：侧栏搜索框现在能搜全部历史会话的消息内容（不只标题），命中结果带匹配行片段，点击直接恢复会话

## 0.28.0（2026-09-13）

- **自动更新器**：设置页「⬆ 关于与更新」卡——检查新版 / 下载（带进度）/ 重启安装；更新源运行时可配（GitHub Releases 或任意 HTTP 目录，~/.pi/agent/updater.json）
- **diff 块级撤销**：审核面板的 diff 按改动块（hunk）分组渲染，可只撤销其中一块，其余块保留（对标 Codex IDE 扩展的块级 accept/reject 的撤销向）

## 0.27.0（2026-09-13）

**质量门固化**：新增 `npm run e2e:all`（8 套 103 项断言的全量回归，每套独立干净实例，失败自动重试）；`npm run dist` 打包前强制先过全量回归，回归失败禁止出包。回归首航即抓到并修复：git 提交失败时错误信息丢失（nothing to commit 场景报错为空）、E2E 残留状态导致假失败。

## 0.26.0 / 0.26.1（2026-09-13）

**⚡ 后台并行任务**：dock 新增「⚡ 任务」面板——把任务丢到后台并行跑（最多 3 个），主会话互不阻塞；任务行显示状态/工具数/耗时，点击展开最近输出；完成且窗口最小化时弹系统通知；后台会话独立目录（sessions-tasks），不污染会话列表。后台任务无 UI 弹窗：危险命令自动拒绝（审计 blocked）。

**修复**：后台任务自动跟随主会话当前模型（此前 pi 默认链可能选中未配置额度的 provider，表现为秒回空响应假完成）；LLM 请求失败（额度耗尽/401）不再被误标为完成。

**🛡 安全审计入口**：设置页新增审计卡片，一键打开 `~/.pi/agent/audit/` 日志文件夹。

## 0.25.0（2026-09-13）

**full-auto 不再裸奔**：20 条危险命令特征（rm -rf / format / git reset --hard / curl|sh / iex 等）在全自动档也强制弹「危险命令确认」且不记忆；所有非只读工具调用落安全审计日志（按日 JSONL，记录档位/决策/命令摘要）。

## 0.24.0（2026-09-13）

**MCP 桥**：支持 `~/.pi/agent/mcp.json`（对齐 Claude Desktop / Codex 的 mcpServers 格式），stdio 与 streamable HTTP 两种 server，工具自动注册为 `mcp__<server>__<tool>`；设置页显示连接状态与工具数，可重连。

## 0.23.0（2026-09-13）

- **文件快照回滚**：AI 修改文件前自动快照，审核面板出现「⏪」一键恢复到 AI 首次修改前（多轮编辑一次全撤，AI 新建的文件回滚即删除）
- **Git 分支保护**：「🌿 保护分支」一键切到 `openpi/agent-*`，「⇥ 合并主分支」`--no-ff` 合并回 main
- **@ 文件补全**：输入 @ 弹工作区文件菜单（↑↓ Enter 选中，含空格路径自动加引号）

## 0.22.0（2026-09-12）

- **系统通知**：窗口最小化时 Agent 完成弹通知，点击聚焦
- **AGENTS.md 呈现**：📜 指令面板显示全局+工作区指令文件清单，可一键让 Agent 生成工作区 AGENTS.md

## 0.20.0 / 0.21.x（2026-09-12）

- **上下文自动接力**：占用过 80% 自动压缩交接、新会话续跑（弹窗确认）
- **内置办公技能**：Word / PDF / PPT / Excel 四技能随软件自带；skill-creator 技能教你写自己的技能

## 0.14.0 → 0.19.1

**电脑控制**：`computer_*` 12 工具（截图/点击/拖拽/打字/键盘/滚动/窗口/剪贴板），UIA 元素定位优先、截图回读验证，可开关随包部署。

## 0.8.0 → 0.13.x

对话核心 / 会话树 / 配置中心 / 多窗口并行 / UI 升级 / 实时预览 / 审批三档 / Git 面板 / 图片输入（见 README 功能清单）。
