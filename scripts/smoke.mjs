#!/usr/bin/env node
// End-to-end smoke test over stdio: initialize → tools/list → service_status → list_inbox.
// Usage: node scripts/smoke.mjs [mailbox]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const mailbox = process.argv[2] ?? "maildrop-mcp-smoke";
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
	buf += d;
	let i;
	while ((i = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
		if (!line) continue;
		const msg = JSON.parse(line);
		if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
	}
});
let seq = 0;
const send = (method, params) => new Promise((resolve) => {
	const id = ++seq; pending.set(id, resolve);
	child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
console.log("server:", init.result.serverInfo);
notify("notifications/initialized", {});
const tools = await send("tools/list", {});
console.log("tools:", tools.result.tools.map((t) => t.name).join(", "));
const status = await send("tools/call", { name: "service_status", arguments: {} });
console.log("service_status →", status.result.content[0].text);
const inbox = await send("tools/call", { name: "list_inbox", arguments: { mailbox } });
console.log(`list_inbox(${mailbox}) →`, inbox.result.content[0].text.split("\n").slice(0, 3).join("\n"));
const bad = await send("tools/call", { name: "get_message", arguments: { mailbox, id: "nope" } });
console.log("get_message(bad id) → isError:", bad.result.isError, "|", bad.result.content[0].text);
child.kill();
process.exit(0);
