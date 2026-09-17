import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 仅允许应用自己的 renderer 页面作为顶层窗口。 */
export function isTrustedTopLevelUrl(raw, rendererFile) {
	try {
		const u = new URL(String(raw));
		if (u.protocol !== "file:") return false;
		return path.resolve(fileURLToPath(u)) === path.resolve(rendererFile);
	} catch {
		return false;
	}
}

/** 预览 webview 只承载网页、about:blank 与本地文件；显式拒绝 javascript/data 等可执行协议。 */
export function isAllowedPreviewUrl(raw) {
	try {
		const s = String(raw ?? "");
		if (s === "about:blank") return true;
		const u = new URL(s);
		return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "file:";
	} catch {
		return false;
	}
}

export function installElectronSecurity({ app, session, shell, rendererFile }) {
	const openExternal = (raw) => {
		try {
			const u = new URL(String(raw));
			if (u.protocol === "http:" || u.protocol === "https:") shell.openExternal(u.href);
		} catch { /* 非法 URL 直接拒绝 */ }
	};

	app.on("web-contents-created", (_event, contents) => {
		contents.setWindowOpenHandler(({ url }) => {
			openExternal(url);
			return { action: "deny" };
		});
		contents.on("will-navigate", (event, url) => {
			const webview = contents.getType?.() === "webview";
			const allowed = webview ? isAllowedPreviewUrl(url) : isTrustedTopLevelUrl(url, rendererFile);
			if (!allowed) event.preventDefault();
		});
		contents.on("will-attach-webview", (event, webPreferences, params) => {
			if (!isAllowedPreviewUrl(params.src || "about:blank")) {
				event.preventDefault();
				return;
			}
			// 页面不得借 webview 获得 Node/preload/弹窗能力。
			delete webPreferences.preload;
			delete webPreferences.preloadURL;
			webPreferences.nodeIntegration = false;
			webPreferences.nodeIntegrationInSubFrames = false;
			webPreferences.contextIsolation = true;
			webPreferences.sandbox = true;
			webPreferences.webSecurity = true;
			webPreferences.allowRunningInsecureContent = false;
			webPreferences.javascript = true; // 预览本地 Web App 需要 JS；仍隔离于主 renderer
		});
	});

	// OpenPi 不需要站点摄像头、麦克风、定位、通知、USB 等权限；系统通知走主进程 Notification。
	const ses = session.defaultSession;
	ses.setPermissionCheckHandler(() => false);
	ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}

export const rendererUrl = (rendererFile) => pathToFileURL(rendererFile).href;
