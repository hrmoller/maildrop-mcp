#!/usr/bin/env node
/**
 * maildrop-mcp — MCP server (stdio) for maildrop.cc disposable inboxes.
 * Tools are thin wrappers over the public GraphQL API; see README for the tool reference.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Maildrop, MaildropError, extractOtp, formatSummaryLine, htmlToText, normalizeMailbox, parseAfter, rawBody } from "./maildrop.js";

const VERSION = "0.2.0";
const MAX_WAIT_S = 240; // keep well inside typical MCP client tool timeouts
const api = new Maildrop();

const mailboxArg = z.string().min(1).describe('Mailbox name, with or without "@maildrop.cc" (e.g. "usual_88081"). Case-insensitive.');
const idArg = z.string().min(1).describe("Message id as returned by list_inbox / wait_for_message.");
const waitArgs = {
	mailbox: mailboxArg,
	subject: z.string().optional().describe("Case-insensitive regex the subject must match, e.g. \"engangskode|one-time\"."),
	from: z.string().optional().describe("Case-insensitive regex the sender (header From or envelope From) must match."),
	after: z.string().optional().describe('Only accept messages dated after this point: ISO-8601 timestamp, "now", or a number of seconds ago. Default: 120 seconds ago. Capture a timestamp BEFORE triggering the mail and pass it here to avoid matching an earlier message.'),
	timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_S).default(120).describe(`How long to keep polling (max ${MAX_WAIT_S}). Polls every 10 s per the maildrop rate-limit guidance.`),
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => {
	const msg = e instanceof MaildropError ? `${e.kind}: ${e.message}` : `error: ${(e as Error).message ?? String(e)}`;
	return { content: [{ type: "text" as const, text: msg }], isError: true };
};
const run = async (fn: () => Promise<{ content: { type: "text"; text: string }[] }>) => {
	try { return await fn(); } catch (e) { return fail(e); }
};

/**
 * Loaded by the client at session start, ahead of any tool definition. Keep it to guidance
 * that is true for every user of maildrop; caller-specific policy (which mailboxes are yours,
 * how your test accounts are named) belongs in the client's own configuration.
 */
const INSTRUCTIONS = `Read maildrop.cc disposable inboxes through these tools rather than opening maildrop.cc in a browser: the web inbox renders the same data and costs far more per read.

Reading cheaply: call list_inbox first (one line per message, no bodies), then get_message for the one you want. get_message defaults to tag-stripped text — a few hundred characters. Ask for "html" or "raw" only when the markup or the headers are the actual question; they are 15-25 KB.

Waiting: use wait_for_message or get_otp instead of polling list_inbox yourself. Capture a timestamp before triggering the mail and pass it as \`after\`, so an older message does not match. maildrop asks that a mailbox not be polled more than once every 10 seconds, and these tools honour that.

Delivery delays: a first mail from a sending server maildrop has not seen is greylisted and can take about 15 minutes. If a wait times out, report that rather than retrying in a tight loop.

Limits: a mailbox holds 10 messages (oldest evicted) and is deleted after 24 hours of inactivity. A missing message may have been evicted rather than never sent.

Privacy: every maildrop mailbox is world-readable to anyone who knows the name, so treat it as a public test surface — never send real personal data there, and read only mailboxes belonging to the account under test. One-time codes are short-lived secrets: use them, do not copy them into tickets, commits, or documentation.`;

const server = new McpServer({ name: "maildrop", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool("list_inbox", {
	title: "List a maildrop inbox",
	description: "List the messages in a maildrop.cc mailbox (newest first, max 10 kept by maildrop). One line per message: id | date | from | subject. Cheap: never fetches bodies. Use before get_message.",
	inputSchema: { mailbox: mailboxArg },
	annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ mailbox }) => run(async () => {
	const inbox = await api.inbox(mailbox);
	if (!inbox.length) return text(`(empty) ${normalizeMailbox(mailbox)}@maildrop.cc`);
	return text(inbox.map(formatSummaryLine).join("\n"));
}));

server.registerTool("get_message", {
	title: "Read one message",
	description: 'Read a message. format "text" (default) returns headers plus the tag-stripped body — a few hundred characters for a typical notification. "html" returns the HTML body, "raw" the full RFC822 source with headers/MIME (15–25 KB) — use those only when debugging rendering or headers.',
	inputSchema: { mailbox: mailboxArg, id: idArg, format: z.enum(["text", "html", "raw"]).default("text") },
	annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ mailbox, id, format }) => run(async () => {
	const fields = format === "raw" ? "id subject date headerfrom data" : "id subject date headerfrom html data";
	const m = await api.message(mailbox, id, fields);
	if (!m) throw new MaildropError(`no message ${id} in ${normalizeMailbox(mailbox)}@maildrop.cc (deleted, expired, or wrong mailbox)`, "not_found");
	if (format === "raw") return text(m.data ?? "");
	if (format === "html") return text(m.html ?? "(no html part)");
	const body = m.html ? htmlToText(m.html) : rawBody(m.data ?? "");
	return text(`id: ${m.id}\ndate: ${m.date}\nfrom: ${m.headerfrom}\nsubject: ${m.subject}\n\n${body}`);
}));

