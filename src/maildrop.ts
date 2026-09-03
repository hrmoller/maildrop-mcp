/**
 * Thin client for the maildrop.cc GraphQL API plus the helpers the MCP tools share.
 * Facts verified against the live API on 2026-09-03; see README "API facts".
 */

export const API_URL = "https://api.maildrop.cc/graphql";
/** Docs: never poll one mailbox more often than every ten seconds. */
export const MIN_POLL_INTERVAL_S = 10;
export const LIST_FIELDS = "id date headerfrom mailfrom subject";

export interface MessageSummary {
	id: string;
	date: string;
	headerfrom: string | null;
	mailfrom: string | null;
	subject: string | null;
}

export interface Message extends MessageSummary {
	ip?: string | null;
	helo?: string | null;
	rcptto?: string[] | null;
	/** Full raw RFC822 source including headers and MIME parts. */
	data?: string | null;
	/** Decoded HTML body, or null for plaintext-only mail. */
	html?: string | null;
}

export class MaildropError extends Error {
	constructor(message: string, public readonly kind: "api" | "network" | "not_found" | "timeout" | "no_code" | "usage") {
		super(message);
		this.name = "MaildropError";
	}
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new MaildropError("aborted", "usage"));
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(t); reject(new MaildropError("aborted", "usage")); }, { once: true });
	});

/** POST a GraphQL document; retries 429 with exponential backoff. */
export interface ClientOptions {
	/** Initial 429 backoff in ms (doubles per retry, 3 retries). Default 5000. */
	backoffMs?: number;
}

export async function gql<T = any>(query: string, variables: Record<string, unknown> = {}, fetchImpl: typeof fetch = fetch, opts: ClientOptions = {}): Promise<T> {
	let backoffMs = opts.backoffMs ?? 5000;
	for (let attempt = 0; ; attempt++) {
		let res: Response;
		try {
			res = await fetchImpl(API_URL, {
				method: "POST",
				headers: { "content-type": "application/json", "user-agent": "maildrop-mcp/0.1" },
				body: JSON.stringify({ query, variables }),
			});
		} catch (e) {
			throw new MaildropError(`network error: ${(e as Error).message}`, "network");
		}
		if (res.status === 429 && attempt < 3) {
			await sleep(backoffMs);
			backoffMs *= 2;
			continue;
		}
		if (!res.ok) throw new MaildropError(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, "api");
		const payload = (await res.json()) as { data?: T; errors?: { message: string }[] };
		if (payload.errors?.length) throw new MaildropError("GraphQL error: " + payload.errors.map((e) => e.message).join("; "), "api");
		return payload.data as T;
	}
}

/** The API wants the local part only; `name@maildrop.cc` silently yields an empty inbox. */
export function normalizeMailbox(input: string): string {
	const mb = input.trim();
	if (!mb) throw new MaildropError("mailbox is empty", "usage");
	const at = mb.indexOf("@");
	if (at === -1) return mb;
	const domain = mb.slice(at + 1).toLowerCase();
	if (domain !== "maildrop.cc") throw new MaildropError(`not a maildrop.cc address: ${mb}`, "usage");
	return mb.slice(0, at);
}

export function htmlToText(html: string): string {
	let s = html;
	s = s.replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ");
	s = s.replace(/<!--[\s\S]*?-->/g, " ");
	s = s.replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6]|td)>/gi, "\n");
	s = s.replace(/<[^>]+>/g, " ");
	s = decodeEntities(s);
	const lines = s.split(/\r?\n/).map((l) => l.replace(/[ \t ]+/g, " ").trim());
	const out: string[] = [];
	let blank = 0;
	for (const l of lines) {
		if (l) { out.push(l); blank = 0; }
		else if (++blank === 1) out.push("");
	}
	return out.join("\n").trim();
}

function decodeEntities(s: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", ndash: "–", mdash: "—", aelig: "æ", oslash: "ø", aring: "å", AElig: "Æ", Oslash: "Ø", Aring: "Å" };
	return s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&([a-zA-Z]+);/g, (m, n) => named[n] ?? m);
}

/** Body of a plaintext-only message: everything after the RFC822 header block. */
export function rawBody(raw: string): string {
	const i = raw.search(/\r?\n\r?\n/);
	return i === -1 ? raw : raw.slice(i).trim();
}

/**
 * Words that introduce a one-time code, across the languages our test mail arrives in:
 * en, da/no, sv, fi, de, fr, es, pt, it, nl. Matched case-insensitively.
 */
export const OTP_CUE_WORDS = [
	"otp",
	"pin",
	"passcode",
	"token",
	"code", // en, fr, nl, de
	"kode", // da, no
	"kod", // sv
	"koodi", // fi
	"codice", // it
	"c[oó]digo", // es, pt
	"clave", // es
	"contrase\\w*", // es
	"verif\\w*", // en, fr, es
	"verificaci[oó]n",
	"adgangs\\w*", // da
	"engangs\\w*", // da, no
	"eng\u00e5ngs\\w*", // sv
	"einmal\\w*", // de
	"best[a\u00e4]tigungs\\w*", // de
	"bekr[a\u00e6\u00e4]ft\\w*", // da, sv
];

