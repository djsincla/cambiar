# Changelog

All notable changes to Cambiar are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning.

## [1.3.0] — 2026-05-08

Internal refactor — single point of truth for the scheduler boot/shutdown sequence. No user-visible behavior change; no schema change; no config change.

### Changed
- **`services/schedulerRegistry.js`** centralizes the `start*` / `stop*` invocations for all five schedulers (digest / email / recurring / alerts / gcal). `index.js` now calls `startAllSchedulers()` and `stopAllSchedulers()` and is unaware of the individual modules. Previously the boot sequence had ten lines mentioning each scheduler twice (once to start, once to stop), and adding a sixth would have meant editing `index.js` in two places.
- **Per-scheduler error isolation.** A failure in one scheduler's `start()` is now logged and isolated (`logger.error` with `scheduler: name`); the boot continues so a misconfigured email poller, for example, doesn't keep the rest of the app from coming up. Previously an exception from `start*` would crash boot.

### Tests
- 341 server tests, all green. No new tests — this is a structural change covered by the existing scheduler-behavior assertions.

## [1.2.0] — 2026-05-08

Operability release — gives ops actual signals to monitor instead of guessing.

### Added
- **Deep `/api/health`.** Probes the SQLite read path and reports per-scheduler liveness — `digest`, `recurring`, `email`, `alerts`, `gcal` — each with `{ enabled, lastTickAt }`. Returns **503** if the DB check fails so a load balancer / Docker `HEALTHCHECK` can drop the container out of rotation. `lastTickAt` is `null` until the scheduler has fired at least once since process start; subsequent values are ISO timestamps.
- **`GET /api/metrics`** — Prometheus exposition format (`text/plain; version=0.0.4; charset=utf-8`), admin-only via the existing JWT middleware. Metric families:
  - `cambiar_users_total{role,active}` — gauge
  - `cambiar_locked_users_total` — gauge
  - `cambiar_changes_total{status}` — gauge (excludes recurring parents)
  - `cambiar_active_alerts_total` — gauge
  - `cambiar_login_attempts_recent_total{outcome}` — gauge over the last hour
  - `cambiar_scheduler_last_tick_age_seconds{name}` — gauge (`-1` if never fired since start)

  HTTP-request histograms are deliberately out of scope here — operators usually get those from the reverse proxy.

### Internal
- New `services/schedulerHealth.js` is a process-local map (`name → ISO timestamp`). Each scheduler's fire callback calls `recordTick(name)`; the healthcheck and metrics route read it. No persistence — restart-resets is the right behavior for a "is the scheduler currently alive?" probe.

### Operator notes
- Prometheus scrape config:
  ```yaml
  - job_name: cambiar
    metrics_path: /api/metrics
    bearer_token: "<short-lived JWT — for continuous monitoring put auth behind a reverse proxy>"
    static_configs: [{ targets: ['cambiar.internal:3000'] }]
  ```
- The Docker `HEALTHCHECK` already calls `/api/health`; with the deeper response, `docker inspect` now shows DB + scheduler state in the health log.

### Tests
- 4 new server tests in `meta.test.js` covering the deeper health response shape, `/api/metrics` admin-only auth, the metric-family HELP/TYPE lines, and recent-login attempts surfacing in `cambiar_login_attempts_recent_total`. **337 → 341 server tests, all green.**

## [1.1.0] — 2026-05-08

Auth hardening + ops release. Five items from the post-1.0 review batch.

