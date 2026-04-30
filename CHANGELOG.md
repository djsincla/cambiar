# Changelog

All notable changes to Cambiar are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning.

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
