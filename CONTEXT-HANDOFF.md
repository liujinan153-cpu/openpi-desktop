# 会话交接文档（2026-09-13 晚）—— 新会话先读我

> 用法：新会话第一句话说「读 CONTEXT-HANDOFF.md 继续」。
> 本文档是完整上下文快照；`AGENTS.md` 是自动加载的精简版，两者配合用。

## 一、我是谁 / 在干什么
- 用户在做 **OpenPi Desktop**（Electron + pi SDK 的桌面 AI Agent，工程根 `E:\PI2\openpi-desktop\openpi-desktop`），我全程作为开发助手陪跑。
- 当前版本 **0.32.0**（已打包：`dist/OpenPi Desktop Setup 0.32.0.exe` + portable 243MB + latest.yml）。用户**已安装 0.32.0** 到 `%LOCALAPPDATA%\Programs\openpi-desktop\`。
- 工程惯例：每版 E2E + 截图 + PROGRESS.md（踩坑编号已到 **#83**）+ 打包（`npm run dist`，e2e-all 全绿才出包）+ 版本递增。**pi 底层源码零改动**是铁律（只用官方扩展点）。
- 交流中文；反撒谎原则：没做完就说没做完，被问"做完了吗"要诚实盘点边界。

## 二、今天干了什么（按序）
1. **办公技能真机实测**（P25 收尾）：winget 装了用户级 Python 3.12.10 + 8 个 pip 依赖，真实模型驱动 4 技能全部生成成功（docx/xlsx/pptx/pdf，产物读回验证通过）。产物在 `~/office-test/`。
2. **P36 办公技能安装即用**（v0.32.0，已完成）：
   - `scripts/prepare-python-runtime.mjs` 构建 `resources/runtime/python/`（embeddable CPython 3.12.10 + 预装依赖 + python3.exe 别名，113.7MB）
   - `src/main/main.mjs` 里 `injectPythonRuntime()`：app.whenReady 前 PATH 注入（打包版 `process.resourcesPath/runtime/python`）
   - `package.json`：files 排除 `!resources/runtime/**` + extraResources 复制
   - `scripts/e2e-p36.mjs`（8/8 绿，干净机模拟：启动时摘除系统 Python）；e2e-all **12 套 155 断言全绿**；NSIS 压缩后安装包仅 +26MB
3. **用户真机体验暴露的问题**（审计日志 `~/.pi/agent/audit/2026-09-13.jsonl` 破案）：
   - 用户说"写个文档" → AI 生成的是 `.md`（`~/openpi-workspace/数字花园.md`），不是 Word —— **歧义没兜住**
   - 另一次 AI 绕开技能：npm install docx 自己写 JS 生成，产物落 `~/Documents/docx-output/我爱的人，也很爱我.docx` —— **产物位置散乱 + 绕开技能**
4. **视觉修复（P36.5，刚做完待验证）**：
   - 根因：`~/.pi/agent/models.json` 里 zhipu/glm-5.3-flash 被标 `"input": ["text"]`，但它是**原生多模态**（官方文档+API curl 实测读图正常），pi 依标记把图片静默丢弃 → 踩坑 **#83**
   - 已改为 `["text", "image"]`。pi 源码确认：模型对象会话启动时固定（`getModel(){return this.model}`），**须 /model 重选或 /new 才生效** → 正在进行的就是这个
   - `scripts/vision.mjs` = 通用看图工具（node scripts/vision.mjs <图> [问题]；注意 cc-switch 的 kimi-k2.7-code 余额不足，zhipu API 直调可用）

## 三、马上要做的（新会话优先级）
1. **验证视觉**：让用户贴图（剪贴板图在 `C:\Users\86321\AppData\Roaming\pi-desktop\clipboard-images\`），用 read 工具读图确认能看见。若成功 → P36.5 收尾（PROGRESS/CHANGELOG 记录 #83）
2. **产品小改进候选**（用户未拍板，先别动手，问一句）：
   - 贴图时若当前模型无 image 标记 → UI 提示"当前模型不支持图片"
   - 技能触发强化："文档/Word/表格/Excel/幻灯片/PPT/PDF"关键词强引导 + "写个文档"默认 Word 歧义兜底 + 产物强制收进工作区
3. 更远：真实更新链路发布 0.32.0（Setup + blockmap + latest.yml 丢 HTTP 目录 + `~/.pi/agent/updater.json` 配 url）

## 四、环境备忘（本机坑，亲测）
- node 16 是默认 PATH 首个 → 一律用 `"$LOCALAPPDATA/node-lts/node-v22.14.0-win-x64/node.exe"`
- Python：`"$LOCALAPPDATA/Programs/Python/Python312/python.exe"`（+ python3.exe 别名同目录；内置 runtime 在 `resources/runtime/python/python3.exe`）
- E2E 启动套路：杀 9333 监听 → `env -u ELECTRON_RUN_AS_NODE electron.exe . --remote-debugging-port=9333` → 轮询就绪 → sleep 6-8 → node-lts 跑脚本；portable：`--remote-debugging-port=9335`；已装版：`%LOCALAPPDATA%/Programs/openpi-desktop/OpenPi Desktop.exe` + 9337
- node → python 传中文 argv 不可靠（踩坑 #81），python -X utf8 输出是 `\r\n` 要 split(/\r?\n/)（#82）
- edit 工具 tab 层级不匹配时改用 node -e 脚本替换；node -e 内嵌反引号会被 bash 吃 → 用 write 写临时 .mjs 跑
- 测试工作区可删：`~/v031-manual`、`~/p35-e2e`、`~/p36-e2e`、`~/office-test`（问用户）

## 五、未决小事
- zhipu 其余模型（glm-5/5.1/5.2 等）视觉标记没动——官方只说 5.3-flash 原生多模态，别的别乱标
- cc-switch-open-code-go 余额不足（CreditsError），相关模型暂不可用
