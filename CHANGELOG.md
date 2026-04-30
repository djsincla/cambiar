# Changelog

All notable changes to Cambiar are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning.

## [0.10.0] — 2026-04-30

### Added
- **Inbound email engine.** Cambiar can now ingest mail from a configured IMAP mailbox and turn each message into a change-management action. Use it to wire monitoring systems, ticket forwarders, or "reply [Cambiar #N] RESOLVED" workflows into the lifecycle.
- **Three action types** per rule:
  - `create_change` — open a fresh change (optionally instantiated from a template), with the email subject/body mapping to title/description, optional auto-submit (and auto-approve via the change type's flag).
  - `transition` — extract a change id from the subject (default regex `\\[Cambiar #(\\d+)\\]`, which matches outbound notification subjects) and run a verb (`submit`/`approve`/`reject`/`start`/`implement`/`close`/`rollback`).
  - `add_note` — append the email body as a markdown note on the referenced change.
- **Rules** stored in DB, ordered by priority (lower = higher), matched on `from`/`subject` regex (case-insensitive). Highest-priority enabled rule wins; misses are logged but ignored.
- **email_log** with the recent processed messages for debugging — every match, miss, and error visible to admin.
- **Idempotency by Message-ID** — replays are skipped, so a flaky IMAP server retrying a fetch can't double-create.
- **Synthetic `email-system` user** owns email-driven changes; audit rows on every affected change record `source: 'email'`, the `From`, `Subject`, `messageId`, and the matching `ruleId`. The actor is unambiguous in the history.
- **Admin UI at `/admin/email`** — rules CRUD, action-config defaults, regex preview, "Poll now" button, and a live log viewer (refreshes every 30 s).
- **Test rule** endpoint (`POST /api/email-rules/:id/test`) accepts a synthetic email payload and runs it through the full pipeline so admins can validate a rule before unleashing it on real mail.

### Internal
- Migration 009 adds `email_rules`, `email_log`, and bootstraps the `email-system` user (active=0, password-hash placeholder — login-blocked but available as an FK target for ingested rows).
- New deps: `imapflow` (modern pure-JS IMAP client), `mailparser` (RFC-822 parser).
- `services/emailRules.js` (CRUD + matching), `services/emailActions.js` (action executor + log writer), `services/emailPoller.js` (interval-driven IMAP poll, hot-startable from config).
- 15 new server tests covering rule CRUD, regex validation, priority ordering, action execution for all three types, audit-row source tagging, error paths, and Message-ID dedupe.
- 1 new Playwright spec for the admin UI.

## [0.9.0] — 2026-04-30

### Added
- **Notes** on every change — a chronological timeline of markdown-formatted text entries. Anyone authed who can see the change can post; only the author or an admin can edit/delete. Markdown supports `**bold**`, `*italic*`, `` `code` ``, `[links](url)`, and `![alt](url)` images so notes can reference uploaded attachments inline.
- **Attachments** on every change — file uploads (PNG, JPEG, SVG, WebP, GIF, PDF, plain-text, CSV, JSON; 10 MB cap). Image gallery with click-to-enlarge lightbox; non-image files render as cards with download links. Attachments live at `/uploads/changes/<id>/<filename>` so they can be referenced from notes.
- **Change templates** — pre-filled blueprints for recurring kinds of work. New `/templates` page lists available templates; **Start a change** instantiates a draft from a template. Admins (and template creators) can edit or delete.
- **Save as template** button on any change's detail page — captures the current title, description, type, fields, and planned duration as a reusable template. Notes and attachments are not copied (they're specific to the originating change).
- **Copy as new change** button on any change's detail — opens the new-change form pre-filled from the existing change. The new draft is owned by the current user; notes and attachments are not copied.

### Changed
- `POST /api/changes` now accepts an optional `templateId` or `copyFromChangeId` to seed the create payload. Body fields override the seed where supplied. The audit row's `details` records the source.
- `Markdown` component (used for the release-notes page and now notes) gained inline-image support (`![alt](url)`).

### Internal
- Migration 008 adds `change_notes`, `change_attachments`, and `change_templates`.
- 18 new server tests across notes (CRUD + permissions), attachments (upload allowlist, size cap, ownership-on-delete), templates (CRUD + permissions), and create-from-template / copy-from-change paths.
- 3 new Playwright specs covering note posting + render, save-as-template + start-from-template, and copy-as-new.