server.registerTool("wait_for_message", {
	title: "Wait for a message to arrive",
	description: "Poll a mailbox until a message dated after `after` (default: 120 s ago) arrives, optionally filtered by subject/from regex. Returns the newest match as text (headers + tag-stripped body). Fails with a timeout after timeoutSeconds. Use get_otp instead when you only need a one-time code.",
	inputSchema: waitArgs,
	annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ mailbox, subject, from, after, timeoutSeconds }, extra) => run(async () => {
	const hit = await api.waitFor({ mailbox, subject, from, after: parseAfter(after), timeoutS: timeoutSeconds, signal: extra.signal });
	const m = await api.message(mailbox, hit.id, "id subject date headerfrom html data");
	const body = m?.html ? htmlToText(m.html) : rawBody(m?.data ?? "");
	return text(`id: ${hit.id}\ndate: ${hit.date}\nfrom: ${hit.headerfrom}\nsubject: ${hit.subject}\n\n${body}`);
}));

server.registerTool("get_otp", {
	title: "Get a one-time code",
	description: "Wait for a message (same filters as wait_for_message) and return only the one-time code / verification code found in it. Looks for 4–8 digits (or exactly `digits`), preferring a number that follows a cue word such as code/kode/PIN. Returns just the code. Codes are short-lived secrets: use them, do not record them.",
	inputSchema: { ...waitArgs, digits: z.number().int().min(4).max(10).optional().describe("Exact code length if known (e.g. 6). Default: any 4–8 digit run.") },
	annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ mailbox, subject, from, after, timeoutSeconds, digits }, extra) => run(async () => {
	const hit = await api.waitFor({ mailbox, subject, from, after: parseAfter(after), timeoutS: timeoutSeconds, signal: extra.signal });
	const m = await api.message(mailbox, hit.id, "html data");
	const body = m?.html ? htmlToText(m.html) : (m?.data ?? "");
	const code = extractOtp(body, digits);
	if (!code) throw new MaildropError(`message ${hit.id} ("${hit.subject}") matched but contains no ${digits ?? "4-8"}-digit code; read it with get_message`, "no_code");
	return text(code);
}));

server.registerTool("delete_message", {
	title: "Delete a message",
	description: "Delete one message from a mailbox. Useful to make room (maildrop keeps only 10) or to remove a consumed code.",
	inputSchema: { mailbox: mailboxArg, id: idArg },
	annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
}, ({ mailbox, id }) => run(async () => text((await api.delete(mailbox, id)) ? `deleted ${id}` : `not deleted (${id} already gone?)`)));

server.registerTool("get_alias", {
	title: "Get the mailbox alias",
	description: "Return the maildrop alias address (D-…@maildrop.cc) for a mailbox. Mail sent to the alias lands in the real mailbox without revealing its name — hand the alias to third-party systems whose logs you do not control.",
	inputSchema: { mailbox: mailboxArg },
	annotations: { readOnlyHint: true, openWorldHint: true },
}, ({ mailbox }) => run(async () => text(await api.alias(mailbox))));

server.registerTool("service_status", {
	title: "maildrop service status",
	description: "Report whether maildrop.cc is operational, with its global saved/blocked message counters.",
	inputSchema: {},
	annotations: { readOnlyHint: true, openWorldHint: true },
}, () => run(async () => {
	const s = await api.status();
	return text(`status: ${s.status}  saved: ${s.statistics.saved}  blocked: ${s.statistics.blocked}`);
}));

await server.connect(new StdioServerTransport());