/**
 * Prefer a code that follows a cue word (see OTP_CUE_WORDS); else the first standalone
 * digit run. With `digits` undefined any 4-8 digit run qualifies (Tivoli's mail uses 8,
 * many services 6).
 */
export function extractOtp(text: string, digits?: number): string | null {
	const quant = digits ? `{${digits}}` : "{4,8}";
	const cue = new RegExp(`(?:${OTP_CUE_WORDS.join("|")})\\W{0,40}?(?<!\\d)(\\d${quant})(?!\\d)`, "is");
	const m = cue.exec(text);
	if (m) return m[1];
	const all = new RegExp(`(?<!\\d)(\\d${quant})(?!\\d)`, "g");
	for (const hit of text.matchAll(all)) {
		const c = hit[1];
		if (c.length === 4 && +c >= 1900 && +c <= 2100) continue; // copyright years
		return c;
	}
	return null;
}

export function parseAfter(value: string | undefined, defaultSeconds = 120): Date {
	const now = Date.now();
	if (value === undefined || value === "") return new Date(now - defaultSeconds * 1000);
	if (value === "now") return new Date(now);
	if (/^\d+$/.test(value)) return new Date(now - Number(value) * 1000);
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) throw new MaildropError(`cannot parse --after value: ${value}`, "usage");
	return d;
}

export function matches(m: MessageSummary, subjectRe?: string, fromRe?: string): boolean {
	if (subjectRe && !new RegExp(subjectRe, "i").test(m.subject ?? "")) return false;
	if (fromRe && !new RegExp(fromRe, "i").test(`${m.headerfrom ?? ""} ${m.mailfrom ?? ""}`)) return false;
	return true;
}

export function formatSummaryLine(m: MessageSummary): string {
	const from = (m.headerfrom || m.mailfrom || "").slice(0, 40);
	return `${m.id} | ${m.date.slice(0, 19)}Z | ${from} | ${(m.subject ?? "").trim().slice(0, 80)}`;
}

// ---------------------------------------------------------------- API operations

export class Maildrop {
	constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly opts: ClientOptions = {}) {}

	private q<T>(query: string, variables?: Record<string, unknown>) {
		return gql<T>(query, variables, this.fetchImpl, this.opts);
	}

	async status(): Promise<{ status: string; statistics: { blocked: number; saved: number } }> {
		return this.q("{ status statistics { blocked saved } }");
	}

	async alias(mailbox: string): Promise<string> {
		const d = await this.q<{ altinbox: string }>("query($m:String!){ altinbox(mailbox:$m) }", { m: normalizeMailbox(mailbox) });
		return `${d.altinbox}@maildrop.cc`;
	}

	async inbox(mailbox: string): Promise<MessageSummary[]> {
		const d = await this.q<{ inbox: MessageSummary[] | null }>(`query($m:String!){ inbox(mailbox:$m){ ${LIST_FIELDS} } }`, { m: normalizeMailbox(mailbox) });
		return d.inbox ?? [];
	}

	async message(mailbox: string, id: string, fields: string): Promise<Message | null> {
		const d = await this.q<{ message: Message | null }>(`query($m:String!,$i:String!){ message(mailbox:$m,id:$i){ ${fields} } }`, { m: normalizeMailbox(mailbox), i: id });
		return d.message;
	}

	async delete(mailbox: string, id: string): Promise<boolean> {
		const d = await this.q<{ delete: boolean }>("mutation($m:String!,$i:String!){ delete(mailbox:$m,id:$i) }", { m: normalizeMailbox(mailbox), i: id });
		return Boolean(d.delete);
	}

	/** Poll until a message dated after `after` matches; returns the newest such message. */
	async waitFor(opts: { mailbox: string; subject?: string; from?: string; after: Date; timeoutS: number; intervalS?: number; signal?: AbortSignal }): Promise<MessageSummary> {
		const interval = Math.max(opts.intervalS ?? MIN_POLL_INTERVAL_S, MIN_POLL_INTERVAL_S) * 1000;
		const deadline = Date.now() + opts.timeoutS * 1000;
		for (;;) {
			const hits = (await this.inbox(opts.mailbox)).filter((m) => new Date(m.date) > opts.after && matches(m, opts.subject, opts.from));
			if (hits.length) return hits.reduce((a, b) => (new Date(a.date) > new Date(b.date) ? a : b));
			if (Date.now() + interval > deadline) {
				const filt = [opts.subject && `subject /${opts.subject}/`, opts.from && `from /${opts.from}/`].filter(Boolean).join(", ");
				throw new MaildropError(`no message within ${opts.timeoutS}s in ${normalizeMailbox(opts.mailbox)}@maildrop.cc dated after ${opts.after.toISOString()}${filt ? " matching " + filt : ""}`, "timeout");
			}
			await sleep(interval, opts.signal);
		}
	}
}
