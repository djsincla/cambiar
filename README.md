# Cambiar

API-first change management for small workshops. Node.js + React, local or Active Directory authentication, admin-managed change types and approver groups, email/SMS notifications, configurable branding, single-container deploy.

> Cambiar — Spanish for *to change*.

## Contents

- [Features](#features)
- [Quick start (Docker)](#quick-start-docker)
- [Quick start (local development)](#quick-start-local-development)
- [Default credentials](#default-credentials)
- [Resetting the admin password](#resetting-the-admin-password)
- [Repo layout](#repo-layout)
- [Configuration](#configuration)
- [Active Directory](#active-directory)
- [Email and SMS](#email-and-sms)
- [Branding (logo + app name)](#branding-logo--app-name)
- [Roles, groups, and the approval policy](#roles-groups-and-the-approval-policy)
- [Workflow states](#workflow-states)
- [Admin guide](#admin-guide)
- [API reference](#api-reference)
- [Development](#development)
- [Testing — the API contract](#testing--the-api-contract)
- [End-to-end tests (Playwright)](#end-to-end-tests-playwright)
- [Continuous integration](#continuous-integration)
- [License](#license)

## Features

- **Local + AD/LDAP auth** — bcrypt-hashed local accounts, plus Active Directory bind/search with group→role mapping. Local takes precedence on username collisions, so the bootstrap admin always works.
- **Admin-managed change types** — seeded from `config/change-types.json` on first run, then editable through the admin UI: rename, edit fields (string/text/number/select/boolean), add/remove, soft-delete when in use.
- **Approver groups** — many-to-many user/group membership; any-one-group approval (membership in any group assigned to a change type lets you approve). Admin override always works. Submitter can never approve their own change.
- **Workflow with audit** — draft → submitted → approved → implemented → closed, with rejected and rolled_back branches. Every transition is captured in an audit log.
- **Notifications** — email via SMTP (nodemailer); SMS via Twilio (lightweight REST adapter, no SDK). Per-event channel filtering in `config/notifications.json`.
- **Configurable branding** — admin-uploadable logo (PNG / SVG / JPEG / WebP, max 1 MB) and app name. The logo renders top-left for everyone, including the login screen.
- **API-first** — every endpoint has tests, the README endpoint list and `GET /api` are kept in sync. 131 vitest tests + 10 Playwright E2E tests in CI.
- **Single-container deploy** — multi-stage Dockerfile (build web, install server, slim runtime as non-root). `docker compose up -d --build` and you're running.
- **Apache-2.0 licensed.**

## Quick start (Docker)

```bash
git clone https://github.com/djsincla/cambiar && cd cambiar
cp .env.example .env
# Required: set JWT_SECRET to something long and random.
#   JWT_SECRET=$(openssl rand -hex 64)

docker compose up -d --build
# open http://localhost:3000  →  log in admin / admin (forced password change on first login)
```

The container persists its SQLite database in `./data/` and reads JSON config from `./config/` (mounted read-only). After editing `config/auth.json` or `config/notifications.json`, run `docker compose restart cambiar` to apply. (`config/change-types.json` is only used on the *first* migration to seed the catalog — once seeded, change types are managed in the admin UI.)

## Quick start (local development)

```bash
npm install
cp server/.env.example server/.env       # set JWT_SECRET
npm run migrate                          # creates data/cambiar.sqlite, bootstraps admin/admin, seeds change types
npm run dev                              # API on :3000, web on :5173 with hot reload
```

For a production-style local run:
```bash
npm run build
npm start                                # serves API + built web on :3000
```

The Vite dev server proxies `/api/*` to the server, so a single `http://localhost:5173` URL works for development.

## Default credentials

First login: **`admin` / `admin`**. The bootstrap admin is forced to change their password on first login (`must_change_password=1`). After that, manage all users through the admin UI.

## Resetting the admin password

If the admin password is lost or all admins get locked out, run the reset-admin CLI from the host. By design there is **no API equivalent** — recovery requires direct access to `data/cambiar.sqlite`, the same trust boundary as the database file itself.

```bash
# Local install
npm run reset-admin                                # generates a strong random password and prints it
npm run reset-admin -- --password 'MyNewPwd1234'   # set a specific password
npm run reset-admin -- --username admin2           # reset (or create) admin2

# Docker (running container)
docker compose exec cambiar npm run reset-admin
docker compose exec cambiar npm run reset-admin -- --password 'MyNewPwd1234'

# Docker (one-shot, container not running)
docker compose run --rm cambiar npm run reset-admin
```

What it does:

- **User exists** → updates the password, sets `must_change_password=1`, sets `active=1`. Role is **not** changed.
- **User doesn't exist** → creates them with `role=admin`, `must_change_password=1`, `active=1`.
- **AD-sourced user** → refused (use AD password reset instead).
- The user must change the password on first login.

The script applies any pending migrations before doing the reset, so it's safe on a fresh install too.

## Repo layout

```
cambiar/
├── server/                  Express API + SQLite + auth + notifiers + tests
│   ├── src/
│   │   ├── app.js           Express app factory (used by index.js and tests)
│   │   ├── index.js         Production entry — runs migrations, bootstraps admin, listens
│   │   ├── auth/            jwt, password hashing, AD/LDAP client
│   │   ├── db/              schema migrations (.sql), runner, sqlite singleton
│   │   ├── middleware/      requireAuth, requireRole, blockIfPasswordChangeRequired
│   │   ├── notifications/   pluggable channels (email, sms)
│   │   ├── routes/          auth, users, groups, changeTypes, changes, settings
│   │   └── services/        changeTypes, groups, audit, settings
│   └── test/                vitest tests (one file per route surface)
├── web/                     Vite + React SPA (served by Express in production)
│   └── src/
│       ├── App.jsx          Router with <Protected> guard
│       ├── auth.jsx         AuthProvider (login/logout/refresh)
│       ├── branding.jsx     BrandingProvider (logo/appName fetched at boot)
│       ├── api.js           fetch wrapper
│       └── pages/           Login, ChangeList/Detail/New, ChangePassword,
│                            Users, Groups, ChangeTypesAdmin, Settings
├── config/                  auth.json, notifications.json, change-types.json (seed)
├── data/                    SQLite db + uploads/  (volume-mounted, gitignored)
├── e2e/                     Playwright specs
├── .github/workflows/ci.yml CI pipeline
├── Dockerfile               multi-stage (web-build → server-install → runtime)
└── docker-compose.yml
```

## Configuration

| Where | What | Lifetime |
| --- | --- | --- |
| `.env` (Docker) / `server/.env` (local) | Secrets: `JWT_SECRET`, `AD_BIND_PASSWORD`, `SMTP_PASSWORD`, `SMS_AUTH_TOKEN` | Read on every server start |
| `config/auth.json` | Toggle local/AD; AD server settings; AD group→role mapping | Read on every server start |
| `config/notifications.json` | Toggle email/SMS; SMTP host/port/from; SMS adapter; per-event channel filters | Read on every server start |
| `config/change-types.json` | **Seed only** — imported into the `change_types` DB table on the *first* migration. Edits to this file after that have no effect. | First-run seed |
| `data/cambiar.sqlite` | Users, groups, change records, approvals, audit log, settings, change types | Authoritative |
| `data/uploads/` | Admin-uploaded files (e.g. logo) | Authoritative |

Secrets always come from env vars, never from JSON.

## Active Directory

Set `auth.ad.enabled = true` in `config/auth.json` and fill in:

```json
{
  "ad": {
    "enabled": true,
    "url": "ldaps://ad.example.com:636",
    "bindDN": "cn=cambiar-svc,ou=ServiceAccounts,dc=example,dc=com",
    "searchBase": "ou=Users,dc=example,dc=com",
    "searchFilter": "(sAMAccountName={username})",
    "tlsRejectUnauthorized": true,
    "attributes": {
      "username": "sAMAccountName",
      "email": "mail",
      "displayName": "displayName"
    },
    "defaultRole": "submitter",
    "groupRoleMap": {
      "Cambiar-Admins": "admin",
      "Cambiar-Approvers": "approver"
    }
  }
}
```

The bind password is `AD_BIND_PASSWORD` in env. `groupRoleMap` keys are matched as case-insensitive substrings against the user's `memberOf` DNs — the *first* match wins. If none match, `defaultRole` is assigned. Admin role is preserved across re-logins (won't be downgraded by group mapping).

If a username matches both a local account and an AD account, **local takes precedence** — useful for the bootstrap admin and for emergency access if AD is unreachable.

## Email and SMS

In `config/notifications.json`:

```json
{
  "email": {
    "enabled": true,
    "from": "Cambiar <cambiar@example.com>",
    "smtp": { "host": "smtp.example.com", "port": 587, "secure": false, "user": "cambiar@example.com" },
    "events": ["submitted", "approved", "rejected", "implemented"]
  },
  "sms": {
    "enabled": false,
    "adapter": "twilio",
    "twilio": { "accountSid": "ACxxx", "fromNumber": "+15555555555" },
    "events": ["approved", "rejected"]
  }
}
```

`SMTP_PASSWORD` and `SMS_AUTH_TOKEN` come from env. Per-user phone numbers are stored on the user record (admin can set them via Users → Edit). The `events` array picks which workflow transitions trigger that channel.

Recipient rules:

| Event | Email/SMS goes to |
| --- | --- |
| `submitted` | Approvers (admins + members of any approver group on this change type) — never the submitter |
| `approved` / `rejected` / `implemented` / `closed` | The submitter |

## Branding (logo + app name)

Admin → **Settings** → upload PNG / SVG / JPEG / WebP (max 1 MB). The logo renders top-left for every user, including on the login screen (the branding endpoint is intentionally public). Files persist in `data/uploads/`. Replacing or removing the logo deletes the previous file.

The app name (default `cambiar`) shown in the topbar when no logo is set is also editable on this page.

## Roles, groups, and the approval policy

**Roles**
- `admin` — manage users, groups, change types, branding; can approve any change (override).
- `approver` — *legacy fallback* role; only matters for change types with no approver groups assigned. Once you start using groups, treat this role as deprecated.
- `submitter` — create/edit own drafts, submit for approval, mark implemented, close.

**Groups**
- Many-to-many: a user can belong to any number of groups. A group can have any number of users.
- Created and managed by admins on the **Groups** page.
- Assigned as approver groups per change type on the **Change Types** page.

**Approval policy: any-one-group**

For a change type with N approver groups assigned, *any one* member of *any one* group can approve. One approval moves the change to `approved`. One rejection moves it to `rejected` (single veto).

```
admin                    → can approve anything (override)
member of any one group  → can approve types where that group is assigned
approver role            → legacy; only counts when the change type has zero groups
submitter (own change)   → cannot approve their own change, ever
```

`GET /api/changes/:id` includes a `requiredApprovalGroups` field so the UI can show "any one member of: \<groupA\>, \<groupB\>".

**Standard changes (auto-approve)**

A change type can be marked **auto-approve** ("standard change" in ITIL terms). Submissions of that type skip the approval gate entirely — `draft → submitted → approved` happens in a single transaction with the system as the actor for the auto-approve step. Field validation still runs at submit.

Use auto-approve for routine, low-risk, well-understood work — planned reboots in a maintenance window, recurring patch jobs, scheduled backups. Anything that would otherwise create approver fatigue.

- Mutually exclusive with approver groups (the API rejects setting both — they're conceptually contradictory).
- Audit log shows two rows: the human `submit` and the `auto_approve` system action with `details: { reason: 'change type configured for auto-approval' }`.
- Notifications: no "submitted" email is sent (no one needs to act); the submitter still gets the "approved" email so they know it cleared.
- Flipping a type to auto-approve does **not** retroactively approve existing pending changes — only new submissions.

**Approver inbox**

The topbar shows an **Approvals** link with a count badge of changes currently waiting on the signed-in user. Clicking it opens a focused inbox view (`/changes?awaiting=true`) sorted oldest-first.

The inbox eligibility predicate is the same one used for the "submitted" notification recipients, so what shows up in your inbox is exactly what gets you emailed:

| You are… | Inbox shows |
| --- | --- |
| `admin` | All submitted changes (except your own) |
| in approver group(s) | Submitted changes whose type lists any of your groups, except your own |
| `approver` role + no groups | Submitted changes whose type has *no* approver groups assigned (legacy) |
| plain `submitter` | Empty |

The badge polls every 60 seconds and refreshes immediately on navigation between routes.

## Workflow states

```
draft ── submit ──▶ submitted ── approve ──▶ approved ── implement ──▶ implemented ── close ──▶ closed
                       │                                                    │
                       └── reject ──▶ rejected                              └── rollback ──▶ rolled_back
```

Every transition writes to `audit_log` with the user, from-status, to-status, and any decision comment. The audit log is exposed via `GET /api/changes/:id`.

## Admin guide

The topbar exposes admin-only links once you log in as `admin`:

- **Users** (`/admin/users`) — list / create local / edit role / set group memberships / reset password / activate-deactivate. Last admin cannot be demoted or disabled.
- **Groups** (`/admin/groups`) — list / create / edit name + description / pick members. Refuses delete if the group is assigned as an approver group on any change type (re-assign first).
- **Change Types** (`/admin/change-types`) — list (active + inactive) / create / edit (rename, change description, edit field schema, pick approver groups) / delete (soft-deletes if records reference the type, hard-deletes if not).
- **Settings** (`/admin/settings`) — branding (logo upload, app name).

## API reference

`GET /api` returns a live endpoint index. Highlights:

### Auth — `/api/auth`
- `POST /login` — `{ username, password }` → sets `cambiar_session` cookie + returns user
- `POST /logout`
- `GET  /me`
- `POST /change-password` — `{ currentPassword, newPassword }`

### Users (admin) — `/api/users`
- `GET /` — list (includes `groups[]`)
- `POST /` — create local user (accepts optional `groupIds`)
- `GET /:id` / `PATCH /:id` — read/update (strict mode: unknown fields rejected). Accepts optional `groupIds` for atomic membership replacement.
- `POST /:id/reset-password` — admin reset; user must change on next login. Refuses for AD users.

### Groups — `/api/groups`
- `GET /` — list with member counts (visible to any authed user, so the UI can render group names)
- `GET /:id` — group + members
- `POST /` (admin) — create with optional `memberIds`
- `PATCH /:id` (admin) — edit name/description/members
- `DELETE /:id` (admin) — refuses if assigned as approver group on any change type
- `POST /:id/members` (admin) / `DELETE /:id/members/:userId` (admin) — fine-grained member management

### Change types — `/api/change-types`
- `GET /` — list active types (admins can pass `?includeInactive=true`)
- `GET /:keyOrId` — by key or numeric id
- `POST /` (admin) — create with `key`, `name`, `description`, `icon`, `fields[]`, `approverGroupIds[]`, `autoApprove`. Validates field schema (no duplicate keys, select fields require options, lowercase keys). Rejects `autoApprove: true` together with non-empty `approverGroupIds` (mutual exclusion).
- `PATCH /:id` (admin) — partial update; can deactivate via `active: false`; can toggle `autoApprove` (clears groups in the same patch if needed).
- `DELETE /:id` (admin) — soft-deletes if records reference the type (`active=0`), hard-deletes otherwise

### Changes — `/api/changes`
- `GET /` — list with optional `?status=&mine=true&type=`
- `GET /?awaitingMyApproval=true` — **inbox**: only changes the current user can approve right now (admin override + group eligibility + legacy approver fallback). Sorted oldest-first.
- `POST /` — create draft; lenient field validation on draft, strict on submit
- `GET /:id` — change detail with `approvals[]`, `audit[]`, `requiredApprovalGroups[]`, `changeType` (incl. `autoApprove`)
- `PATCH /:id` — edit draft (only by submitter or admin, only if `status=draft`)
- `DELETE /:id` — delete draft (only by submitter or admin, only if `status=draft`)
- `POST /:id/submit` — strict field validation. **If the change type is auto-approve**, transitions straight to `approved` in a single transaction.
- `POST /:id/approve` / `POST /:id/reject` — `{ comment? }`. Requires admin or membership of an assigned approver group.
- `POST /:id/implement` / `POST /:id/close` — submitter or admin
- `POST /:id/rollback` — `{ comment? }`. From `implemented` or `closed`.

### Settings — `/api/settings`
- `GET /branding` — **public** (no auth) — `{ appName, logoUrl }`. Used by the login screen.
- `PUT /branding` (admin) — `{ appName? }`
- `POST /branding/logo` (admin, multipart `logo` field) — PNG/SVG/JPEG/WebP, max 1 MB
- `DELETE /branding/logo` (admin) — clears the logo

### Meta
- `GET /api/health` — `{ ok: true, version }`
- `GET /api` — endpoint index

Uploaded files are served at `/uploads/<filename>` (no auth — these are public branding assets).

## Development

```bash
npm run dev      # server (3000) + web (5173) with hot reload
npm test         # server tests (vitest, ~24s)
npm run test:e2e # Playwright E2E (~10s, uses port 3500)
npm run build    # build the SPA into web/dist/ for npm start
```

## Testing — the API contract

Cambiar is API-first: **the test suite is the contract**. Any change to an API endpoint must come with a test change, and `npm test` must stay green before merging.

```bash
npm test                  # full suite
npm test -- --watch       # iterate
npm test -- changes       # only changes.test.js
```

Tests run against an **in-memory SQLite** with a **per-test reset** (`resetDb()` in `server/test/helpers.js`), so they're hermetic and fast — the full 131-test suite runs in ~24s.

| File | What it locks down |
| --- | --- |
| `test/meta.test.js` | `/api/health`, `/api` endpoint index |
| `test/auth.test.js` | login (good/bad/missing/disabled), `me`, logout, password change (success / wrong-current / weakness rules), must-change-password gate |
| `test/users.test.js` | admin RBAC on user CRUD, last-admin protection, weak-password rejection, AD-user reset blocked, strict-mode patch |
| `test/userGroups.test.js` | `groups[]` in user payload, `groupIds` on create/patch, atomic replacement, unknown groupId rejection |
| `test/groups.test.js` | groups CRUD, member add/remove, member counts, name validation, deletion guard when assigned as approver |
| `test/changeTypes.test.js` | public type catalog shape, structural invariants, 404 on unknown |
| `test/changeTypesAdmin.test.js` | admin CRUD, duplicate-key, duplicate-field-key, select-without-options, unknown approverGroupId, soft- vs hard-delete |
| `test/changes.test.js` | full state machine (draft→submitted→approved→implemented→closed, plus rejected/rolled_back), submitter-cannot-approve-own, role gates, field validation at submit time, audit log captures every transition |
| `test/groupApproval.test.js` | any-one-group rule, multi-group OR semantics, admin override, submitter-still-blocked, reject also requires group membership, legacy fallback to approver role when no groups assigned |
| `test/branding.test.js` | public GET, admin-only writes, file-type allowlist, 1 MB cap, replace-deletes-old-file, clear flow |
| `test/notifications.test.js` | recipients per event (approvers + admins on submit; submitter on approve/reject), per-channel event filtering |
| `test/ad.test.js` | AD path with mocked ldapts: bind→search→re-bind, group→role mapping, attribute refresh on re-login, local-takes-precedence on collision, admin not downgraded by AD group mapping |
| `test/resetAdmin.test.js` | reset existing → forces change; reactivates disabled; creates as admin if missing; preserves role on existing; refuses AD; generated password complexity; full rescue scenario when all admins are demoted |
| `test/awaitingApproval.test.js` | the inbox-eligibility matrix: plain submitter empty, admin sees all-but-own, group-member sees own-group only, multi-group OR, legacy approver-role fallback only when no groups assigned, submitted-only state, oldest-first sort, deactivated types still listed, auto-approved types never reach inbox |
| `test/autoApprove.test.js` | mark type auto-approve, mutual exclusion with approverGroupIds (create + patch), submit lands on approved with two audit rows (human submit + system auto_approve), implement/close still work, field validation still runs at submit, no retroactive approval when flag is flipped on existing submitted records |

When adding or modifying an endpoint:

1. Add or update the test in `server/test/*.test.js`.
2. Update the route handler.
3. `npm test` → green.
4. Update this README's API section and `GET /api` if the surface changed.

## End-to-end tests (Playwright)

```bash
npm run test:e2e
```

The Playwright config (`playwright.config.js`) starts a fresh isolated server on port 3500 with a wiped `data-e2e/` directory each run, then runs the specs in `e2e/` against it. First-run installs the chromium browser on demand:

```bash
npx playwright install chromium
```

| Spec | What it covers |
| --- | --- |
| `e2e/auth.spec.js` | bootstrap admin/admin → forced password change → topbar branding → admin nav links → sign out |
| `e2e/changes.spec.js` | admin creates a server-reboot change as a draft via the form, sees it in the list |
| `e2e/admin.spec.js` | reaches each admin page (Users, Groups, Change Types, Settings) and exercises a basic interaction |
| `e2e/approval.spec.js` | end-to-end approver flow (admin creates submitter, submitter signs in & submits, admin sees Approvals badge with count, opens inbox, approves, badge clears) and end-to-end auto-approve flow (admin marks type auto-approve, submission goes straight to approved with the auto-approve note in the policy panel) |

## Continuous integration

`.github/workflows/ci.yml` runs on push and PR to `main`:

1. **`test`** — `npm ci`, `npm test` (vitest), `npm run build` (Vite)
2. **`e2e`** — installs Chromium, runs `npm run test:e2e`, uploads the Playwright report on failure
3. **`docker`** — builds the production container

Concurrency cancels in-progress runs on the same ref.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