### Added
- **Login-attempt audit trail.** New `auth_events` table records every login attempt — success, invalid credentials, account disabled, account locked, AD unavailable, allowlist rejected — with IP, user agent (truncated to 256 chars), source (local/ad/unknown), and timestamp. Attempts on **unknown** usernames are also captured so password-spray patterns are visible without grepping logs. Available to admins via `GET /api/auth/events` (default 200, max 1000, optional `?outcome=invalid_credentials` filter; response includes the active lockout policy).
- **Per-account lockout.** After 5 failed attempts within a 15-minute rolling window, a local account is locked for 15 minutes. Locked accounts refuse even the correct password (with `403 retryAfterMinutes: 15`). The lockout check runs **before** bcrypt compare so spraying a locked account doesn't burn CPU. Cleared by a successful login within the window, by `POST /api/auth/clear-lock` (admin-only), by `npm run reset-admin`, or by the 15-min timer expiring naturally.
- **CSP.** Helmet's `contentSecurityPolicy` now configures explicit directives tuned for the Vite-built SPA: `script-src 'self'`, `style-src 'self' 'unsafe-inline'` (React's `style={{...}}` prop emits inline styles), `img-src 'self' data: blob:`, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`. The 1.0.2 hardening pass had CSP intentionally off pending this tuning.
- **Online backup CLI.** `npm run backup` produces a consistent SQLite snapshot via better-sqlite3's online backup API — safe to run while cambiar is live (a plain `cp` of the `.sqlite` file is **not** safe with WAL mode, since committed transactions live in `.sqlite-wal` until checkpoint). Options: `--out PATH` for a specific destination, `--uploads` to bundle `data/uploads/` as a tar.gz alongside. README has a Backups section with restore steps.
- **`parseJsonOr(text, fallback)` helper** at `server/src/db/json.js`. Wraps every DB-loaded JSON parse (`fields_json`, `details_json`, `action_config`, `status_filter`, `recipient_user_ids`, `recipient_emails`) so a corrupted row logs a warning and falls back instead of crashing the request handler. Retrofit across `routes/changes.js`, `routes/changeTemplates.js`, `services/audit.js`, `services/alerts.js`, `services/changeTypes.js`, `services/digestSchedules.js`, `services/emailActions.js`, `services/emailRules.js`, `services/recurringChanges.js`.

### Changed
- **Login flow runs bcrypt.compare even when the username doesn't exist** (`routes/auth.js`). Previously, the response time leaked existence — known username took ~250 ms (bcrypt cost 12), unknown returned in microseconds. Now both run a real cost-12 compare against either the user's hash or a startup-computed dummy hash. Eliminates the timing oracle.
- **`reset-admin` CLI now clears `locked_until`** alongside the password reset. Same recovery path operators already know.

### Operator notes
- **Two env vars** for test environments to bypass throttles, both set automatically in `playwright.config.js` and **not for production**:
  - `CAMBIAR_DISABLE_LOGIN_RATE_LIMIT=1` — skips the 1.0.2 per-IP rate limiter
  - `CAMBIAR_DISABLE_LOCKOUT=1` — skips per-account lockout (audit events still recorded)
- **Migration 018** adds the `auth_events` table + `users.locked_until` column. Auto-applied on next start.

### Tests
- 15 new server tests in `authEvents.test.js` covering audit-row shape on every outcome, lockout threshold, lock-survives-correct-password, lock-cleared-by-success, admin clear-lock + event-list endpoints, and the timing-flatness path. **322 → 337 server tests, all green.**
- E2E: **27/27 Playwright specs pass** under the new CSP. The first E2E run after enabling lockout exposed a test-helper pattern (admin-login races old/new password) that triggered the lock by ~test 6; fix was to skip throttles in E2E env.

## [1.0.2] — 2026-05-08

Hardening pass — quick wins from the 1.0 code review. No functional changes; all five items are independent and small.

### Added
- **Per-IP rate limit on `/api/auth/login`** (`express-rate-limit`). 10 attempts per 15-min window per IP. Closes online password-spray; bcrypt cost 12 was already protecting the offline path. Skipped under `NODE_ENV=test` so existing tests (which do many sequential logins) keep working without per-test resets. The 429 response body is `{ "error": "too many login attempts — try again in a few minutes" }`.
- **`helmet()` defaults except CSP** (`server/src/app.js`). Adds `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security` (in prod), and a few smaller headers in one middleware. Content-Security-Policy is intentionally OFF here — it needs SPA-aware tuning and lands as its own change in 1.1.
- **`SECURITY.md`** at the repo root. Points to GitHub's private vulnerability reporting form, lists scope, response timeline, and supported versions. The repo's "Security" tab now surfaces it. Private vulnerability reporting is enabled on the repo.
- **`.github/dependabot.yml`** with weekly grouped updates for npm (root + server + web workspaces), GitHub Actions, and the Dockerfile base image. Production and development deps are grouped separately so review batches are coherent. Major bumps land as individual PRs.

### Fixed
- **Stale version strings in `/api/health` and `/api`.** Both used to hardcode `0.1.0` (a leftover from project init). They now read `package.json` on each request — same pattern `settings.js` adopted in 0.19.0. The `/api` endpoint also dropped its hand-rolled (and chronically out-of-date) endpoint list in favor of pointers to the project site, source, and issues.

### Tests
- 322 server tests, all green. The `meta.test.js` test was updated for the new `/api` response shape (`name`/`version`/`docs`/`source`/`issues` instead of an `endpoints` array).

## [1.0.1] — 2026-05-07

Security patch — three stored-XSS vectors closed. Operators on 1.0.0 should upgrade.

### Fixed
- **Attachment upload extension is now derived from the validated mimetype, not the user-supplied filename** (`server/src/routes/attachments.js`). Previously, naming a file `evil.html` and declaring multipart Content-Type `image/png` let the file land on disk as `att-xxx.html`, which `express.static` then served as `text/html` — executing any embedded JS in cambiar's origin under the viewing user's session. Any authenticated user could upload; any user who clicked the resulting `/uploads/...` URL was the victim. Mimetype is allowlisted as before; the on-disk extension now comes from the allowlist mapping rather than the original filename.
- **SVG uploads removed from the allowlist** for both attachments (`routes/attachments.js`) and admin logo uploads (`routes/settings.js`). SVG natively supports `<script>` and event handlers; opening a malicious SVG via `/uploads/...` would execute in cambiar's origin. PNG with transparency covers the visual use case; recommend converting any existing SVG logo to PNG before redeploying.
- **Markdown component now allowlist-filters URLs in links and images** (`web/src/components/Markdown.jsx`). Notes can be authored by any authenticated user and rendered to any reader. Pre-fix, `[click](javascript:alert(document.body.innerHTML))` rendered as a working JS-execution link. The new `safeUrl()` helper accepts only `http:`, `https:`, `mailto:`, and same-origin relative URLs (`/`, `./`, `../`, `#`); everything else is rewritten to `#`.

