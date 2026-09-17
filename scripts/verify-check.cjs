// 统一语法检查：.mjs 与 type:module 的 .js 通过 stdin + --input-type=module 检查。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const ROOT = path.resolve(__dirname, "..");
const roots = [path.join(ROOT, "src"), path.join(ROOT, "scripts")];
const files = [];
const walk = (dir) => {
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		if (["node_modules", "dist", "runtime"].includes(ent.name)) continue;
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) walk(full);
		else if (/\.(?:mjs|cjs|js)$/.test(ent.name)) files.push(full);
	}
};
for (const root of roots) walk(root);
let failed = 0;
for (const file of files) {
	const ext = path.extname(file);
	const moduleMode = ext === ".mjs" || ext === ".js";
	const r = moduleMode
		? spawnSync(process.execPath, ["--input-type=module", "--check"], { input: fs.readFileSync(file), encoding: "utf8" })
		: spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
	if (r.status !== 0) {
		failed++;
		console.error(`FAIL ${path.relative(ROOT, file)}\n${r.stderr || r.stdout}`);
	}
}
console.log(`${failed ? "FAIL" : "PASS"} syntax ${files.length - failed}/${files.length}`);
process.exit(failed ? 1 : 0);
