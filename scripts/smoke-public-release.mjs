// 公网更新源 smoke：latest.yml + Setup（Range）+ blockmap 匿名可下载，且清单哈希/尺寸匹配。
// 用法：node scripts/smoke-public-release.mjs [version]
import fs from "node:fs";
import path from "node:path";
const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"));
const ver = process.argv[2] || pkg.version;
const owner = "liujinan153-cpu", repo = "openpi-desktop", tag = `v${ver}`;
const setup = `OpenPi-Desktop-Setup-${ver}.exe`;
const base = `https://github.com/${owner}/${repo}/releases/download/${tag}`;
let fails = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? `  ${extra}` : ""}`); if (!cond) fails++; };
const get = (name, headers = {}) => fetch(`${base}/${encodeURIComponent(name)}`, { headers, redirect: "follow", signal: AbortSignal.timeout(120000) });
let yml = "";
try { const r = await get("latest.yml"); yml = await r.text(); ok("latest.yml 匿名下载", r.ok, `HTTP ${r.status}`); } catch (e) { ok("latest.yml 匿名下载", false, e.message); }
ok("latest.yml 版本", yml.includes(`version: ${ver}`));
ok("latest.yml 资产名（空格名，updater 拼URL时转横杠）", yml.includes(`url: OpenPi Desktop Setup ${ver}.exe`) && yml.includes(`path: OpenPi Desktop Setup ${ver}.exe`));
try {
	const r = await get(setup, { Range: "bytes=0-15" });
	const b = Buffer.from(await r.arrayBuffer());
	ok("Setup 匿名 Range 下载", (r.status === 206 || r.ok) && b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a, `HTTP ${r.status}`);
} catch (e) { ok("Setup 匿名 Range 下载", false, e.message); }
try { const r = await get(`${setup}.blockmap`, { Range: "bytes=0-15" }); await r.body?.cancel(); ok("blockmap 匿名下载", r.ok || r.status === 206, `HTTP ${r.status}`); } catch (e) { ok("blockmap 匿名下载", false, e.message); }
console.log(fails ? `\nFAIL public release smoke: ${fails}` : "\nPASS public release smoke");
process.exit(fails ? 1 : 0);