### Hardened
- **`/uploads/*` responses now carry `X-Content-Type-Options: nosniff`** (`server/src/app.js`). Belt-and-suspenders for the attachment fix above — even if a stray binary did land on disk with an unexpected extension in the future, browsers won't sniff and re-interpret it as HTML/JS.

### Tests
- 3 new server tests in `notesAndAttachments.test.js` covering the on-disk filename derivation, SVG rejection, and the `nosniff` header. The previous "admin uploads SVG" test in `branding.test.js` now asserts SVG is rejected. **322 server tests** (was 319), all green.

### Internal
- Removed unused `extname` / `existsSync` / `unlinkSync` imports from `routes/attachments.js`.
- Inline comment in `routes/attachments.js` documents the original attack vector so the next reader doesn't accidentally re-introduce it.

## [1.0.0] — 2026-05-07

The flag-planting release. cambiar.world has been running in the workshop for weeks, has a complete change-management surface, and the API has settled. Calling it 1.0.

**No new features in this release** — same code as 0.22.0. This is a stability commitment, not a feature drop. From here on:
- The HTTP API surface is stable. Breaking changes would land in 2.0 with a clear migration path; non-breaking additions land in minor releases.
- The on-disk schema (SQLite + migrations folder + uploads/) is stable. Migrations only ever go forward.
- Branding defaults, CHANGELOG conventions, and the operator manual are stable.

**What landed across the 0.x series** (compressed retrospective; see entries below for detail):
- Local + AD/LDAP auth with allowlist + group/role sync
- Admin-managed change types with auto-approve + per-type SLA override
- Lifecycle: draft → submitted → approved → in_progress → implemented → closed (plus rejected, rolled_back) with full audit
- Approver groups (any-one-group) with submitter-can't-approve-own enforcement
- Notes, attachments (change-wide and threaded under specific notes), templates with copy-as-new
- Recurring changes (parent → cron → child)
- Linked changes (depends_on gates start/implement; relates_to is symmetric soft)
- Inbound email engine (IMAP poller → create / transition / add-note actions)
- Scheduled email digests with admin-defined recipients
- Operational alerts (approval-SLA + recurring-drift detection, with email notification)
- iCal subscription feed (per-user tokenized URL)
- Google Calendar push-sync (service-account driven, full event lifecycle)
- Calendar views: month / week / day / list with planned-duration time-grid blocks
- Light/dark theme, configurable branding (logo + app name)
- Mobile-responsive layout
- Standalone marketing site at docs/ (GitHub Pages)
- 319 server tests + 27 Playwright E2E specs in CI on every push
- Apache-2.0, single-container deploy, no SaaS dependency

**Approved by Mike. Mike has not read the source.**

## [0.22.0] — 2026-05-06

### Changed
- **Node 20 → Node 24** as the supported runtime. Updated in three places that matter operationally:
  - `Dockerfile` — all three stages (`web-build`, `server-build`, `runtime`) now base on `node:24-bookworm-slim`. Existing deploys keep working until they rebuild; the next `docker compose up -d --build` picks up the new image.
  - `package.json` `engines.node` → `>=24`. Local installs on Node 20–23 will warn (or fail under `engine-strict`).
  - `.github/workflows/ci.yml` — both the `test` and `e2e` jobs run on Node 24.
