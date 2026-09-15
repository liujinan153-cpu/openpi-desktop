// Preload: 以最小面暴露 IPC（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("openpi", {
	// 生命周期
	init: () => ipcRenderer.invoke("agent:init"),
	start: (opts) => ipcRenderer.invoke("agent:start", opts),
	pickWorkspace: () => ipcRenderer.invoke("agent:pick-workspace"),
	newSession: (opts) => ipcRenderer.invoke("agent:new-session", opts),
	newWindow: () => ipcRenderer.invoke("window:new"),
	checkUpdates: () => ipcRenderer.invoke("agent:check-updates"),
	setApprovalMode: (mode) => ipcRenderer.invoke("agent:approval-mode", mode),
	setApprovalAllowlist: (list) => ipcRenderer.invoke("agent:approval-allowlist", list),
	getApprovalMode: () => ipcRenderer.invoke("agent:get-approval-mode"),
	gitStatus: () => ipcRenderer.invoke("git:status"),
	gitDiff: (file) => ipcRenderer.invoke("git:diff", file),
	// P0：审核 / P1：终端、文件
	gitDiffFile: (file, untracked) => ipcRenderer.invoke("git:diff-file", file, untracked),
	gitDiscard: (file) => ipcRenderer.invoke("git:discard", file),
	termRun: (command) => ipcRenderer.invoke("term:run", command),
	termKill: (id) => ipcRenderer.invoke("term:kill", id),
	onTerm: (cb) => {
		const handler = (_e, event) => cb(event);
		ipcRenderer.on("term:event", handler);
		return () => ipcRenderer.removeListener("term:event", handler);
	},
	fsList: (relDir) => ipcRenderer.invoke("fs:list", relDir),
	fsRead: (relFile) => ipcRenderer.invoke("fs:read", relFile),
	fsSearch: (query) => ipcRenderer.invoke("fs:search", query),
	fsWatch: () => ipcRenderer.invoke("fs:watch"),
	onFsChanged: (cb) => {
		const handler = (_e, relPath) => cb(relPath);
		ipcRenderer.on("fs:changed", handler);
		return () => ipcRenderer.removeListener("fs:changed", handler);
	},
	gitCommit: (message) => ipcRenderer.invoke("git:commit", { message }),
	gitLog: () => ipcRenderer.invoke("git:log"),
	notify: (title, body) => ipcRenderer.invoke("app:notify", { title, body }),
	agentsFiles: () => ipcRenderer.invoke("ctx:agentsFiles"),
	openPath: (p) => ipcRenderer.invoke("app:openPath", p),
	showItemInFolder: (p) => ipcRenderer.invoke("app:showItemInFolder", p),
	convertPreview: (p) => ipcRenderer.invoke("preview:convert", p), // P42：办公产物预览
	fileStat: (p) => ipcRenderer.invoke("app:fileStat", p),
	checkpointList: () => ipcRenderer.invoke("checkpoint:list"),
	checkpointRestore: (rel) => ipcRenderer.invoke("checkpoint:restore", rel),
	gitProtect: () => ipcRenderer.invoke("git:protect"),
	gitMergeBack: () => ipcRenderer.invoke("git:mergeBack"),
	filesFlat: () => ipcRenderer.invoke("files:flat"),
	mcpStatus: () => ipcRenderer.invoke("mcp:status"),
	taskStart: (prompt) => ipcRenderer.invoke("task:start", prompt),
	auditOpen: () => ipcRenderer.invoke("audit:open"),
	updateSnapshot: () => ipcRenderer.invoke("update:snapshot"),
	updateCheck: () => ipcRenderer.invoke("update:check"),
	updateDownload: () => ipcRenderer.invoke("update:download"),
	updateInstall: () => ipcRenderer.invoke("update:install"),
	updateOpenConfig: () => ipcRenderer.invoke("update:open-config"),
	gitRevertHunk: (file, hunkIndex) => ipcRenderer.invoke("git:revert-hunk", file, hunkIndex),
	gitDiffStaged: (file) => ipcRenderer.invoke("git:diff-staged", file),
	gitStageHunk: (file, hunkIndex) => ipcRenderer.invoke("git:stage-hunk", file, hunkIndex),
	gitStagedInfo: () => ipcRenderer.invoke("git:staged-info"),
	gitSetIdentity: (name, email) => ipcRenderer.invoke("git:set-identity", { name, email }),
	sessionsSearch: (q) => ipcRenderer.invoke("sessions:search", q),
	appendMemory: (text) => ipcRenderer.invoke("agents:append-memory", text),
	listMemory: () => ipcRenderer.invoke("agents:list-memory"),
	deleteMemory: (text) => ipcRenderer.invoke("agents:delete-memory", text),
	taskList: () => ipcRenderer.invoke("task:list"),
	mcpReconnect: () => ipcRenderer.invoke("mcp:reconnect"),

	// 会话
	listSessions: () => ipcRenderer.invoke("sessions:list"),
	sessionsMetaGet: () => ipcRenderer.invoke("sessions:meta-get"),
	sessionsMetaSet: (id, patch) => ipcRenderer.invoke("sessions:meta-set", id, patch),
	sessionDelete: (file) => ipcRenderer.invoke("sessions:delete", file),
	openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
	openWorkspaceFile: (file) => ipcRenderer.invoke("shell:open-workspace-file", file),
	resume: (file) => ipcRenderer.invoke("agent:resume", file),
	agentInfo: () => ipcRenderer.invoke("agent:info"),
	agentTools: () => ipcRenderer.invoke("agent:tools"),
	skillsList: () => ipcRenderer.invoke("skills:list"),
	skillsToggle: (name, enabled) => ipcRenderer.invoke("skills:toggle", name, enabled),
	skillsDelete: (name) => ipcRenderer.invoke("skills:delete", name),
	skillsCreate: (name, description) => ipcRenderer.invoke("skills:create", name, description),
	skillsInstall: (url) => ipcRenderer.invoke("skills:install", url),
	skillsOfficeScan: () => ipcRenderer.invoke("skills:officeScan"),
	skillsOfficeReinstall: (names) => ipcRenderer.invoke("skills:officeReinstall", names),
	computerUseSet: (enabled) => ipcRenderer.invoke("computeruse:set", enabled),
	getMessages: () => ipcRenderer.invoke("agent:get-messages"),

	// 配置中心
	configGet: () => ipcRenderer.invoke("config:get"),
	configSaveProvider: (id, patch) => ipcRenderer.invoke("config:save-provider", id, patch),
	configDeleteProvider: (id) => ipcRenderer.invoke("config:delete-provider", id),
	configSaveKey: (id, key) => ipcRenderer.invoke("config:save-key", id, key),
	configTest: (opts) => ipcRenderer.invoke("config:test", opts),
	configPreset: (key) => ipcRenderer.invoke("config:preset", key),
	refreshModels: () => ipcRenderer.invoke("agent:refresh-models"),

	// M2：会话树 / 压缩 / 导出 / 改名 / 扩展UI 回复；P24：上下文接力
	compact: () => ipcRenderer.invoke("agent:compact"),
	handoff: (opts) => ipcRenderer.invoke("agent:handoff", opts ?? {}),
	tree: () => ipcRenderer.invoke("agent:tree"),
	getUsage: () => ipcRenderer.invoke("agent:get-usage"), // P48 会话累计用量（含历史轮）
	setAutoCompact: (on) => ipcRenderer.invoke("agent:set-auto-compact", on), // P49
	getAutoCompact: () => ipcRenderer.invoke("agent:get-auto-compact"),
	hooksSample: () => ipcRenderer.invoke("hooks:sample"), // P51
	hooksOpen: () => ipcRenderer.invoke("hooks:open"),
	settingsGet: () => ipcRenderer.invoke("settings:get"), // P47 联网检索设置
	settingsSet: (patch) => ipcRenderer.invoke("settings:set", patch ?? {}),
	navigateTree: (id) => ipcRenderer.invoke("agent:navigate", id),
	exportHtml: () => ipcRenderer.invoke("agent:export-html"),
	setName: (name) => ipcRenderer.invoke("agent:set-name", name),
	uiRespond: (id, value) => ipcRenderer.send("agent:ui-response", id, value),

	// 对话
	prompt: (text, images) => ipcRenderer.invoke("agent:prompt", text, images ?? []),
	steer: (text, images) => ipcRenderer.invoke("agent:steer", text, images ?? []),
	abort: () => ipcRenderer.invoke("agent:abort"),
	setModel: (provider, id) => ipcRenderer.invoke("agent:set-model", { provider, id }),
	setThinking: (level) => ipcRenderer.invoke("agent:set-thinking", level),

	// 事件订阅，返回取消函数
	onEvent: (cb) => {
		const handler = (_e, event) => cb(event);
		ipcRenderer.on("agent:event", handler);
		return () => ipcRenderer.removeListener("agent:event", handler);
	},
});
