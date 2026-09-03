import { test } from "node:test";
import assert from "node:assert/strict";
import { Maildrop, MaildropError, extractOtp, htmlToText, matches, normalizeMailbox, parseAfter, rawBody } from "./maildrop.js";

test("normalizeMailbox strips the maildrop.cc suffix and rejects other domains", () => {
	assert.equal(normalizeMailbox("usual_88081"), "usual_88081");
	assert.equal(normalizeMailbox(" usual_88081@maildrop.cc "), "usual_88081");
	assert.equal(normalizeMailbox("Usual_88081@MAILDROP.CC"), "Usual_88081");
	assert.throws(() => normalizeMailbox("x@gmail.com"), MaildropError);
	assert.throws(() => normalizeMailbox(""), MaildropError);
});

test("htmlToText drops style/script/comments, keeps text, decodes entities", () => {
	const html = `<html><head><title>t</title><style>.a{color:red}</style></head><body>
	<!-- hidden --><div>Din kode:</div><p><b>12345678</b></p><script>x()</script>
	<p>Koden er kun aktiv i 15&nbsp;minutter &amp; s&aring; udl&oslash;ber den.</p><p>&copy; 2026</p></body></html>`;
	const t = htmlToText(html);
	assert.match(t, /^Din kode:\n12345678\n/);
	assert.ok(t.includes("Koden er kun aktiv i 15 minutter & så udløber den."));
	assert.ok(!t.includes("color:red") && !t.includes("x()") && !t.includes("hidden"));
});

test("extractOtp prefers the code after a cue word and skips years", () => {
	assert.equal(extractOtp("Din kode: 12345678\n© 2026 Tivoli"), "12345678");
	assert.equal(extractOtp("Your verification code is 482913. Expires 2026-01-01"), "482913");
	assert.equal(extractOtp("Copyright 2026. Ref 1234."), "1234");
	assert.equal(extractOtp("Din kode: 12345678", 6), null);
	assert.equal(extractOtp("Order #99887766 confirmed", 6), null);
	assert.equal(extractOtp("Order #99887766 confirmed"), "99887766");
	assert.equal(extractOtp("no digits here"), null);
});

test("parseAfter handles ISO, now, seconds, default", () => {
	const t0 = Date.now();
	assert.equal(parseAfter("2026-09-03T06:00:00Z").toISOString(), "2026-09-03T06:00:00.000Z");
	assert.ok(Math.abs(parseAfter("now").getTime() - t0) < 1000);
	assert.ok(Math.abs(parseAfter("30").getTime() - (t0 - 30_000)) < 1000);
	assert.ok(Math.abs(parseAfter(undefined).getTime() - (t0 - 120_000)) < 1000);
	assert.throws(() => parseAfter("yesterday"), MaildropError);
});

test("matches filters on subject and either from field, case-insensitively", () => {
	const m = { id: "a", date: "2026-09-03T06:09:52Z", headerfrom: '"Tivoli" <tivoli@mail.tivoli.dk>', mailfrom: "bounces@mail.tivoli.dk", subject: "Din engangskode" };
	assert.ok(matches(m, "ENGANGS", "tivoli"));
	assert.ok(matches(m, undefined, "bounces@"));
	assert.ok(!matches(m, "welcome"));
	assert.ok(!matches(m, undefined, "braze"));
});

test("rawBody returns the part after the header block", () => {
	assert.equal(rawBody("From: a\r\nSubject: b\r\n\r\nhello\r\n"), "hello");
	assert.equal(rawBody("no headers"), "no headers");
});

test("Maildrop client sends variables, strips the suffix, and surfaces GraphQL errors", async () => {
	const calls: any[] = [];
	const fake: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init!.body));
		calls.push(body);
		if (body.variables.m === "boom") return Response.json({ errors: [{ message: 'Cannot query field "x"' }] });
		return Response.json({ data: { inbox: [{ id: "1", date: "2026-09-03T00:00:00Z", headerfrom: "a", mailfrom: "b", subject: "s" }] } });
	};
	const api = new Maildrop(fake);
	const inbox = await api.inbox("Foo@maildrop.cc");
	assert.equal(inbox.length, 1);
	assert.equal(calls[0].variables.m, "Foo");
	assert.match(calls[0].query, /inbox\(mailbox:\$m\)/);
	await assert.rejects(api.inbox("boom"), (e: any) => e instanceof MaildropError && e.kind === "api" && /Cannot query field/.test(e.message));
});

test("Maildrop client retries a 429 once the server relents", async () => {
	let n = 0;
	const fake: typeof fetch = async () => (++n === 1 ? new Response("slow down", { status: 429 }) : Response.json({ data: { status: "operational", statistics: { blocked: 1, saved: 2 } } }));
	const api = new Maildrop(fake, { backoffMs: 10 });
	assert.equal((await api.status()).status, "operational");
	assert.equal(n, 2);
});
