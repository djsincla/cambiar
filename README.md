# Cambiar

Lightweight change-management for small workshops. API-first Node.js + React, local or Active Directory authentication, JSON-defined change types, approval workflow, and email/SMS notifications. Ships as a single container.

> Cambiar — Spanish for *to change*.

## Features

- Local user accounts (bcrypt) and Active Directory / LDAP authentication
- JSON-defined change types with custom fields (no code changes to add a type)
- Submitter → approver → implementer workflow with full audit trail
- Email notifications via SMTP (nodemailer) and pluggable SMS adapter (Twilio-ready)
- Single-container deploy: Node + SQLite + built React SPA
- Apache-2.0 licensed

## Quick start (Docker)

```bash
git clone <this-repo> cambiar && cd cambiar
cp .env.example .env
# edit .env — at minimum set JWT_SECRET (e.g. JWT_SECRET=$(openssl rand -hex 64))

docker compose up -d --build
# open http://localhost:3000 — first login is admin / admin (forced password change)
```

The container persists its SQLite database in `./data/` and reads JSON config from `./config/` (mounted read-only). Edit any `config/*.json` and `docker compose restart cambiar` to apply.

## Quick start (local development)

```bash
npm install
cp server/.env.example server/.env       # set JWT_SECRET
npm run migrate                          # creates ./data/cambiar.sqlite + admin/admin
npm run dev                              # API on :3000, web on :5173 with hot reload
```

For production-style local run:
```bash
npm run build
npm start                                # serves API + built web on :3000
```

## Configuration

Runtime config lives in `config/`:

| File | Purpose |
| ---- | ------- |
| `config/change-types.json` | Defines change types and their custom fields |
| `config/auth.json` | Toggles local/AD auth, AD server settings |
| `config/notifications.json` | SMTP, SMS, and per-event channel settings |

Secrets (passwords, JWT key) live in `.env` (Docker) or `server/.env` (local) — never in JSON.

### Active Directory

Set `auth.ad.enabled = true` in `config/auth.json` and fill in `url`, `bindDN`, `searchBase`, `searchFilter`. The bind password comes from `AD_BIND_PASSWORD`. Optional `groupRoleMap` maps AD group DN substrings to Cambiar roles (`admin`, `approver`, `submitter`); default is `submitter`.

If a username matches both a local account and an AD account, local takes precedence — useful for the bootstrap admin.

### Email (SMTP)

Set `notifications.email.enabled = true` and fill in `smtp.host/port/user`, `from`. Set `SMTP_PASSWORD` in env. The `events` array controls which workflow events trigger email.

### SMS (optional)

Set `notifications.sms.enabled = true` and `adapter` (`twilio` or `log` for testing). Twilio config takes `accountSid`, `fromNumber`; auth token comes from `SMS_AUTH_TOKEN`. Per-user phone numbers are stored on user records.

### Change types

Each entry in `config/change-types.json` declares custom fields rendered in the form and stored on the record. Field types: `string`, `text`, `number`, `select` (with `options`), `boolean`. The seeded templates are:

| Key | For |
| --- | --- |
| `server_reboot` | Physical/virtual server reboots |
| `firewall_rule` | Firewall add/modify/remove |
| `software_update` | Package and software updates |
| `storage_change` | Render-farm and asset storage |
| `network_change` | Switch / VLAN / routing / cabling |
| `generic` | Free-form change record |

## Architecture

```
cambiar/
├── server/   Express API + SQLite + auth + notifiers
├── web/      Vite + React SPA (served by Express in production)
├── config/   JSON config (change types, auth, notifications)
├── data/     SQLite db file (volume-mounted, gitignored)
├── Dockerfile
└── docker-compose.yml
```

## Roles

- `admin` — manage users, system config, can do anything
- `approver` — approve/reject submitted changes
- `submitter` — create/edit own draft changes, submit for approval, mark implemented, close

## Workflow states

```
draft → submitted → approved → implemented → closed
              ↘ rejected
                            ↘ rolled_back
```

A submitter cannot approve their own change.

## API

`GET /api` returns an endpoint index. Highlights:

- `POST /api/auth/login` — `{ username, password }` → sets session cookie
- `GET  /api/auth/me`
- `POST /api/auth/change-password`
- `GET  /api/change-types`
- `GET  /api/changes?status=&mine=true&type=`
- `POST /api/changes` — create draft
- `PATCH /api/changes/:id` — edit draft
- `POST /api/changes/:id/{submit,approve,reject,implement,close,rollback}`
- `GET  /api/users`, `POST /api/users`, `PATCH /api/users/:id` (admin)

## Development

```bash
npm run dev    # server (3000) + web (5173) with hot reload
npm test       # server tests (vitest)
```

The Vite dev server proxies `/api/*` to the server, so a single `localhost:5173` URL works for development.

## Testing — the API contract

Cambiar is **API-first**: the test suite is the contract. Any change to an API endpoint *must* come with a test change, and the test suite must stay green before merging.

```bash
npm test                  # full suite (vitest)
npm test -- --watch       # iterate
npm test -- changes       # only changes.test.js
```

Tests run against an **in-memory SQLite** with a **per-suite reset** (`resetDb()` in `server/test/helpers.js`), so they are hermetic and fast — the full suite runs in ~12s.

What's covered:

| File | What it locks down |
| --- | --- |
| `test/meta.test.js` | `/api/health`, `/api` endpoint index |
| `test/auth.test.js` | login (good, bad, missing fields, disabled), `me`, logout, password change (success, wrong-current, weakness rules), must-change-password gate |
| `test/users.test.js` | admin RBAC on user CRUD, last-admin protection, weak-password rejection, AD-user reset blocked, strict-mode patch |
| `test/changeTypes.test.js` | type catalog shape, structural invariants, 404 on unknown |
| `test/changes.test.js` | full state machine (`draft → submitted → approved → implemented → closed` and the `rejected` / `rolled_back` branches), submitter-cannot-approve-own, role gates, field validation at submit time, audit log captures every transition |
| `test/notifications.test.js` | recipients per event (approvers + admins on submit; submitter on approve/reject); per-channel event filtering |

When adding or modifying an endpoint, the workflow is:

1. Update / add the test in `server/test/*.test.js` first (or alongside).
2. Update the route handler.
3. `npm test` → green.
4. Update the README endpoint list and `GET /api` index if the surface changed.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
