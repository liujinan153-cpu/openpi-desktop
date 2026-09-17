// 打包产物 smoke：不调用模型，不改用户配置。
// 验证安装包/portable/blockmap/latest.yml、SHA-512、unpacked 运行时及 app.asar 关键依赖。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ver = pkg.version;
const setup = `OpenPi Desktop Setup ${ver}.exe`;
const portable = `OpenPi Desktop ${ver}.exe`;
const blockmap = `${setup}.blockmap`;
const required = [setup, portable, blockmap, "latest.yml"];
let fails = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`); if (!cond) fails++; };
for (const f of required) ok(`产物 ${f}`, fs.existsSync(path.join(DIST, f)) && fs.statSync(path.join(DIST, f)).size > 0);
if (!fails) {
	const yml = fs.readFileSync(path.join(DIST, "latest.yml"), "utf8");
	const expectedName = setup.replace(/ /g, ".");
	const expectedSha = crypto.createHash("sha512").update(fs.readFileSync(path.join(DIST, setup))).digest("base64");
	ok("latest.yml 版本", yml.includes(`version: ${ver}`));
	ok("latest.yml 使用 GitHub 资产名", yml.includes(`url: ${expectedName}`) && yml.includes(`path: ${expectedName}`));
	ok("latest.yml SHA-512", yml.includes(`sha512: ${expectedSha}`));
}
const unpacked = path.join(DIST, "win-unpacked");
const appAsar = path.join(unpacked, "resources", "app.asar");
if (fs.existsSync(appAsar)) {
	const list = asar.listPackage(appAsar).map((p) => p.replace(/^[/\\]/, "").replace(/\\/g, "/"));
	for (const rel of ["src/main/main.mjs", "src/main/agent-worker.mjs", "node_modules/chrome-remote-interface/package.json", "node_modules/better-sqlite3/package.json"]) {
		ok(`asar 包含 ${rel}`, list.includes(rel));
	}
	const feed = path.join(unpacked, "resources", "app-update.yml");
	ok("打包默认公网更新源", fs.existsSync(feed) && /provider:\s*github/.test(fs.readFileSync(feed, "utf8")));
	ok("内置 Python", fs.existsSync(path.join(unpacked, "resources", "runtime", "python", "python3.exe")));
} else console.log("SKIP unpacked smoke（dist/win-unpacked 不存在；先运行 dist）");
console.log(fails ? `\nFAIL package smoke: ${fails}` : "\nPASS package smoke");
process.exit(fails ? 1 : 0);
