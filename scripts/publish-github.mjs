// OpenPi Desktop 公网发布：dist 三件套 → GitHub Releases。
// 认证：优先 OPENPI_GH_TOKEN；其次 GH_TOKEN。令牌只读环境变量，不调用交互式 credential helper。
// 用法：node scripts/publish-github.mjs [owner/repo] [--replace]
import fs from "node:fs";
import path from "node:path";

const repoArg = process.argv[2]?.includes("/") ? process.argv[2] : "liujinan153-cpu/openpi-desktop";
const replace = process.argv.includes("--replace");
const TOKEN = process.env.OPENPI_GH_TOKEN || process.env.GH_TOKEN || "";
if (!/^[^/\s]+\/[^/\s]+$/.test(repoArg)) throw new Error("仓库格式应为 owner/repo");
if (!TOKEN) {
	console.error("缺少 OPENPI_GH_TOKEN 或 GH_TOKEN（GitHub fine-grained token：Contents read/write）");
	process.exit(1);
}
const [owner, repo] = repoArg.split("/");
const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ver = pkg.version;
const localSetup = `OpenPi Desktop Setup ${ver}.exe`;
const assetSetup = localSetup.replace(/ /g, ".");
const files = [
	{ local: localSetup, name: assetSetup, type: "application/octet-stream" },
	{ local: `${localSetup}.blockmap`, name: `${assetSetup}.blockmap`, type: "application/octet-stream" },
	{ local: "latest.yml", name: "latest.yml", type: "text/yaml" },
];
for (const f of files) if (!fs.existsSync(path.join(DIST, f.local))) throw new Error(`dist 缺少 ${f.local}`);
const yml = fs.readFileSync(path.join(DIST, "latest.yml"), "utf8");
if (!yml.includes(`version: ${ver}`) || !yml.includes(`url: ${assetSetup}`)) throw new Error("latest.yml 版本或 GitHub 资产名不匹配，请重新运行 dist.mjs");
const tag = `v${ver}`;
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(apiPath, opts = {}) {
	const r = await fetch(`https://api.github.com${apiPath}`, {
		...opts,
		headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "openpi-desktop-publisher", ...(opts.headers ?? {}) },
		signal: opts.signal ?? AbortSignal.timeout(120000),
	});
	const text = await r.text();
	if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 500)}`);
	return text ? JSON.parse(text) : null;
}

async function upload(uploadUrl, file) {
	const buf = fs.readFileSync(path.join(DIST, file.local));
	for (let attempt = 1; attempt <= 3; attempt++) {
		const r = await fetch(`${uploadUrl.split("{")[0]}?name=${enc(file.name)}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": file.type, "Content-Length": String(buf.length), "User-Agent": "openpi-desktop-publisher" },
			body: buf,
			signal: AbortSignal.timeout(35 * 60_000),
		});
		if (r.ok) return r.json();
		const text = await r.text();
		if (r.status !== 429 && r.status < 500) throw new Error(`上传 ${file.name} 失败：${r.status} ${text.slice(0, 300)}`);
		await sleep(attempt * 5000);
	}
	throw new Error(`上传 ${file.name} 重试耗尽`);
}

let release;
try { release = await api(`/repos/${owner}/${repo}/releases/tags/${enc(tag)}`); }
catch {
	release = await api(`/repos/${owner}/${repo}/releases`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ tag_name: tag, target_commitish: "main", name: `OpenPi Desktop ${ver}`, body: "See CHANGELOG.md for details.", draft: false, prerelease: false }),
	});
}
if (replace) {
	for (const a of release.assets ?? []) {
		if (files.some((f) => f.name === a.name)) {
			await api(`/repos/${owner}/${repo}/releases/assets/${a.id}`, { method: "DELETE" });
			console.log(`删除旧资产：${a.name}`);
		}
	}
	release = await api(`/repos/${owner}/${repo}/releases/tags/${enc(tag)}`);
}
for (const file of files) {
	if (release.assets?.some((a) => a.name === file.name && a.state === "uploaded")) { console.log(`跳过已存在：${file.name}`); continue; }
	console.log(`上传 ${file.name} (${(fs.statSync(path.join(DIST, file.local)).size / 1048576).toFixed(1)} MiB)…`);
	await upload(release.upload_url, file);
}

// 匿名公网自检，Range 避免为验证再次完整下载 300MB 安装包。
const base = `https://github.com/${owner}/${repo}/releases/download/${enc(tag)}`;
const check = async (name, range = false) => {
	const r = await fetch(`${base}/${enc(name)}`, { headers: range ? { Range: "bytes=0-15" } : {}, redirect: "follow", signal: AbortSignal.timeout(120000) });
	if (!(r.ok || r.status === 206)) throw new Error(`匿名下载自检失败 ${name}: HTTP ${r.status}`);
	await r.body?.cancel();
};
await check("latest.yml");
await check(assetSetup, true);
await check(`${assetSetup}.blockmap`);
console.log(`发布完成：https://github.com/${owner}/${repo}/releases/tag/${tag}`);
