# Privacy

memento-mcp has two layers of privacy protection.

## 1. `<private>...</private>` tag redaction

Wrap any sensitive region in tags:

```
The DB password is <private>p@ssw0rd-from-vault</private> — rotated 2026-04-01.
```

- Content inside tags is **excluded from the FTS5 index** (a SQLite UDF strips it during indexing). A search for `p@ssw0rd-from-vault` returns 0 hits.
- Read paths (`memory_search`, `memory_get`, hook injections, web inspector, sync JSON files) replace tagged regions with `[REDACTED]`.
- `memory_get(id, reveal_private=true)` returns the full body with a banner and emits a `private_revealed` analytics event for audit.
- Storing with unbalanced tags errors out: `Memory not stored: unbalanced <private> tags`.

## 2. `scrubSecrets` — automatic pattern-based scrubbing

Applied to **titles and bodies at the repo write layer**, so any caller (manual store, auto-capture, import, summarize) is covered. Patterns currently caught:

1. `api_key=`, `password=`, `secret=`, `token=` literal forms
2. Vendor env-var prefixes: `AWS_*`, `AZURE_*`, `GCP_*`, `GITHUB_*`, `STRIPE_*`, `OPENAI_*`, `ANTHROPIC_*`
3. PEM private key blocks (RSA, EC, OpenSSH, PGP)
4. Database/cache/mail prefixes: `DB_*`, `DATABASE_*`, `POSTGRES_*`, `MYSQL_*`, `MONGO_*`, `REDIS_*`, `SMTP_*`, `MAIL_*`, `RABBITMQ_*`, `KAFKA_*`
5. `*_URL=<scheme>://...` env-var assignments
6. URLs with embedded credentials (`https://user:pass@host` → `https://[REDACTED]@host`, host preserved for context)
7. `Authorization: <scheme> <token>` and standalone `Bearer <token>` (16+ chars)
8. GitHub PATs (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_` + 36+ chars)
9. JWTs (three base64url segments with `eyJ...` header)

The integration test `tests/integration/secret-scrub-coverage.test.ts` is the source of truth. Adding a new write path without covering it there causes the test matrix to fail.

A `logger.warn` is emitted if a secret pattern is found in a title (titles should not normally contain secrets).

## Defence-in-depth across paths

- **Embeddings (#1)** — `scrubSecrets` + `redactPrivate` are applied to the candidate text BEFORE it leaves for the embedding API.
- **LLM session summary (#10)** — applied to every capture's body AND to the final assembled-and-truncated prompt (so a truncation boundary that splits a `<private>` tag still redacts correctly).
- **Git sync (#11)** — applied to title, body, and tags before serializing to `.memento/memories/<id>.json`.

## Limits

`scrubSecrets` is a safety net, not a guarantee. For sensitive values you control, prefer `<private>` tags. The patterns above catch common shapes; novel secret formats may slip through.