## [0.8.0] — 2026-04-30

### Added
- **`in_progress` status** — the missing state between `approved` and `implemented`. Surfaces "we're hands-on right now" distinctly from "approved, scheduled for next week". Lifecycle is now `draft → submitted → approved → in_progress → implemented → closed`, with `rejected` from `submitted` and `rolled_back` from `in_progress` / `implemented` / `closed`.
- **`POST /api/changes/:id/start`** transitions `approved → in_progress`, recording `in_progress_at`. Skipping it is fine — `/implement` still accepts an `approved` change for retroactive recording.
- **Auto-derived actual duration.** When `/implement` is called without an explicit `actualDurationMinutes` and `in_progress_at` was recorded, the server fills `actualDurationMinutes` from elapsed wall-clock time and notes `derivedFromInProgressAt: true` in the audit row.
- **Calendar attention** for in-progress work: time-grid blocks and month chips render in a high-contrast warning palette; the detail-page badge gently pulses so it's obvious from a glance which work is live.
- **WhyPanel** explains the new state in viewer-context terms: "Implementation in progress" with the right buttons surfaced (Mark implemented, Roll back) when the viewer can act, or who's currently on it when they can't.

### Changed
- `POST /api/changes/:id/implement` now accepts both `approved` and `in_progress` as the predecessor state.
- `POST /api/changes/:id/rollback` now accepts `in_progress` (in addition to `implemented` and `closed`) — aborting work mid-flight is a real scenario.

### Internal
- Migration 007 rebuilds the `changes` table to extend the `status` CHECK constraint and adds the `in_progress_at` column. Migration runner gained an opt-out marker (`-- @no-tx`) so migrations that need to manage their own transactions (e.g. PRAGMA toggles) can do so without nesting.
- 13 new server tests for the in_progress lifecycle. 1 new Playwright spec for the full `approve → start → implement` flow.

## [0.7.0] — 2026-04-30

### Added
- **Planned and actual duration** on every change. `plannedDurationMinutes` is set at create or edit time; `actualDurationMinutes` is recordable when implementing or any time after (admin or submitter, while the change is `implemented` or `closed`). Detail view shows planned vs actual side-by-side with an inline "+/− over/under" variance label.
- **Calendar Week and Day views.** The `/upcoming` page now toggles between **Month / Week / Day / List**. Week and Day are time-grid views: hours as rows, days as columns, blocks rendered with height proportional to the planned duration. Overlapping blocks stack side-by-side automatically.
- **Calendar navigation** is view-aware. Prev / Next steps by month, week, or day depending on the active view. A **Today** button resets the anchor.
- **Status-colored time blocks** in week/day views and an enriched chip in month view that shows start time + duration (e.g. `14:30 Reboot · 2h`).

### Changed
- `POST /api/changes/:id/implement` now accepts an optional `actualDurationMinutes` body. The audit row records it under `details`.
- New endpoint `PATCH /api/changes/:id/actual-duration` for setting or clearing actual duration after implementation. Owner or admin only; rejected on draft/submitted/approved.

## [0.6.0] — 2026-04-30

### Added
- **Upcoming view** at `/upcoming` (linked from the topbar) with two modes you toggle between: a **list** of changes scheduled in the next 14 days and a **calendar** month grid with prev/next navigation. Status checkbox filter is shared between modes. Status-colored chips in calendar cells; click any chip to open the change.
- **Digest schedule engine** — admins create cron-driven email digests of upcoming changes. Each schedule has its own cron expression, time zone, lookahead window, status filter, and recipient list (mix of registered users and free-form emails). Backed by `node-cron`, runs in-process, hot-swaps schedules when admins edit, persists `last_run_at` / `last_sent_at` / `last_error` for visibility.
- **`/admin/digests`** admin page: list / create / edit / disable / delete schedules with a **Send now** button per schedule for immediate testing.
- **`/api/digests`** CRUD + `POST /api/digests/:id/run-now` endpoint. `GET /api/changes` now accepts `scheduledFrom`, `scheduledTo`, and CSV `status=foo,bar` filters and sorts by `scheduled_at` ASC when a date range is supplied.
- **Send test email** button on the Settings page (admin-only) — fires a real SMTP send and surfaces success or the underlying error so admins can verify email config without faking a change.

