// 自动更新（electron-updater 6.x）：默认 GitHub Releases 公网源，用户可用
// ~/.pi/agent/updater.json 覆盖为 github 或 generic。状态机：
// idle → checking → available/up-to-date → downloading → ready → install。
import pkg from "electron-updater";
const { autoUpdater } = pkg;
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const UPDATER_CFG = path.join(os.homedir(), ".pi", "agent", "updater.json");
export const DEFAULT_FEED = Object.freeze({ provider: "github", owner: "liujinan153-cpu", repo: "openpi-desktop" });
let win = null;
let state = { status: "idle", version: null, progress: 0, error: null };

export function readUpdaterConfig() {
	try {
		const c = JSON.parse(fs.readFileSync(UPDATER_CFG, "utf8"));
		if (c.provider === "github" && c.owner && c.repo) return { provider: "github", owner: String(c.owner), repo: String(c.repo) };
		if (c.provider === "generic" && c.url) return { provider: "generic", url: String(c.url) };
	} catch { /* 无覆盖配置时使用官方公网源 */ }
	return { ...DEFAULT_FEED };
}

export function feedConfigured() {
	const c = readUpdaterConfig();
	return c.provider === "github" ? Boolean(c.owner && c.repo) : Boolean(c.url);
}

function snapshot() {
	return { ...state, configured: feedConfigured(), current: app.getVersion(), feed: readUpdaterConfig().provider };
}
export const getSnapshot = snapshot;

function push(status, patch = {}) {
	state = { ...state, status, ...patch };
	if (win && !win.isDestroyed()) {
		try { win.webContents.send("agent:event", JSON.parse(JSON.stringify({ type: "update_state", state: snapshot() }))); } catch { /* renderer 已关闭 */ }
	}
}

export function initUpdater(mainWin) {
	win = mainWin;
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
	// 不覆盖 verifyUpdateCodeSignature：签名包使用 electron-updater 默认校验；未签名 Beta 仍由 SHA-512 校验。
	autoUpdater.forceDevUpdateConfig = !app.isPackaged;
	autoUpdater.on("update-available", (info) => push("available", { version: info.version, error: null }));
	autoUpdater.on("update-not-available", () => push("up-to-date", { version: null }));
	autoUpdater.on("download-progress", (p) => push("downloading", { progress: Math.round(p.percent) }));
	autoUpdater.on("update-downloaded", (info) => push("ready", { version: info.version }));
	autoUpdater.on("error", (e) => push("error", { error: friendlyError(e) }));
	applyFeed();
}

function applyFeed() {
	const c = readUpdaterConfig();
	if (c.provider === "github") autoUpdater.setFeedURL(c);
	else autoUpdater.setFeedURL({ provider: "generic", url: c.url });
}

function friendlyError(e) {
	const s = String(e?.message ?? e);
	if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(s)) return "网络不可达：检查更新源地址与网络";
	if (/404/.test(s)) return "更新源上没有找到更新清单或安装包——确认 Release 资产已完整发布";
	if (/signature/i.test(s)) return "更新包签名校验未通过";
	return s.slice(0, 160);
}

export async function checkUpdate() {
	applyFeed();
	push("checking");
	return autoUpdater.checkForUpdates();
}
export async function downloadUpdate() { return autoUpdater.downloadUpdate(); }
export function installUpdate() { autoUpdater.quitAndInstall(false, true); }

/** 打开用户覆盖配置；首次创建时写入官方 GitHub 源作为可编辑模板。 */
export function openUpdaterConfig() {
	if (!fs.existsSync(UPDATER_CFG)) {
		fs.mkdirSync(path.dirname(UPDATER_CFG), { recursive: true });
		fs.writeFileSync(UPDATER_CFG, JSON.stringify(DEFAULT_FEED, null, 2) + "\n", "utf8");
	}
	return UPDATER_CFG;
}
