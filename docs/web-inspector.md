# Web inspector

Browse stored memories, decisions, pitfalls, sessions, projects, sync drift, and analytics in a local web UI.

## Run

```bash
memento-mcp ui                    # http://127.0.0.1:37778, read-only
memento-mcp ui --enable-edit      # also expose pin/unpin and soft-delete
memento-mcp ui --port 8080 --open # custom port; auto-open browser
```

## Flags

| Flag | Default | Description |
|---|---|---|
| `--port` | `37778` | bind port |
| `--host` | `127.0.0.1` | bind interface |
| `--enable-edit` | off | expose `POST /api/memories/:id/pin` and `DELETE /api/memories/:id` |
| `--open` | off | open the URL in the default browser (`xdg-open` / `open` / `start`) |

## Tabs

- **Memories** — searchable list with pinned/type filters; side panel shows full body, neighbors (chronological), linked decisions and pitfalls
- **Decisions** — paginated decision log with category filter
- **Pitfalls** — paginated pitfalls with occurrence count
- **Sessions** — recent sessions with budget bars; link to the session's summary memory if one exists
- **Projects** — list of registered projects with `has_policy` badge (see [policy](policy.md))
- **Analytics** — last-N-days counters: memories, injections, captures, compressions
- **Sync** — per-project drift between SQLite and `.memento/memories/*.json` (see [team sync](team-sync.md))

## Security

- Binds to `127.0.0.1` by default. Binding to any other host prints a stderr warning because memory contents would be reachable on your network. There is **no authentication** — keep the UI on localhost.
- Edit endpoints additionally require:
  - `Content-Type: application/json`
  - `X-Memento-UI: 1` header (set by the bundled JS — drive-by browser POSTs are rejected)
- Bodies marked with `<private>...</private>` are redacted to `[REDACTED]` in API responses unless you pass `?show_private=1` on a server started with `--enable-edit`.

## API endpoints

The frontend calls a JSON API (also useful for scripting):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | `{ ok, version, enableEdit }` |
| GET | `/api/projects` | projects with memory counts and policy flag |
| GET | `/api/memories` | paginated, filterable, FTS-searchable |
| GET | `/api/memories/:id` | full memory + neighbors + linked decisions/pitfalls |
| GET | `/api/decisions` | decisions with category filter |
| GET | `/api/pitfalls` | pitfalls list |
| GET | `/api/sessions` | recent sessions with budget |
| GET | `/api/analytics/summary?days=N` | counters per event type |
| GET | `/api/analytics/events` | raw events with secret-scrubbed `event_data` |
| GET | `/api/sync/status` | per-project sync drift |
| POST | `/api/memories/:id/pin` | toggle pin (edit-only) |
| DELETE | `/api/memories/:id` | soft-delete (edit-only) |

Pagination contract: `{ items: [...], total, offset, limit }`. Limit cap = 200.
