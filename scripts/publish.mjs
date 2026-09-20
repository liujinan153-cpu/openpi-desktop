// OpenPi Desktop 发布工具：dist/ 三件套 → 本地更新源（http://127.0.0.1:9355/）+ GitHub Release（公网，P70）
// 用法：npm run dist 通过后 → node scripts/publish.mjs
// 前置：本地发布源（E:/pi2/openpi-releases/server.bat）在跑；GitHub 凭据在 git credential（GCM）或 GITHUB_TOKEN
// 坑 #121 家族：GitHub 资产名空格→点，而 electron-updater 按「空格→横杠」拼 URL——上传时直接用横杠名；
//        大文件上传必须 --http1.1 + 禁 Expect，否则代理隧道下报 "Error saving asset"/挂死
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const UPDATER_CFG = path.join(os.homedir(), ".pi", "agent", "updater.json");
const DIST = path.join(ROOT, "dist");
const RELEASE = "E:/pi2/openpi-releases";
const URL = "http://127.0.0.1:9355/";

const GH_OWNER = "liujinan153-cpu";
const GH_REPO = "openpi-desktop";
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}`;
const GH_UPLOAD = `https://uploads.github.com/repos/${GH_OWNER}/${GH_REPO}/releases`;
const CURL_FALLBACK = "C:/Program Files/Git/mingw64/bin/curl.exe";

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const ver = pkg.version;
const setup = `OpenPi Desktop Setup ${ver}.exe`;
const files = [setup, `${setup}.blockmap`, "latest.yml"];
const ghName = (f) => f.replace(/ /g, "-");

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

// 3) 拷贝本地发布源
for (const f of files) fs.copyFileSync(path.join(DIST, f), path.join(RELEASE, f));
console.log(`✔ 已发布 v${ver} → ${RELEASE}`);

// 4) 本地源存活自检
try {
	const got = execSync(`curl -s --noproxy "*" --max-time 5 ${URL}latest.yml`, { encoding: "utf8" });
	if (!got.includes(`version: ${ver}`)) throw new Error(`返回内容不含 ${ver}`);
	console.log(`✔ 本地更新源在线自检通过：${URL} → v${ver}`);
} catch (e) {
	console.error(`✘ 本地源 ${URL} 不可达或内容不对：${e.message}`);
	console.error(`  修复：重启发布源（双击 ${RELEASE}/server.bat）——不阻断 GitHub 发布，继续`);
}

// ---------- GitHub Release 发布（P70 公网） ----------
function ghToken() {
	if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
	const input = "protocol=https\nhost=github.com\n\n";
	for (const git of ["git", "C:/Program Files/Git/cmd/git.exe"]) {
		try {
			const out = execSync(`"${git}" credential fill`, { input, encoding: "utf8" });
			const m = out.match(/password=(.+)/);
			if (m) return m[1].trim();
		} catch {
			/* 试下一个路径 */
		}
	}
	throw new Error("拿不到 GitHub 凭据：GCM 未登录或 Git 不在——先跑一次 git push 触发登录，或设 GITHUB_TOKEN");
}

const TOKEN = ghToken();
const H = { Authorization: `token ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };
const gh = async (url, opts = {}) => {
	const r = await fetch(url, { headers: H, ...opts });
	const t = await r.text();
	let j = null;
	try {
		j = JSON.parse(t);
	} catch {
		/* 非 JSON（如 HTML 错误页） */
	}
	if (!r.ok) throw new Error(`${r.status} ${url.split("?")[0]}: ${(j?.message ?? t.slice(0, 120))}`);
	return j;
};

// CHANGELOG 摘 release 说明（## ver（…）到下一个 ## 之间），失败不阻断
function releaseBody(v) {
	try {
		const md = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
		const m = md.match(new RegExp(`## ${v.replace(/\./g, "\\.")}[\\s\\S]*?(?=\\n## |$)`));
		return m ? m[0].trim() : `OpenPi Desktop ${v}`;
	} catch {
		return `OpenPi Desktop ${v}`;
	}
}

async function ensureRelease() {
	const tag = `v${ver}`;
	const exist = await fetch(`${GH_API}/releases/tags/${tag}`, { headers: H }).then((r) => (r.ok ? r.json() : null));
	if (exist) return exist;
	console.log(`GitHub：创建 Release ${tag} …`);
	return gh(`${GH_API}/releases`, {
		method: "POST",
		body: JSON.stringify({ tag_name: tag, name: `OpenPi Desktop ${ver}`, body: releaseBody(ver), draft: false, prerelease: false }),
	});
}

