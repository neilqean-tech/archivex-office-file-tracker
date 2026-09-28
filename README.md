# ARCHIVEX — Office File Tracker

A full-stack office document registry and circulation system: register physical and
digital files, track who has them (chain of custody), enforce retention schedules,
dispose of records formally, and give every file a scannable QR tag that opens a
public status page.

**Stack:** Node.js + Express, SQLite (better-sqlite3-style `sqlite3` driver), vanilla
HTML/CSS (Tailwind) single-page front end — no build step, no framework.

---

## Quick start

```bash
npm install       # first time only
npm start         # or double-click start-server.bat
```

Then open **http://localhost:3000** and log in.

| Role | Username | Password | Quick-PIN |
|---|---|---|---|
| Administrator | `admin` | `admin123` | `1234` |
| Records Officer | `officer1` | `staff123` | `5678` |

> **Before real use:** change these passwords and PINs immediately
> (**Options → Change Password / Manage Staff**). They are demo credentials.

Only **one active session per account** is allowed — logging in anywhere else
signs the previous session out. Wrong passwords/PINs are rate-limited
(5 attempts).

---

## Features

| Tab | What it does |
|---|---|
| **Dashboard** | KPIs, overdue/disposal banners, activity chart, recent activity |
| **Document Registry** | Register / edit / archive files, per-column sort buttons, quick-find (Ctrl+K), CSV import/export, inventory report & QR tag printing |
| **Circulation Desk** | Check files out/in with borrower, due date, custody chain, overdue tracking |
| **Audit Trail** | Immutable log of every action, filterable by date range (flows into CSV export) |
| **Options** | Backup download/restore, CSV import, change password, Manage Staff (admin) |

- **Retention & disposal** — every record can carry a retention due date; past-due
  files are flagged, and disposal is a formal two-step action (Quick-PIN) that keeps
  the record + full audit history as `DISPOSED` instead of deleting it.
- **QR tags** — print a label per file; scanning opens the public viewer below.
- **Public viewer `/view/:code`** — no login needed. Shows status, storage location,
  and the digital copy link. **Classified files hide their location and digital link
  behind a Quick-PIN gate** (PIN is never shown to non-admins on the page).

### Digital copies (`docs/` folder)

Place digital copies in the `docs/` folder next to `server.js` and reference them
in a record's *Digital path* field as `docs/your-file.pdf`.

- Openable **in the browser**: `docs/…` files (PDF, images, video, text) and full
  `http(s)://` links. Office files (docx/xlsx/…) and zips download instead —
  browsers can't display those inline.
- Not openable from the page (shown as read-only reference): `file://`, FTP, UNC
  or any path outside `docs/` — browsers block local-file links from web pages.
- Missing files show a branded **"Digital copy not found"** page (never a raw
  Express error).
- The `docs/` folder is **git-ignored** — personal documents are never committed.

---

## Testing

```bash
npm test          # server must already be running
```

Runs six suites in order — takes ~30 seconds:

| Suite | Covers |
|---|---|
| `tests/check_scripts.js` | Syntax of every inline `<script>` block in the front end |
| `tests/serve.test.js` | File serving, branded 404s, path-traversal guard, API auth (13) |
| `tests/viewer.test.js` | Public viewer across all record states: public / classified / physical-only (20) |
| `tests/import.test.js` | CSV bulk import validation, skip reasons, audit rows (15) |
| `tests/disposal.test.js` | Retention dates, disposal workflow, PIN gate, guards (27) |
| `tests/backup.test.js` | Backup download → SQLite integrity → restore round-trip (7) |

Notes:

- The import/disposal suites **create test records then restore a pre-test
  backup**, so the database ends up exactly as it started.
- Restoring a backup (and the test suite itself) **signs out all logged-in
  sessions** — log in again afterwards.
- `tests/viewer.test.js` expects the sample records from `legacy_files.csv`
  (LEG-2026-042, HR-2026-001, DOC-2026-328). Re-import that file if they're gone.
- `node tests/check_scripts.js` syntax-checks every inline `<script>` block in
  `public/index.html` — it runs first in `npm test` so a broken UI script fails
  fast before any server round-trips.

---

## Project structure

```
server.js            Express app: API + public /view/:code pages + docs/ serving
public/index.html     Single-page front end (all 5 tabs, Tailwind via CDN)
file_tracker.db       SQLite database (git-ignored)
docs/                Digital copies opened by the viewer (git-ignored)
legacy_files.csv     Sample dataset for import
start-server.bat     Start with auto-restart if the server stops
snapshot-code.bat    Manual code snapshot into _snapshots/ (git-ignored)
tests/               Test suite (npm test)
```

Backups are **database-only** snapshots (Options → Download Backup). The `docs/`
files themselves are not inside the `.db` — copy that folder separately if you
need to move real documents between machines.

---

## Security notes

- JWT sessions, 7-day expiry, single active session per account (`session_version`)
- bcrypt-hashed passwords and Quick-PINs, 5-attempt rate limiting
- Parameterized SQL throughout (injection-safe), HTML-escaping of all user content
- Path-traversal guard on the `docs/` route; only `docs/` and `http(s)` links open
- Role-based access: staff cannot import, dispose, back up, or manage users
- Sensitive actions (dispose, declassify) require a second factor (Quick-PIN)

*Built as a demonstration office-records system. Run it on localhost or a trusted
network — it serves plain HTTP, so don't expose it to the public internet without
putting HTTPS in front of it.*