### Internal
- 15 new server tests covering the digest CRUD endpoints, cron-validation, recipient resolution (user-IDs + free-form emails), email-disabled error path, no-recipients error path, last-run/last-sent persistence, and the upcoming date-range filter on `GET /api/changes`. 2 new Playwright E2E tests covering the upcoming view tab toggle and creating a digest schedule from the admin UI.

## [0.5.0] — 2026-04-30

### Added
- **Viewer-context hints** on the change list and detail pages: "awaiting you" / "awaiting others" / "your draft" / "ready to implement" labels next to each row's status, so it's obvious at a glance who needs to act. The `/api/changes` payloads now include `viewerCanApprove` and `viewerIsSubmitter` flags to power this.
- **WhyPanel** on change detail explaining *why* the current viewer can or can't act ("You submitted this — someone else has to approve it", "Only members of NetEng can approve this type", etc.).
- **Friendly status labels** in the UI — `submitted` reads as "Awaiting approval", `rolled_back` as "Rolled back", and so on. Status filter dropdown uses the same labels. (Underlying status values and CSS classes are unchanged.)

### Changed
- **Theme toggle** in the topbar is now a sun / moon icon, not a text label.
- **Release notes link** in the topbar replaced by a clickable `vX.Y.Z` version pill on the right side; clicking it opens the release notes page.

## [0.4.0] — 2026-04-29

### Added
- **Theme toggle** — light and dark modes, persisted per browser. Default is dark. Toggle lives in the topbar.
- **Release notes page** — `/release-notes` (linked from the topbar) renders this changelog inside the app so anyone signed in can see what shipped recently. Backed by `GET /api/release-notes`.

## [0.3.0] — 2026-04-29

### Added
- **Approver inbox** — topbar `Approvals` link with a count badge of changes currently waiting on the signed-in user. Polls every 60 seconds, refreshes on navigation. Backed by `GET /api/changes?awaitingMyApproval=true` with admin override, group membership, and legacy approver-role fallback.
- **Auto-approve change types** ("standard change" in ITIL terms). A change type can be marked auto-approve so submissions of that type skip the approval gate entirely. Mutually exclusive with approver groups. Audit log captures the system actor on the auto-approve transition.

### Fixed
- The `submitted` notification recipient list now uses the same eligibility predicate as the inbox, so what gets emailed matches what shows up in inboxes. Previously it sent to anyone with `role IN ('approver', 'admin')` and ignored group membership entirely.

### Internal
- 20 new server tests (12-permutation inbox matrix, 6 auto-approve scenarios). 1 new Playwright spec covering the full approver handoff and the auto-approve flow.

## [0.2.0] — 2026-04-29

### Added
- **`reset-admin` CLI** for host-side password recovery. `npm run reset-admin` (or `docker compose exec cambiar npm run reset-admin`) generates a strong random password, sets `must_change_password=1`, reactivates a disabled account, and creates the user as admin if missing. Refuses AD-sourced users. No API equivalent — recovery requires direct host access by design.

### Internal
- `config.jwt.secret` is now a getter so CLI tools that touch the database but not authentication don't require `JWT_SECRET` to be set.

## [0.1.0] — 2026-04-29

Initial release.

### Added
- API-first Node.js + Express backend with SQLite persistence.
- Authentication: local accounts (bcrypt) + Active Directory / LDAP. Local takes precedence on username collisions, so the bootstrap admin always works.
- Bootstrap `admin` / `admin` account created on first run, forced to change password on first login.
- Roles: admin, approver, submitter, with role-based access control.
- Many-to-many user/group membership; per-change-type approver groups; any-one-group approval policy.
- Workflow with full audit trail: draft → submitted → approved → implemented → closed, plus rejected and rolled-back branches. Submitters can never approve their own change.
- Change types defined in DB; first-run seed imported from `config/change-types.json` (server reboot, firewall rule, software update, storage, network, generic). Admins manage the catalog through the UI.
- Pluggable notifications: email via SMTP (nodemailer), SMS via Twilio (lightweight REST adapter, no SDK). Per-event channel filtering.
- Configurable branding: admin-uploadable logo (PNG, SVG, JPEG, or WebP, max 1 MB) and app name. Logo renders top-left for everyone, including the login screen.
- React + Vite single-page app served by Express in production.
- Multi-stage Dockerfile + `docker-compose.yml` for single-container deployment.
- 131 vitest API tests + 10 Playwright E2E tests. CI runs both plus Vite build and Docker build on every push/PR.
- Apache 2.0 license.