function curlBin() {
	return fs.existsSync(CURL_FALLBACK) ? `"${CURL_FALLBACK}"` : "curl";
}

async function uploadAsset(relId, filePath, name) {
	const list = await gh(`${GH_UPLOAD.replace("uploads.github.com/repos", "api.github.com/repos")}/${relId}/assets?per_page=100`);
	for (const a of list) {
		if (a.name === name || a.state !== "uploaded") {
			console.log(`  清理旧资产 ${a.name} (${a.state})`);
			await gh(`${GH_API}/releases/assets/${a.id}`, { method: "DELETE" }).catch(() => {});
		}
	}
	const t0 = Date.now();
	// P76 坐坑：312MB 大文件直传公网易遇 ECONNABORTED/ECONNRESET（实测两连断）——3 次退避重试（30s/60s/120s）
	let lastErr = null;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const resp = execFileSync(
				fs.existsSync(CURL_FALLBACK) ? CURL_FALLBACK : "curl",
				["-s", "--http1.1", "-H", "Expect:", "--max-time", "2400", "-X", "POST", "-H", `Authorization: token ${TOKEN}`, "-H", "Content-Type: application/octet-stream", "--data-binary", `@${filePath}`, `${GH_UPLOAD}/${relId}/assets?name=${encodeURIComponent(name)}`],
				{ encoding: "utf8", maxBuffer: 10e6, timeout: 2_500_000, shell: false },
			);
			const j = JSON.parse(resp);
			if (j.state !== "uploaded") throw new Error(`上传 ${name} 异常：state=${j.state} ${j.message ?? ""}`);
			console.log(`  ✔ ${name}（${(j.size / 1e6).toFixed(0)}MB，${((Date.now() - t0) / 60000).toFixed(1)} 分钟${attempt > 1 ? `，第 ${attempt} 次重试成功` : ""}）`);
			return;
		} catch (err) {
			lastErr = err;
			if (attempt < 3) {
				const wait = attempt * 30_000;
				console.log(`  ⚠ ${name} 第 ${attempt} 次上传失败（${String(err?.message ?? err).slice(0, 120)}），${wait / 1000}s 后重试…`);
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, null, wait);
			}
		}
	}
	throw lastErr;
}

console.log(`GitHub：发布 v${ver} → ${GH_OWNER}/${GH_REPO}`);
const rel = await ensureRelease();
for (const f of files) {
	console.log(`  上传 ${ghName(f)} …`);
	await uploadAsset(rel.id, path.join(DIST, f), ghName(f));
}

// 匿名自检（模拟用户更新器：无 token 拉 latest release + 直链）
const anon = await fetch(`${GH_API}/releases/latest`).then((r) => r.json());
if (anon.tag_name !== `v${ver}`) throw new Error(`匿名 latest=${anon.tag_name} ≠ v${ver}`);
for (const f of files) {
	const u = `https://github.com/${GH_OWNER}/${GH_REPO}/releases/download/v${ver}/${ghName(f)}`;
	const head = await fetch(u, { method: "HEAD", redirect: "follow" });
	if (!head.ok) throw new Error(`匿名直链不可达 ${ghName(f)}: ${head.status}`);
}
console.log(`✔ GitHub 匿名自检通过：releases/latest = v${ver}，三件套直链全 200`);
console.log(`  https://github.com/${GH_OWNER}/${GH_REPO}/releases/tag/v${ver}`);

// 5) updater.json 指向自检（P37.2 踩坑 #88：e2e 曾把指向改成 e2e 端口 9398 且不还原）
// P70 起默认 GitHub 源；本地 RELEASE 目录保留作局域网兜底
const GH_CFG = { provider: "github", owner: GH_OWNER, repo: GH_REPO };
try {
	const cfg = JSON.parse(fs.readFileSync(UPDATER_CFG, "utf8"));
	const ghOk = cfg.provider === "github" && cfg.owner && cfg.repo;
	if (!ghOk) {
		console.error(`⚠ updater.json 指向 ${JSON.stringify(cfg).slice(0, 80)} ≠ GitHub 源，已自动修正`);
		fs.writeFileSync(UPDATER_CFG, JSON.stringify(GH_CFG, null, 2));
	}
} catch (e) {
	console.error(`⚠ updater.json 读取失败（${e.message}），已重建`);
	fs.writeFileSync(UPDATER_CFG, JSON.stringify(GH_CFG, null, 2));
}
console.log(`\n完成。GitHub Release 已发布，已装用户应用内「设置 → 检查更新」即可升到 v${ver}。`);