- 319 server tests still pass under the new runtime (verified locally on Node 25, which is stricter than 24).

### Operator notes
- If you run cambiar locally outside Docker, install Node 24 (or newer) before pulling: `nvm install 24 && nvm use 24`. Existing `node_modules/` may have native bindings (`better-sqlite3`, `bcrypt`) compiled against Node 20 — wipe and reinstall: `rm -rf node_modules server/node_modules web/node_modules && npm install`.
- The Docker path needs no extra steps beyond the rebuild.

## [0.21.0] — 2026-05-05

### Changed
- **Product brand renamed from "Cambiar" to "cambiar.world"** in every user-visible surface: SPA topbar default, browser tab title, iCal feed name and `PRODID`, Google Calendar event source, calendar event summaries (`[cambiar.world #N]` instead of `[Cambiar #N]`), email subjects from notifications / digests / alerts / SMTP test, AD-managed group lock messages, Active Directory sync UI copy, settings test email body, and the marketing site copy. Branding default in the settings table is now `cambiar.world`.
- The repository directory and git URL stay as `cambiar` — that's a stable identifier; only the product name shifted. The README explains this distinction up top.
- `notifications.email.from` example in `config/notifications.json` is now `cambiar.world <hello@cambiar.world>`.

### Added
- **Mike's endorsement** in the marketing-site hero. A dashed-border, slightly-tilted seal next to the View on GitHub CTA. Mike has not read the source. Mike is, however, &ldquo;sure it's fine.&rdquo;

### Internal
- Inbound email rule defaults updated to match the new subject prefix: `\[cambiar\.world #(\d+)\]` (was `\[Cambiar #(\d+)\]`). Existing user-configured email rules in production databases will need to be updated to match the new outbound subjects, or kept as-is to match historical messages.
- Tests updated to assert the new strings.

## [0.20.0] — 2026-05-04

### Added
- **Standalone landing page** at `docs/index.html` for sharing the project. Self-contained HTML + CSS — no JS framework, no analytics, no third-party requests, no build step. Hero, capabilities tour grouped by what they enable, an honest "what it isn't" section, a quick-start snippet, and a "shape of the project" footer. Deployable to GitHub Pages (this is the source folder GitHub Pages publishes), Netlify, or any static host. (The folder was briefly named `marketing/` before being renamed to `docs/` so GitHub Pages could publish it.)

### Changed
- App-name default in the running workshop instance is `cambiar.world` (was `cambiar`). The display name lives in `branding.app_name` and is editable through Admin → Settings; this is just the new default for fresh installs.

## [0.19.0] — 2026-05-01

### Added
- **Google Calendar push-sync.** Cambiar can now push changes directly into a shared Google Calendar via the Calendar API, in addition to (or instead of) the per-user iCal subscription. Events appear/update/disappear in the workshop's normal calendar without any user action — no subscribe step, no polling lag from the calendar client side.
- **Service-account auth.** Set up a service account in Google Cloud, save the JSON key to `config/gcal-service-account.json` (gitignored), share the target calendar with the service account's email, fill in the calendar ID + the credentials path in `notifications.googleCalendar`, restart. README has the full walkthrough.
- **Background reconciler.** Same scheduling pattern as digests / recurring / alerts: every `syncIntervalMinutes` (default 5) the reconciler picks up changes whose `updated_at` is past their last sync, plus newly-eligible / newly-de-eligible ones, and reconciles. Submitted → tentative event; approved/in_progress/implemented → confirmed; draft/closed/rejected/rolled_back → event deleted. Recurring parents are excluded — they're generators, not events.
- **Admin page** at `/admin/gcal` (under `Admin ▾`) shows enabled/disabled state, calendar ID, credentials path resolution, sync interval, and counts (eligible / currently published / never synced) plus a **Sync now** button for verification.
- **`GET /api/admin/gcal/status`** returns the same status payload (admin-only).
- **`POST /api/admin/gcal/sync-now`** triggers an on-demand reconcile and returns counters (`inserted`, `updated`, `deleted`, `skipped`, `errors`).

### Fixed
- Topbar version stayed stale after a `package.json` bump until a full process restart. Server now reads `package.json` on every `/api/settings/branding` call (small file, cheap parse). The SPA also re-fetches branding on window focus, so a deployed version bump shows up without a hard reload.

