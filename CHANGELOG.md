# Changelog

## 0.2.0 — 2026-09-03

- Server instructions: generic usage guidance (read cheaply, wait correctly, greylisting,
  mailbox limits, privacy) now travels with the server and loads in any MCP client.
- One-time-code cue words extended beyond English and Danish to Swedish, Norwegian, Finnish,
  German, French, Spanish, Portuguese, Italian and Dutch.
- Published automatically from CI on merge to `main` via npm trusted publishing (OIDC).

## 0.1.0 — 2026-09-03

Initial release.

- Tools: `list_inbox`, `get_message` (text/html/raw), `wait_for_message`, `get_otp`,
  `delete_message`, `get_alias`, `service_status`.
- 429 backoff, 10-second poll floor, `@maildrop.cc` suffix normalisation, cue-word-aware
  one-time-code extraction (4–8 digits, Danish and English cue words).
