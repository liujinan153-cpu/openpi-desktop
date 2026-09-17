// electron-builder afterPack 钩子：打包后往 resources 写 app-update.yml（踩坑 #86）
// electron-updater 下载阶段必读此文件；未配 publish 字段时 builder 不生成 → 下载报 ENOENT、升级链断。
// 用户可用 ~/.pi/agent/updater.json 覆盖；默认指向公开 GitHub Releases。
const fs = require("fs");
const path = require("path");
module.exports = async function afterPack(context) {
	if (context.electronPlatformName !== "win32") return;
	const resDir = path.join(context.appOutDir, "resources");
	fs.writeFileSync(path.join(resDir, "app-update.yml"), "provider: github\nowner: liujinan153-cpu\nrepo: openpi-desktop\n", "utf8");
	console.log(`  ✅ afterPack: app-update.yml → ${resDir}`);
};