### Internal
- Migration 017 adds `changes.gcal_event_id` (the Google event id, set after a successful insert) and `changes.gcal_synced_at` (last successful reconcile pass), plus a partial index on the hot read path.
- New `services/googleCalendar.js` (auth + event CRUD via `googleapis`), `services/gcalSync.js` (reconciler), `services/gcalScheduler.js` (node-cron wrapper).
- Tests use a `setCalendarClientForTests` seam to swap in an in-memory fake — no network in CI. 10 new server tests cover insert/update/delete branches, idempotency, the 404-already-gone case, recurring-parent exclusion, the disabled-integration short-circuit, and the admin API surface. 309 → 319 server tests, all green.
- `config/gcal-*.json` is gitignored to keep service-account keys out of source control.

## [0.18.0] — 2026-05-01

A quality-pass release: closes loose ends from recent feature work, adds the missing UI test coverage, and tidies the docs.

### Added
- **Per-change-type SLA override** (refines 0.15). New nullable `change_types.approval_sla_minutes` column. When set, alerts use this threshold for changes of that type; otherwise they fall back to the global default. The change-type editor exposes a numeric input under "Approval policy"; emergency-bypass types can page sooner than routine ones (e.g. 60 min vs the global 24h default).
- **Transitive cycle detection on change links** (refines 0.13). Adding `A depends_on B` is now refused if `B` already reaches `A` through any chain of `depends_on` edges, not just the direct `B → A` case. Walks the existing graph in `wouldCreateCycle()`; small graph + the deadlock that a multi-step cycle would cause justifies the extra walk.
- **Admin nav dropdown.** The 7 admin links collapsed into an `Admin ▾` menu (Users, Groups, Change types, Digests, Email rules, Settings) — frees real estate on tablets and phones. Closes on click-outside / ESC / navigation. **Alerts** stays top-level so the active-count badge nags ops without a click.

### Changed
- **Disk gc for orphaned attachment files.** Deleting a note now unlinks any threaded attachment files from disk before the FK CASCADE removes the DB rows; deleting a draft change does the same for all its attachments and removes the now-empty per-change uploads dir. Previously these files lingered indefinitely. Refactored the existing single-attachment delete path through the same shared `attachmentFiles.js` helper.
- **README** refreshed to cover the 0.7–0.17 features (recurring, email ingestion, AD allowlist + sync, change links, iCal feed, alerts, mobile responsive). Test counts updated.

