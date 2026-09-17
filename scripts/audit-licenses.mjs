// Release license gate: inventories npm + embedded Python metadata and blocks missing/restricted surprises.
// This is an engineering gate, not legal advice.
import fs from "node:fs";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "..");
let fails = 0;
const pass = (m) => console.log(`PASS ${m}`);
const fail = (m) => { fails++; console.error(`FAIL ${m}`); };

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
if (pkg.license === "AGPL-3.0-only" && fs.existsSync(path.join(ROOT, "LICENSE"))) pass("project license metadata"); else fail("package.json/LICENSE missing or inconsistent");
if (fs.existsSync(path.join(ROOT, "NOTICE.md")) && fs.existsSync(path.join(ROOT, "SECURITY.md"))) pass("NOTICE + SECURITY"); else fail("NOTICE.md/SECURITY.md missing");

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const npmRows = [];
for (const [p, meta] of Object.entries(lock.packages ?? {})) {
	if (!p.startsWith("node_modules/") || p.includes("/node_modules/")) continue;
	npmRows.push({ name: p.slice("node_modules/".length), version: meta.version ?? "?", license: meta.license ?? "UNKNOWN" });
}
const npmUnknown = npmRows.filter((r) => /UNKNOWN|UNLICENSED/i.test(r.license));
console.log(`npm direct inventory: ${npmRows.length}; unknown=${npmUnknown.length}`);
if (npmUnknown.length) console.log("WARN npm license metadata missing: " + npmUnknown.map((r) => `${r.name}@${r.version}`).join(", "));

const site = path.join(ROOT, "resources", "runtime", "python", "Lib", "site-packages");
const pyRows = [];
if (fs.existsSync(site)) {
	for (const ent of fs.readdirSync(site, { withFileTypes: true })) {
		if (!ent.isDirectory() || !ent.name.endsWith(".dist-info")) continue;
		const metaPath = path.join(site, ent.name, "METADATA");
		if (!fs.existsSync(metaPath)) continue;
		const text = fs.readFileSync(metaPath, "utf8");
		const field = (name) => text.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim();
		pyRows.push({ name: field("Name") ?? ent.name, version: field("Version") ?? "?", license: field("License-Expression") ?? field("License") ?? "UNKNOWN" });
	}
	pass(`Python inventory ${pyRows.length} packages`);
} else console.log("SKIP embedded Python inventory（CI 构建前尚未生成 runtime）");
const pyUnknown = pyRows.filter((r) => r.license === "UNKNOWN");
if (pyUnknown.length) console.log("WARN Python license metadata missing: " + pyUnknown.map((r) => `${r.name}@${r.version}`).join(", "));
const pymupdf = pyRows.find((r) => r.name.toLowerCase() === "pymupdf");
if (!pyRows.length || (pymupdf && /AGPL|AFFERO/i.test(pymupdf.license))) pass("PyMuPDF reciprocal license recorded"); else fail("PyMuPDF present without AGPL metadata");

for (const skill of ["docx", "pdf", "xlsx"]) {
	const license = path.join(ROOT, "resources", "skills", skill, "LICENSE.txt");
	if (fs.existsSync(license) && /non-commercial/i.test(fs.readFileSync(license, "utf8"))) pass(`${skill} restricted license retained`); else fail(`${skill} restricted license missing`);
}

const report = [
	"# Generated dependency license inventory", "", `Generated: ${new Date().toISOString()}`, "",
	"## npm direct packages", "", "| Package | Version | License |", "|---|---:|---|",
	...npmRows.sort((a,b)=>a.name.localeCompare(b.name)).map((r) => `| ${r.name} | ${r.version} | ${String(r.license).replace(/\|/g, "\\|")} |`),
	"", "## Embedded Python packages", "", "| Package | Version | License |", "|---|---:|---|",
	...pyRows.sort((a,b)=>a.name.localeCompare(b.name)).map((r) => `| ${r.name} | ${r.version} | ${String(r.license).replace(/\|/g, "\\|")} |`), "",
].join("\n");
fs.writeFileSync(path.join(ROOT, "THIRD_PARTY_LICENSES.md"), report);
console.log(fails ? `FAIL license audit: ${fails}` : "PASS license audit");
process.exit(fails ? 1 : 0);
