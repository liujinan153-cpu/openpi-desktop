// 极简 MCP stdio server（E2E 测试夹具）：JSON-RPC 2.0 按行分隔，实现 initialize / tools/list / tools/call
// 协议参考 MCP 规范；零依赖，兼容 node >= 16
import readline from "node:readline";

const TOOLS = [
	{
		name: "echo",
		description: "原样返回输入文本，用于验证 MCP 桥连通性",
		inputSchema: {
			type: "object",
			properties: { text: { type: "string", description: "要回显的文本" } },
			required: ["text"],
		},
	},
	{
		name: "add",
		description: "两数相加，验证参数类型",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
];

function reply(id, result) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyErr(id, code, message) {
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	const { id, method, params } = msg;
	if (method === "initialize") {
		reply(id, {
			protocolVersion: params?.protocolVersion ?? "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "p28-echo", version: "1.0.0" },
		});
		return;
	}
	if (method === "ping") { reply(id, {}); return; }
	if (method === "tools/list") { reply(id, { tools: TOOLS }); return; }
	if (method === "tools/call") {
		const name = params?.name;
		const args = params?.arguments ?? {};
		if (name === "echo") {
			reply(id, { content: [{ type: "text", text: `ECHO:${args.text ?? ""}` }] });
		} else if (name === "add") {
			reply(id, { content: [{ type: "text", text: `SUM:${Number(args.a) + Number(args.b)}` }] });
		} else {
			reply(id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
		}
		return;
	}
	if (id !== undefined) replyErr(id, -32601, `method not found: ${method}`);
});
process.stdin.on("end", () => process.exit(0));