### Internal
- Migration 016 adds `change_types.approval_sla_minutes` (nullable; existing rows keep `NULL` and inherit the global default — same behavior as before).
- New `services/attachmentFiles.js` centralizes safe file-unlink + empty-dir cleanup. Rooted at `data/uploads/changes/` so a hostile filename can't escape.
- `wouldCreateCycle(from, to)` is exported from `services/changeLinks.js` for reuse.
- Stale completed tasks (#79–85, originally for 0.7/0.8/0.9) cleaned up in the local task list. They had shipped long ago — only the bookkeeping was outstanding.

### Tests
- 4 new server tests (309 → was 305): per-type SLA, transitive cycle rejection, on-disk file removal on note-delete, and on-disk file removal on change-delete.
- 4 new Playwright E2E specs covering the gaps from 0.13–0.16: change-links blocking gate, alerts admin page + check-now, iCal subscribe panel + token rotation + public feed fetch, and per-note attachment threading + cascade-on-delete. 23 → 27 specs, all green. Existing specs that drove the topbar Users/Groups/Change Types/etc. links now route through a new `openAdminPage(page, label)` helper to handle the dropdown.
- Investigated the long-standing `digests.test.js > resolves user-id recipients` "socket hang up" flake — three full back-to-back suite runs all passed clean (305/305 each); leaving as monitored.

## [0.17.0] — 2026-05-01

### Changed
- **Mobile/responsive polish.** Two new breakpoints (`<= 900px` tablet, `<= 600px` phone) tighten the layout for narrow screens.
- **Topbar** wraps onto multiple rows on phones instead of forcing nav links off-screen. Brand text shrinks; user controls stay on the right.
- **Calendar week view** now horizontally scrolls inside its panel on phones (each day column keeps a sensible min width — chips stay legible — and the user swipes to see the rest of the week). The day view stays single-column with a smaller hour gutter.
- **Month view** chips and cells shrink so a 7-column layout still works on phones.
- **Tables** inside panels scroll horizontally rather than busting the layout.
- **Inputs** go full-width on phones, so a tap doesn't have to land on a 200-px target.

### Internal
- All polish is CSS-only (`web/src/styles.css`) plus a small markup change on the time-grid: it's now wrapped in a `.time-grid-wrap` scroll container and tagged `.time-grid-week` / `.time-grid-day` so the week-view min-width applies only to the week. No JS or schema changes.

## [0.16.0] — 2026-05-01

### Added
- **Attachments threaded under specific notes.** Files can now be uploaded as part of a note rather than just to the change as a whole. Useful when a change accumulates evidence over time — screenshots from one investigation step stay with the note that describes them, so a reader doesn't have to guess which of fifteen change-wide attachments belongs with which note.
- **`POST /api/changes/:id/attachments`** now accepts an optional `noteId` form field. The note must belong to the change (cross-linking is refused with `400`).
- **`GET /api/changes/:id/attachments?scope=change-wide`** returns only un-threaded attachments. **`?scope=note&noteId=N`** returns just that note's attachments. No scope returns all (legacy).
- **Per-note attachment row** in the Notes UI: each note shows its threaded files inline as a chip row (filename + thumbnail for images + size + delete control for the author/admin). An **+ Attach file** button on each note uploads through to the threaded list. The change-wide Attachments panel below now only shows un-threaded files.
- **Delete cascade:** removing a note removes any attachments threaded under it (the on-disk files are not currently re-claimed by the cascade — only the DB rows are; the disk gc is a follow-up).

### Internal
- Migration 015 adds `change_attachments.note_id` (nullable; existing rows keep `NULL`, meaning "change-wide" — same behavior as before) with an `ON DELETE CASCADE` FK to `change_notes` and a partial index on non-null values for the per-note read.
- Multer parses non-file form fields into `req.body`, so the upload route validates `noteId` on the same request that sets it. Note ownership is enforced (`note.change_id = path :id`) to prevent cross-change linking.
- 4 new server tests in `notesAndAttachments.test.js` cover the threaded upload + scope filters, cross-change rejection, the cascade on note delete, and malformed `noteId` rejection. 301 → 305 server tests, all green.

## [0.15.0] — 2026-05-01

### Added
- **Operational alerts.** A scheduled checker now raises and resolves operational alerts on its own, so problems surface before someone notices the absence of a thing.
  - **Approval SLA** — fires when a change has been sitting in `submitted` past the configured threshold (default 24 h) without an approve/reject. Resolves automatically when the change moves out of `submitted`.
  - **Recurring drift** — fires when a recurring parent's `recurrence_last_fired_at` is older than the most recent expected fire time (computed from its cron + timezone) by more than the tolerance (default 5 min). Catches "the scheduler missed an interval" or "a fire failed silently". Resolves once the parent fires again.
- **Idempotent.** Each `(kind, subject)` is single-active — re-running checks while the condition persists doesn't re-fire or re-notify.
- **Email notifications** to admins when a new alert first fires (uses the existing SMTP transport; recipient list defaults to active admins' emails, overridable via `notifications.alerts.notifyEmails`).
- **`GET /api/alerts/count`** — lightweight active-alert count, available to any authed user (powers the topbar badge).
- **`GET /api/alerts?status=active|resolved`** — admin-only list view.
- **`POST /api/alerts/:id/resolve`** — manual close.
- **`POST /api/alerts/check-now`** — admin-triggered immediate run for testing or after a config change.
- **Admin Alerts page** at `/admin/alerts` with active/resolved tabs, age display, and Resolve / Check now controls. **Topbar Alerts badge** for admins shows the active count, polled every 60 s.

### Internal
- Migration 014 adds `alerts(id, kind, subject_change_id, fired_at, resolved_at, notified_at, details_json)` with `kind IN ('approval_sla','recurring_drift')`, FK CASCADE to `changes`, and a partial index on unresolved rows for the hot read path.
- `services/alerts.js` — `runAlertChecks`, `listAlerts`, `resolveAlert`, `activeAlertCount`. `services/alertsScheduler.js` runs every `notifications.alerts.checkIntervalMinutes` (default 15) via node-cron, started/stopped from `index.js` next to the digest, recurring, and email pollers.
- 12 new server tests in `alerts.test.js` cover SLA fire/no-fire/idempotency/auto-resolve, drift fire/resolve/no-fire-on-disabled-parents, the count endpoint's auth, and the admin list/resolve/check-now routes.

## [0.14.0] — 2026-05-01

### Added
- **iCal subscription feed.** Each user can now subscribe to a per-user `webcal://`-style URL and see upcoming changes in Google Calendar, Apple Calendar, or any iCal-compatible app — alongside their other commitments, no Cambiar login needed.
- **`GET /ical/upcoming.ics?token=<token>`** — public, token-authed (the token *is* the credential — calendar apps don't do interactive auth). Returns RFC 5545 iCalendar with one `VEVENT` per scheduled change in `[now-7d, now+90d]` whose status is `submitted`, `approved`, `in_progress`, or `implemented`. Recurring parents are excluded — they're generators, not events.
- Each event has `DTSTART` from `scheduled_at`, `DTEND` from `scheduled_at + planned_duration_minutes` (default 30 min), `SUMMARY` `[Cambiar #N] Title`, `URL` back to the change detail, and `STATUS` `TENTATIVE` for `submitted` or `CONFIRMED` for everything else. Closed/rolled-back/rejected/draft are filtered out — drafts aren't commitments and the rest are done.
- **`GET /api/auth/me/ical-token`** returns the user's current token (creating one on first read), and **`POST /api/auth/me/ical-token/rotate`** replaces it. Old tokens stop authenticating immediately on rotation.
- **Subscribe… UI** on the `/upcoming` page: panel shows the URL, copy-to-clipboard button, rotate-token button, and quick subscription instructions for Google Calendar and Apple Calendar.

### Internal
- Migration 013 adds `users.ical_token TEXT` with a unique partial index on non-null values.
- New `BASE_URL` env var (default `http://localhost:3000` in dev) feeds `config.baseUrl` so feed URLs and event `URL:` fields use the externally-reachable hostname.
- `services/icalFeed.js` — `generateIcalToken`, `findUserByIcalToken`, `getOrCreateIcalToken`, `rotateIcalToken`, `buildIcalFeed`. The feed renders CRLF line endings as RFC 5545 mandates and escapes `,`, `;`, `\`, and newlines per spec.
- 9 new server tests in `ical.test.js` cover token-stable-on-reread, rotation invalidating the old token, missing/invalid token returning 401 plain text, content-type, status mapping (submitted → TENTATIVE), inactive-user refusal, and recurring-parent exclusion.

## [0.13.0] — 2026-05-01

### Added
- **Linked changes.** A change can now declare its relationship to other changes:
  - **`depends_on`** (directional) — A depends on B; A can't be **started** or **implemented** until B is `implemented` or `closed`. Both `/start` and `/implement` enforce the gate, so callers who skip the in_progress step still hit it.
  - **`relates_to`** (symmetric) — soft "see also" link, no enforcement. Stored canonically (lower id first) so adding A→B and B→A doesn't double up.
- **`POST /api/changes/:id/links`** — body `{ toChangeId, kind }`; owner/admin only. Self-links, duplicates, and direct cycles on `depends_on` (A→B exists, then B→A) are rejected with `409`.
- **`DELETE /api/changes/:id/links/:linkId`** — owner/admin only; the link must touch the path change (so `/api/changes/A/links/X` can't delete a link belonging to change B).
- **`GET /api/changes/:id`** payload now carries a `links` block: `{ dependsOn, blockedBy, blocks, relatedTo }`. `blockedBy` is the subset of `dependsOn` whose target isn't yet implemented or closed — the same predicate the gate uses, so the UI never disagrees with the server.
- **Linked-changes panel** on the change-detail page: list with status badges, "+ Link a change" form (kind + change id), Remove buttons. When `blockedBy` is non-empty, a banner explains the block and the **Start implementation** / **Mark implemented** buttons are disabled with a tooltip listing the unmet prereqs.

### Internal
- Migration 012 adds `change_links(id, from_change_id, to_change_id, kind, created_at, created_by)` with `kind IN ('depends_on','relates_to')`, `UNIQUE(from, to, kind)`, FK `ON DELETE CASCADE` from both ends, and indexes on each direction. Deleting a change cascades its links cleanly.
- `services/changeLinks.js` — `addLink`, `removeLink`, `getLink`, `getLinksForChange`, `getBlockingDeps`. The latter is the single source of truth for the gate, called by both `/start` and `/implement`.
- 14 new server tests in `changeLinks.test.js` cover CRUD, self/duplicate/cycle rejection, ownership, payload symmetry, the start/implement gate (including bypass via direct `/implement`), `closed` as also "complete enough", `blockedBy` shape, link cascade on draft delete, and audit-log capture of `add_link` / `remove_link`.

## [0.12.0] — 2026-04-29

### Added
- **AD allowlist gate.** New `auth.ad.allowedGroups` config option. When non-empty, only AD users who are members of at least one of the listed groups can log in — even if their AD password is correct. Empty (default) means "any authenticated AD user can log in", preserving prior behavior. Pattern match is case-insensitive substring against each `memberOf` DN, so `Cambiar-Users` matches `cn=Cambiar-Users,ou=Groups,dc=example,dc=com`.
- **AD group sync.** New `auth.ad.groupSync` config. Each entry maps an AD group to a Cambiar group and (optionally) a role:
  ```yaml
  groupSync:
    - { adGroup: Cambiar-Approvers, cambiarGroup: Approvers, role: approver }
    - { adGroup: Cambiar-Admins,    cambiarGroup: Admins,    role: admin    }
    - { adGroup: Cambiar-Users,     cambiarGroup: AllUsers }
  ```
  On every AD login the user's Cambiar group memberships are reconciled to match their AD memberships — added to mapped groups they belong to in AD, removed from mapped groups they no longer belong to. Cambiar groups created this way are flagged `ad_managed`.
- **Role composition** — `groupSync` entries with a `role` compose with `groupRoleMap`. Highest role wins (admin > approver > submitter), so a user in both `Cambiar-Approvers` and `Cambiar-Admins` ends up `admin`.
- **AD-managed group lock** — groups flagged `ad_managed` are read-only via the API. `PATCH /api/groups/:id`, `DELETE /api/groups/:id`, and member add/remove endpoints all return `409` with the message *"this group is AD-managed and reconciled on every AD login; edit the AD group, not Cambiar"*. The Groups admin page shows an **AD-managed** badge, swaps the Edit/Delete buttons for a single View action, and disables the form fields when viewing one.

### Internal
- Migration 011 adds `groups.ad_managed` (default 0).
- `auth/ad.js` gains `userIsAllowedByAD()` and `syncADUserGroups({ userId, adGroups })`. `mapGroupsToRole()` now folds in roles declared on `groupSync` entries.
- `routes/auth.js` login flow: after a successful AD bind, gate on `userIsAllowedByAD` (403 if denied), then run `syncADUserGroups` in a try/catch — sync failure logs but does not block the login (last-known group set still applies).
- `services/groups.js` exposes `adManaged` on every group payload and adds an `isAdManaged(id)` helper.
- 8 new server tests in `adAllowlistAndSync.test.js` cover allowlist accept/reject/empty, auto-create + reconcile + drift removal, role composition (admin wins over approver), and the AD-managed lock semantics on PATCH/DELETE/member endpoints.

## [0.11.0] — 2026-04-30

### Added
- **Recurring changes.** A change can now be marked as a recurring **parent** that spawns **child** changes on a cron schedule. Each child has `parent_change_id` pointing back, copies the parent's blueprint (type, title, description, fields, planned duration), and flows through the normal lifecycle. Parents themselves don't run the lifecycle — they're generators. Composes with `auto_approve` change types and the existing approval workflow: cron fires → child created → optionally auto-submitted → optionally auto-approved.
- **Recurrence config** per parent: cron expression, time zone, lead minutes (how far ahead to set the child's `scheduled_at` — 0 = "right now", 10080 = "one week ahead"), auto-submit flag, enabled flag.
- **`POST /api/changes/:id/recurrence`** — set or update; **`DELETE /api/changes/:id/recurrence`** — clear (existing children untouched); **`POST /api/changes/:id/spawn-now`** — manual fire for testing.
- **`GET /api/changes?recurring=parents`** returns the recurring-parents view; the default change list excludes parents (use `?includeRecurringParents=true` to opt in).
- **`GET /api/changes/:id`** payload now includes `parent` (when this is a child) and `recurring` (when this is a parent, including a `recentChildren` list).
- **Recurrence panel** on the change detail page: "Make recurring…" affordance for any change, then a read-only view with quick-pick cron presets, "Spawn now" button, and the recent children table. A child shows a "Spawned from #N" badge linking back to its parent.
- **`/recurring` listing page** shows all recurring parents with cron / tz / lead / auto-submit / enabled / last fired / child count. Reachable from the topbar.

### Internal
- Migration 010 adds `parent_change_id`, `is_recurring_parent`, and the `recurrence_*` columns to the `changes` table.
- `services/recurringChanges.js` — `setRecurrence`, `clearRecurrence`, `spawnChildFromParent`, `listRecurringParents`, `listChildren`. The spawn helper handles auto-submit + auto-approve in a single transaction so children are atomic.
- `services/recurringScheduler.js` — node-cron-driven, hot-swap on PATCH, mirrors `digestScheduler.js`. Started/stopped from `index.js` next to digests and the email poller.
- 16 new server tests for the lifecycle, spawn correctness, parent exclusion from default lists, payload shape, and cron validation. 1 new Playwright spec for "make recurring → spawn now → see in /recurring".

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
