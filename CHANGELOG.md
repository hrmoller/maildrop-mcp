# Changelog

## 0.1.0 — 2026-09-03

Initial release.

- Tools: `list_inbox`, `get_message` (text/html/raw), `wait_for_message`, `get_otp`,
  `delete_message`, `get_alias`, `service_status`.
- 429 backoff, 10-second poll floor, `@maildrop.cc` suffix normalisation, cue-word-aware
  one-time-code extraction (4–8 digits, Danish and English cue words).
