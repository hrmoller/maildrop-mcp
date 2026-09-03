# maildrop-mcp

An [MCP](https://modelcontextprotocol.io) server for [maildrop.cc](https://maildrop.cc)
disposable inboxes. It lets an AI agent list a test mailbox, wait for a mail to arrive, pull
the one-time code out of it, read a message as plain text, delete it, or fetch the mailbox
alias, all through maildrop's public GraphQL API and without a browser.

Built for QA flows where test accounts use `something@maildrop.cc` addresses and the agent
needs the verification mail: login OTPs, sign-up confirmations, CRM/marketing-automation test
sends.

## Why an MCP server

- **Cheap reads.** `list_inbox` returns one line per message and never fetches bodies.
  `get_message` strips tags, so a typical notification mail is a few hundred characters
  instead of the 15–25 KB HTML or raw source. No browser navigation or screenshots.
- **Waiting built in.** `wait_for_message` and `get_otp` poll server-side at the interval
  maildrop asks for (10 s) and return once a matching mail lands.
- **Permission-friendly.** Tool calls are governed by MCP allow rules in the client, so an
  agent can be allowed to read a test inbox without a shell-command classifier deciding that
  "extract digits from an email" looks suspicious.

## Install

Requires Node 20 or newer. No API key: maildrop's API is public and unauthenticated.

The package is published to npm as
[`@hrmoller/maildrop-mcp`](https://www.npmjs.com/package/@hrmoller/maildrop-mcp), so clients
can run it with `npx` and nothing needs to be cloned.

### Claude Code

```sh
claude mcp add --scope user maildrop -- npx -y @hrmoller/maildrop-mcp
```

Then allow the tools so they run without prompting, either through `/permissions` or in
`~/.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__maildrop__*"] } }
```

Start a new session; the tools appear as `mcp__maildrop__list_inbox` and so on.

### Claude Desktop, Cursor, other clients

Add a stdio server entry to the client's MCP config:

```json
{
  "mcpServers": {
    "maildrop": {
      "command": "npx",
      "args": ["-y", "@hrmoller/maildrop-mcp"]
    }
  }
}
```

### From source

```sh
git clone https://github.com/hrmoller/maildrop-mcp.git
cd maildrop-mcp
npm install && npm run build
claude mcp add --scope user maildrop -- node "$PWD/dist/index.js"
```

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `list_inbox` | `mailbox` | One line per message: `id \| date \| from \| subject`. Max 10 (maildrop's cap). |
| `get_message` | `mailbox`, `id`, `format` = `text` (default) / `html` / `raw` | `text`: headers + tag-stripped body. `html`: HTML body. `raw`: full RFC822 source. |
| `wait_for_message` | `mailbox`, `subject?`, `from?`, `after?`, `timeoutSeconds` (default 120, max 240) | The newest matching message as text once it arrives; error on timeout. |
| `get_otp` | same as `wait_for_message` plus `digits?` | Only the one-time code (4–8 digits by default, or exactly `digits`). |
| `delete_message` | `mailbox`, `id` | Confirmation. |
| `get_alias` | `mailbox` | The `D-…@maildrop.cc` alias that forwards to this mailbox. |
| `service_status` | none | Whether maildrop is operational, plus global counters. |

`mailbox` accepts `name` or `name@maildrop.cc`; the suffix is stripped because the API
returns an empty inbox when it is present. Names are case-insensitive.

`subject` and `from` are case-insensitive regular expressions. `from` is matched against both
the `From:` header and the envelope sender.

`after` narrows the search to messages dated after a point in time: an ISO-8601 timestamp,
the word `now`, or a number of seconds ago. Default is 120 seconds ago. Capture a timestamp
before triggering the mail and pass it, so two codes requested in quick succession are not
confused.

### One-time-code extraction

`get_otp` converts the HTML body to text and looks for a digit run of the requested length
(4–8 when unspecified). A run that follows a cue word (`code`, `kode`, `PIN`, `verif…`,
`adgangs…`, `otp`) wins; otherwise the first standalone run is used, skipping four-digit
values that look like years. If nothing qualifies the tool errors with the message id so
the agent can fall back to `get_message`.

### Errors

Tool errors are returned as MCP `isError` results with a prefix naming the kind:
`not_found`, `timeout`, `no_code`, `api`, `network`, `usage`.

## API facts

Verified against the live API and [docs.maildrop.cc](https://docs.maildrop.cc) on 2026-09-03.

| Fact | Value |
|---|---|
| Endpoint | `POST https://api.maildrop.cc/graphql` with `content-type: application/json` (400 without it; GET is rejected) |
| Auth | None. The docs mention bearer tokens as a possible future measure. |
| Rate limit | 50 requests per 10 seconds, burst 25; 429 until you back off; persistent offenders are blocked. Poll a mailbox no more than every 10 s. |
| Mailbox | Holds at most 10 messages, oldest evicted. Deleted after 24 hours of inactivity. |
| Mailbox name | Local part only, case-insensitive. Any name works without registration. |
| Sending | maildrop cannot send mail (SPF `-all`). |
| Greylisting | A first mail from an unknown sending server is deferred; it can take about 15 minutes to arrive. |
| `Message` fields | `id ip helo date mailfrom rcptto headerfrom subject data html`; `data` is the raw RFC822 source, `html` the decoded HTML body. |

## Security notes

- **Maildrop inboxes are public.** Anyone who guesses a mailbox name can read it. Use it only
  for test accounts whose mail may be public, never for anything real. Use unguessable names
  (`purpose_<random digits>`), and hand out the alias from `get_alias` when a third party
  logs recipient addresses.
- **Codes are secrets, briefly.** `get_otp` returns a code so the agent can use it. Do not
  record codes in tickets, docs, or logs.
- **The server only talks to `api.maildrop.cc`.** It has no other network access, no
  filesystem access, and no configuration.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # build + node:test unit tests
npm run smoke       # build, then drive dist/index.js over stdio: initialize, tools/list, two tool calls
npm run smoke -- some_mailbox
```

Layout: `src/maildrop.ts` holds the API client and pure helpers (HTML-to-text, code
extraction, filters); `src/index.ts` registers the tools. Tests live next to the code and run
against the compiled `dist/`.

## License

MIT.
