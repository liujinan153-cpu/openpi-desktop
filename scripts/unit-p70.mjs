// P70 Release Hardening 单测：URL/路径边界、默认公网更新源、打包配置。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAllowedPreviewUrl, isTrustedTopLevelUrl } from "../src/main/electron-security.mjs";
import { expandHome, isWithin, isWithinReal, resolveAllowedPath, resolveWorkspacePath } from "../src/main/path-policy.mjs";

let total = 0;
const ok = (name, fn) => {
	total++;
	try { fn(); console.log(`PASS ${name}`); }
	catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openpi-p70-"));
const ws = path.join(tmp, "workspace");
const outside = path.join(tmp, "outside");
fs.mkdirSync(ws); fs.mkdirSync(outside);
fs.writeFileSync(path.join(ws, "a.txt"), "ok");
fs.writeFileSync(path.join(outside, "secret.txt"), "no");

ok("顶层 renderer 仅允许自身 file URL", () => {
	const renderer = path.join(ws, "index.html");
	assert.equal(isTrustedTopLevelUrl(pathToFileURL(renderer).href, renderer), true);
	assert.equal(isTrustedTopLevelUrl("https://example.com", renderer), false);
	assert.equal(isTrustedTopLevelUrl(pathToFileURL(path.join(outside, "x.html")).href, renderer), false);
});
ok("preview 协议白名单拒绝 javascript/data", () => {
	for (const u of ["about:blank", "https://example.com", "http://127.0.0.1:3000", pathToFileURL(path.join(ws, "a.txt")).href]) assert.equal(isAllowedPreviewUrl(u), true, u);
	for (const u of ["javascript:alert(1)", "data:text/html,x", "ftp://example.com/a", "not a url"]) assert.equal(isAllowedPreviewUrl(u), false, u);
});
ok("路径按分隔符判断，拒绝同前缀兄弟目录", () => {
	assert.equal(isWithin(ws, path.join(ws, "a.txt")), true);
	assert.equal(isWithin(ws, ws + "-evil/file.txt"), false);
	assert.throws(() => resolveWorkspacePath(ws, "../outside/secret.txt", { mustExist: true }), /允许目录/);
});
ok("允许根目录解析并展开 home", () => {
	assert.equal(resolveAllowedPath([ws], "a.txt", { base: ws, mustExist: true }), path.join(ws, "a.txt"));
	assert.equal(expandHome("~/a", "C:/Users/Test").replace(/\\/g, "/"), "C:/Users/Test/a");
});
ok("真实路径校验阻止可用时的符号链接逃逸", () => {
	const link = path.join(ws, "escape");
	try { fs.symlinkSync(outside, link, "junction"); }
	catch { console.log("SKIP symlink（当前账户无创建权限）"); return; }
	assert.equal(isWithinReal(ws, path.join(link, "secret.txt")), false);
	assert.throws(() => resolveWorkspacePath(ws, path.join(link, "secret.txt"), { mustExist: true }), /允许目录/);
});
ok("默认更新源和发布元数据是 GitHub", () => {
	const updater = fs.readFileSync(path.resolve("src/main/updater.mjs"), "utf8");
	const afterPack = fs.readFileSync(path.resolve("scripts/after-pack.cjs"), "utf8");
	const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
	assert.match(updater, /owner:\s*"liujinan153-cpu"/);
	assert.match(afterPack, /provider: github/);
	assert.equal(pkg.build.publish.provider, "github");
	assert.equal(pkg.build.publish.repo, "openpi-desktop");
	assert.equal(updater.includes("verifyUpdateCodeSignature = async () => true"), false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`unit-p70: ${total} assertions ${process.exitCode ? "FAIL" : "ALL GREEN"}`);
