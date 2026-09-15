// P56 e2e 靶子窗口：独立 electron 实例，提供一个可自动聚焦的输入框
// 运行：electron.exe e2e-p56-helper.cjs --remote-debugging-port=9649
const path = require("path");
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
	app.setAccessibilitySupportEnabled(true); // UIA 控件树需要 a11y 开启
	const w = new BrowserWindow({
		width: 520,
		height: 320,
		title: "P56-TARGET",
		autoHideMenuBar: true,
		webPreferences: { nodeIntegration: false, contextIsolation: true },
	});
	w.loadFile(path.join(__dirname, "e2e-p56-helper.html"));
});
