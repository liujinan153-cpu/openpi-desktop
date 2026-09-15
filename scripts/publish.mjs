// OpenPi Desktop 发布工具：把 dist/ 的更新三件套发布到本地更新源（http://127.0.0.1:9355/）
// 用法：npm run dist 通过后 → node scripts/publish.mjs
// 前置：发布源服务（E:/pi2/openpi-releases/server.bat，计划任务 OpenPiReleaseServer）在跑
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const UPDATER_CFG = path.join(os.homedir(), ".pi", "agent", "updater.json");
const DIST = path.join(ROOT, "dist");
const RELEASE = "E:/pi2/openpi-releases";
const URL = "http://127.0.0.1:9355/";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ver = pkg.version;
const setup = `OpenPi Desktop Setup ${ver}.exe`;
const files = [setup, `${setup}.blockmap`, "latest.yml"];

// 1) 三件套齐备校验
for (const f of files) {
	if (!fs.existsSync(path.join(DIST, f))) {
		console.error(`✘ dist/ 缺 ${f} —— 先跑 npm run dist`);
		process.exit(1);
	}
}

// 2) latest.yml 版本与 package.json 一致
const yml = fs.readFileSync(path.join(DIST, "latest.yml"), "utf8");
if (!yml.includes(`version: ${ver}`)) {
	console.error(`✘ latest.yml 版本与 package.json 不一致（yml=${yml.match(/version: (.+)/)?.[1]}，pkg=${ver}）`);
	process.exit(1);
}

// 3) 拷贝发布
for (const f of files) fs.copyFileSync(path.join(DIST, f), path.join(RELEASE, f));
console.log(`✔ 已发布 v${ver} → ${RELEASE}`);
console.log(`  ${files.join("\n  ")}`);

// 4) 服务存活自检（拉 latest.yml）
try {
	const got = execSync(`curl -s --noproxy "*" --max-time 5 ${URL}latest.yml`, { encoding: "utf8" });
	if (!got.includes(`version: ${ver}`)) throw new Error(`返回内容不含 ${ver}`);
	console.log(`✔ 更新源在线自检通过：${URL} → v${ver}`);
} catch (e) {
	console.error(`✘ 更新源 ${URL} 不可达或内容不对：${e.message}`);
	console.error(`  修复：重启发布源（双击 ${RELEASE}/server.bat）`);
	process.exit(1);
}

// 5) updater.json 指向自检（P37.2 踩坑 #88：e2e 曾把指向改成 e2e 端口 9398 且不还原）
try {
	const cfg = JSON.parse(fs.readFileSync(UPDATER_CFG, "utf8"));
	if (cfg.url !== URL) {
		console.error(`⚠ updater.json 指向 ${cfg.url} ≠ 发布源 ${URL}，已自动修正`);
		fs.writeFileSync(UPDATER_CFG, JSON.stringify({ provider: "generic", url: URL }, null, 2));
	}
} catch (e) {
	console.error(`⚠ updater.json 读取失败（${e.message}），已重建`);
	fs.writeFileSync(UPDATER_CFG, JSON.stringify({ provider: "generic", url: URL }, null, 2));
}
console.log(`\n完成。已装用户在应用内「设置 → 检查更新」即可升到 v${ver}。`);
