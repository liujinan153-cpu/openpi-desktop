// 自动更新（electron-updater 6.x）：更新源运行时可配 ~/.pi/agent/updater.json
// { "provider": "github", "owner": "...", "repo": "..." } 或 { "provider": "generic", "url": "https://..." }
// 状态机 idle → checking → available / up-to-date → downloading(p%) → ready → (重启安装)；error 随时可入
import pkg from "electron-updater";
const { autoUpdater } = pkg;
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const UPDATER_CFG = path.join(os.homedir(), ".pi", "agent", "updater.json");
let win = null;
let state = { status: "idle", version: null, progress: 0, error: null };

export function feedConfigured() {
	try {
		const c = JSON.parse(fs.readFileSync(UPDATER_CFG, "utf8"));
		return c.provider === "github" ? Boolean(c.owner && c.repo) : c.provider === "generic" ? Boolean(c.url) : false;
	} catch {
		return false;
	}
}

function snapshot() {
	return { ...state, configured: feedConfigured(), current: app.getVersion() };
}

export const getSnapshot = snapshot;

function push(status, patch = {}) {
	state = { ...state, status, ...patch };
	if (win && !win.isDestroyed()) {
		try {
			win.webContents.send("agent:event", JSON.parse(JSON.stringify({ type: "update_state", state: snapshot() })));
		} catch {
			/* 渲染层忙时忽略 */
		}
	}
}

export function initUpdater(mainWin) {
	win = mainWin;
	// 事件监听无条件注册（更新源可能启动后才写入配置；checkUpdate 前会重读）
	autoUpdater.autoDownload = false; // 下载需用户点击（流量/版本自主权）
	autoUpdater.autoInstallOnAppQuit = true;
	autoUpdater.verifyUpdateCodeSignature = async () => true; // 本地自签证书链，不阻断
	autoUpdater.forceDevUpdateConfig = true; // 开发模式（未打包）也允许走更新流程（官方调试开关；打包版不受影响）
	autoUpdater.on("update-available", (info) => push("available", { version: info.version, error: null }));
	autoUpdater.on("update-not-available", () => push("up-to-date", { version: null }));
	autoUpdater.on("download-progress", (p) => push("downloading", { progress: Math.round(p.percent) }));
	autoUpdater.on("update-downloaded", (info) => push("ready", { version: info.version }));
	autoUpdater.on("error", (e) => push("error", { error: friendlyError(e) }));
	if (!feedConfigured()) return;
	try {
		applyFeed();
	} catch {
		return; // 配置坏则保持未配置态
	}
}

function applyFeed() {
	const c = JSON.parse(fs.readFileSync(UPDATER_CFG, "utf8"));
	if (c.provider === "github") autoUpdater.setFeedURL({ provider: "github", owner: String(c.owner), repo: String(c.repo) });
	else if (c.provider === "generic") autoUpdater.setFeedURL({ provider: "generic", url: String(c.url) });
	else throw new Error("provider 必须是 github 或 generic");
}

function friendlyError(e) {
	const s = String(e?.message ?? e);
	if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(s)) return "网络不可达：检查更新源地址与网络";
	if (/404/.test(s)) return "更新源上没有找到更新清单（latest.yml）——确认 Releases 已发布或 URL 指向正确目录";
	if (/signature/i.test(s)) return "更新包签名校验未通过";
	return s.slice(0, 160);
}

/** 手动检查；返回 { updateInfo } 或抛可读错误 */
export async function checkUpdate() {
	if (!feedConfigured()) {
		const err = new Error("未配置更新源：创建 ~/.pi/agent/updater.json，填 {\"provider\":\"github\",\"owner\":\"用户名\",\"repo\":\"仓库名\"} 或 {\"provider\":\"generic\",\"url\":\"https://...\"}");
		err.friendly = true;
		throw err;
	}
	applyFeed(); // 配置可能刚改过，每次检查前重读
	push("checking");
	return autoUpdater.checkForUpdates();
}

export async function downloadUpdate() {
	return autoUpdater.downloadUpdate();
}

export function installUpdate() {
	autoUpdater.quitAndInstall(false, true);
}

/** 打开（不存在则创建模板）更新源配置 */
export function openUpdaterConfig() {
	if (!fs.existsSync(UPDATER_CFG)) {
		fs.mkdirSync(path.dirname(UPDATER_CFG), { recursive: true });
		fs.writeFileSync(
			UPDATER_CFG,
			JSON.stringify({ provider: "github", owner: "你的GitHub用户名", repo: "openpi-desktop" }, null, 2),
		);
	}
	return UPDATER_CFG;
}
