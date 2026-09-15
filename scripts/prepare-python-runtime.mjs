// P36：准备内置 Python 运行时（安装即用，办公技能零依赖）
// 产物：resources/runtime/python/（embeddable CPython + 预装 site-packages + python3.exe 别名）
// 幂等：已存在且自验通过则跳过（FORCE=1 强制重建）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = path.join(ROOT, "resources", "runtime", "python");
const PY_VER = "3.12.10";
const EMBED_URL = `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`;
const CACHE = path.join(os.tmpdir(), "openpi-python-embed.zip");
const DEPS = ["python-docx", "openpyxl", "python-pptx", "lxml", "Pillow", "pypdf", "reportlab", "PyMuPDF", "py7zr", "pikepdf", "pdfplumber", "defusedxml"];

const selfCheck = () => {
	const py3 = path.join(RUNTIME, "python3.exe");
	if (!fs.existsSync(py3)) return false;
	const r = spawnSync(py3, ["-c", "import docx, openpyxl, pptx, pypdf, reportlab, fitz, lxml, PIL, py7zr, pikepdf, pdfplumber, defusedxml; print('OK')"], { encoding: "utf8", timeout: 60000 });
	return r.status === 0 && r.stdout.includes("OK");
};

const download = (url, dest) =>
	new Promise((resolve, reject) => {
		const get = (u, redirects = 0) => {
			if (redirects > 5) return reject(new Error("too many redirects"));
			https.get(u, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location, redirects + 1);
				if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
				const f = fs.createWriteStream(dest);
				res.pipe(f);
				f.on("finish", () => f.close(resolve));
				f.on("error", reject);
			}).on("error", reject);
		};
		get(url);
	});

const dirSize = (p) => {
	let n = 0;
	for (const e of fs.readdirSync(p, { withFileTypes: true, recursive: true })) {
		if (e.isFile()) { try { n += fs.statSync(path.join(e.parentPath ?? p, e.name)).size; } catch { /* races */ } }
	}
	return n;
};

// 幂等检查
if (!process.env.FORCE && selfCheck()) {
	console.log(`内置 Python 运行时已就绪（${(dirSize(RUNTIME) / 1048576).toFixed(1)} MB），跳过`);
	process.exit(0);
}
console.log("构建内置 Python 运行时…");
fs.rmSync(RUNTIME, { recursive: true, force: true });
fs.mkdirSync(RUNTIME, { recursive: true });

// 1. 下载 embeddable 包（缓存）
if (!fs.existsSync(CACHE) || fs.statSync(CACHE).size < 1000000) {
	console.log(`下载 ${EMBED_URL}`);
	await download(EMBED_URL, CACHE);
} else {
	console.log("使用缓存的 embeddable 包");
}

// 2. 解压（PowerShell Expand-Archive，Windows 自带）
console.log("解压…");
const r = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${CACHE}' -DestinationPath '${RUNTIME.replace(/'/g, "''")}'`], { stdio: "inherit" });
if (r.status !== 0) throw new Error("解压失败");

// 3. 启用 site-packages：编辑 ._pth（默认全注释，不加就没法 import 第三方包）
const pthFile = fs.readdirSync(RUNTIME).find((f) => f.endsWith("._pth"));
if (!pthFile) throw new Error("未找到 ._pth");
fs.writeFileSync(
	path.join(RUNTIME, pthFile),
	["python312.zip", ".", "Lib/site-packages", "import site", ""].join("\n"),
	"utf8",
);
console.log(`已启用 ${pthFile} → Lib/site-packages`);

// 4. 用本机 Python 的 pip 把依赖预装进 runtime（--target 纯解压，同版本 C 扩展直接可用）
const hostPy = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
if (!fs.existsSync(hostPy)) throw new Error(`未找到宿主 Python（${hostPy}）——先 winget 安装 Python.3.12`);
const siteDir = path.join(RUNTIME, "Lib", "site-packages");
fs.mkdirSync(siteDir, { recursive: true });
console.log("pip 安装依赖到内置 site-packages…");
const rp = spawnSync(hostPy, ["-m", "pip", "install", "--quiet", "--no-compile", "--target", siteDir, ...DEPS], { stdio: "inherit" });
if (rp.status !== 0) throw new Error("pip 安装失败");

// 5. python3.exe 别名（技能脚本统一调 python3）
fs.copyFileSync(path.join(RUNTIME, "python.exe"), path.join(RUNTIME, "python3.exe"));

// 6. 自验
if (!selfCheck()) throw new Error("内置运行时自验失败");
console.log(`✅ 内置 Python 运行时就绪：${(dirSize(RUNTIME) / 1048576).toFixed(1)} MB`);
console.log("   " + spawnSync(path.join(RUNTIME, "python3.exe"), ["--version"], { encoding: "utf8" }).stdout.trim());
