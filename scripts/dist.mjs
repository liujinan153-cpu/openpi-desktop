// 打包总调度（P35.1）：统一用 node-lts 跑全流程，修复 electron-builder 在系统 node16 下崩溃的问题
// 流程：E2E 回归（硬门槛，--fast 可跳过）→ electron-builder（Setup + portable）→ 生成 latest.yml（更新器发布清单）
// 用法：npm run dist（全量回归）| node scripts/dist.mjs --fast（跳过回归，小改动快发）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
// npm run dist 用系统 node（v16）进入 → 转给本机 node-lts 重入（踩坑 #79 同源，electron-builder 也需 node20+）
if (Number(process.versions.node.split(".")[0]) < 20) {
	const lts = path.join(process.env.LOCALAPPDATA ?? "", "node-lts", "node-v22.14.0-win-x64", "node.exe");
	if (!fs.existsSync(lts)) {
		console.error(`node < 20 且未找到 node-lts（${lts}），无法打包`);
		process.exit(2);
	}
	const r = spawnSync(lts, [SELF, ...process.argv.slice(2)], { stdio: "inherit" });
	process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(SELF), "..");
const NODE = process.execPath;
const run = (label, args, cwd = ROOT) => {
	console.log(`\n═══ ${label} ═══`);
	const r = spawnSync(NODE, args, { cwd, stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`${label} 失败（exit ${r.status}）`);
		process.exit(r.status ?? 1);
	}
};

// 1. E2E 回归（硬门槛；--fast 跳过——小改动不发全量，e2e-all --only <套> 单跑受影响的套件即可，全量留给大版本）
if (process.argv.includes("--fast")) {
	console.log("⏩ --fast：跳过全量 E2E 回归（小改动快发模式）");
} else {
	run("全量 E2E 回归", ["scripts/e2e-all.mjs"]);
}

// 2. electron-builder（node-lts 直跑 cli.js，npm run 会掉回 node16）
// afterPack 钩子（scripts/after-pack.cjs）负责写 app-update.yml（踩坑 #86：缺失则下载阶段 ENOENT 升级链断）
run("electron-builder --win", ["node_modules/electron-builder/cli.js", "--win"]);

// 3. 生成 latest.yml（electron-updater generic 源的发布清单；格式与 e2e-p33 fixture 一致）
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ver = pkg.version;
const exeName = `OpenPi Desktop Setup ${ver}.exe`;
const exePath = path.join(ROOT, "dist", exeName);
if (!fs.existsSync(exePath)) {
	console.error(`未找到 ${exePath}，无法生成 latest.yml`);
	process.exit(1);
}
const buf = fs.readFileSync(exePath);
const sha512 = crypto.createHash("sha512").update(buf).digest("base64");
const releaseAssetName = exeName.replace(/ /g, "."); // GitHub Release 会把资产名空格规范化为点
const latestYml = `version: ${ver}
files:
  - url: ${releaseAssetName}
    sha512: ${sha512}
    size: ${buf.length}
path: ${releaseAssetName}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'`;
fs.writeFileSync(path.join(ROOT, "dist", "latest.yml"), latestYml, "utf8");
console.log(`\n✅ latest.yml 已生成（${ver}，size=${buf.length}）`);
console.log(`发布目录产物：${exeName} + .blockmap + latest.yml → 丢进 HTTP 目录并在 ~/.pi/agent/updater.json 配 url 即可自动更新`);
