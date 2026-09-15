// electron-builder afterPack 钩子：打包后往 resources 写 app-update.yml（踩坑 #86）
// electron-updater 下载阶段必读此文件；未配 publish 字段时 builder 不生成 → 下载报 ENOENT、升级链断。
// url 会被运行时 ~/.pi/agent/updater.json 的 setFeedURL 覆盖，此处指向默认本地发布源。
const fs = require("fs");
const path = require("path");
module.exports = async function afterPack(context) {
	if (context.electronPlatformName !== "win32") return;
	const resDir = path.join(context.appOutDir, "resources");
	fs.writeFileSync(path.join(resDir, "app-update.yml"), "provider: generic\nurl: http://127.0.0.1:9355/\n", "utf8");
	console.log(`  ✅ afterPack: app-update.yml → ${resDir}`);
};
