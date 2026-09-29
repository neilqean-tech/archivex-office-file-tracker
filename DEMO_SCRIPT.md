# ARCHIVEX — Live Demo Script (10–15 minutes)
**Audience:** Lecturer / examiner · **Format:** live walkthrough + Q&A after
**Login state:** already logged in as `admin` before you start — never log in again during the demo.

---

## ⚠️ Read this first — 6 rules that keep the demo alive

1. **One browser only.** The app allows one active session per account. If you log
   in anywhere else mid-demo (phone, another browser), **your demo screen signs
   out instantly**. Use the same browser you logged into before presenting.
2. **Wrong PIN on purpose: ONCE only.** 5 wrong attempts = temporary lockout.
   Show one rejection, then type `1234` correctly.
3. **Do NOT run `npm test` during the demo** — it signs you out (it logs in as
   admin). Show the README or a test run from *before* the demo instead.
4. **QR codes won't open on a phone** — they encode `localhost`, which the phone
   can't reach. Use an **Incognito/Private window** as your "phone substitute".
5. **Internet must be on** — the interface loads Tailwind from a CDN.
   If the page looks unstyled: **Ctrl+Shift+R**.
6. **Restore Backup button = do not touch during the demo** (it replaces all data
   and signs everyone out). *Download* Backup is safe.

**Recovery if something goes wrong:** signed out → log in again `admin/admin123`
(10 seconds, narrate "single-session security, by design"). Server dead → run
`start-server.bat`. Lost your place → jump to **Step 5 (the unlock)** — it always impresses.

---

## Data you'll demo with (current state)

| Code | Title | Status | Notes for the demo |
|---|---|---|---|
| **HR-2026-001** | Executive Employment Agreements | Available, 🔒 Classified | Hybrid · PDF copy · the PIN-unlock star |
| **FIN-2026-088** | Annual Financial Audit Report 2025 | Available, 🔒 Classified | Physical · Cabinet A · circulation demo |
| LEG-2026-042 | Global Intellectual Property Filing | **DISPOSED** | Proof that disposal *keeps* history |
| DOC-2026-328 | "baru" | Available | Your test record — **don't point at it** |

Expected dashboard numbers: **Total 4 · Available 3 · Checked Out 0 · Overdue 0 · Classified 2**

---

## STEP 0 — 30 minutes before (prep, not part of the talk)

- [ ] Run `start-server.bat` → open `http://localhost:3000` → log in `admin / admin123`
- [ ] Internet connected (check the page is **styled**, not plain text)
- [ ] Close personal tabs + disable notifications (focus mode)
- [ ] Optional: run `npm test` now and leave the green output in a terminal window
      behind the browser — proof for Q&A. **Log in again afterwards.**
- [ ] Open one empty **Incognito window** (Ctrl+Shift+N) and leave it ready
- [ ] Refresh the app once with **Ctrl+Shift+R**
- [ ] Glance at the registry: all 4 records present, FIN & HR say *Available*

---

## STEP 1 — Opening (1 minute)

**Stay on:** Dashboard

> **SAY:** "ARCHIVEX is an office file tracking system. It solves three everyday
> problems: *Where is this document? Who currently has it? And who touched it —
> when?* It covers the full lifecycle: registration, circulation with custody
> tracking, retention and formal disposal, plus a security layer for classified
> files. Everything you'll see is live — nothing is pre-recorded."

**CLICK:** nothing yet — let them take in the screen.

**Examiner note (if they ask "what problem"):** offices lose files and can't prove
chain of custody; this system makes custody and every action provable.

---

## STEP 2 — Dashboard (1.5 minutes)

**CLICK:**
1. Point at the **KPI cards**: Total Inventory → Available → Checked Out → Overdue → Classified → 24h Velocity
2. Scroll to the **"Activity — Last 6 Months"** chart — "registered vs check-outs per month, drawn as pure SVG — it works even offline"
3. Point at **Recent Activity Pulse** feed

> **SAY:** "The dashboard answers 'is anything wrong today?' at a glance — how many
> files exist, how many are out, are any overdue, and how many are classified.
> The activity feed underneath is a live tail of the audit trail — we'll see our
> own actions appear there shortly."

**Examiner note:** KPIs are computed server-side from the same tables the audit
reads — no separate reporting database to drift out of sync.

---

## STEP 3 — Registry: search, sort, classify (3 minutes)

**CLICK (in this order):**
1. Tab **Document Registry** → point at the list (4 rows, 🔒 badges on 2)
2. **Quick find:** press **Ctrl+K** → type `HR` → **Enter**
   → "keyboard-first search; it jumps straight to the record"
3. **Sort:** click the **Status** sort button twice (A→Z ▼ → Z→A) —
   "explicit sort buttons per column; one click asc, again desc, third resets"
4. **Filter:** click the **🔒 Classified** filter chip → 2 records → click it off
5. Point at the **Retention column** — "empty means no disposal date set yet;
   overdue dates show a red 'past due' warning automatically"
6. Hover the **Digital copy link** under HR-2026-001 (shows `/docs/hep-online-document.pdf`)

> **SAY:** "Every record carries where it lives physically, its digital copy, its
> security level, and its retention date. Classifying a file isn't cosmetic — as
> you'll see, it locks data behind a PIN both here and on the public page."

**⚠ Before step 7, say this out loud:** "The link under the title opens the
**public viewer** — the page a QR code leads to. It needs no login, so I'll open
it in a private window to prove it."

**CLICK 7:** In the **Incognito window**, go to:
`http://localhost:3000/view/HR-2026-001`

---

## STEP 4 — ★ THE UNLOCK (2–3 minutes) — the wow moment

**On screen (incognito):** the viewer page shows the title, meta line
`Human Resources · HYBRID · 🔒 Classified`, and a **Quick-PIN gate** —
location and digital copy are *nowhere on the page*.

**CLICK:**
1. In **gatePin**, type `1111` → **Unlock**
   → red: *"Invalid Quick-PIN code. Access denied."*
   > **SAY:** "One wrong PIN — rejected **by the server**, not just hidden by
   > CSS. Someone can't view-source their way past it. Five wrong attempts lock
   > the endpoint temporarily."
2. Type `1234` → **Unlock**
3. Watch: **location appears** — *HR Office - Safe Lock* — plus the
   **Open Digital Document** button
4. Click **Open Digital Document** → the real HEP PDF opens in a new tab

> **SAY:** "That's the security model: public metadata (title, status), but the
> location of a classified file and its contents only release after a valid
> Quick-PIN — verified server-side. And yes, QR tags point at exactly this page."

**Examiner notes:**
- PINs are **bcrypt-hashed**; the server compares hashes, never stores plain PINs.
- The unlock endpoint shares the same **5-attempt rate limit** as the rest of the app.
- Works on any device that can reach the server — the "public kiosk/phone" story.

**Now close the incognito window** (optional keep for Q&A) and return to the app.

---

## STEP 5 — Circulation: custody with a second factor (2.5 minutes)

**CLICK:**
1. Tab **Circulation Desk**
2. Fill the form:
   - Target Document Code: `FIN-2026-088`
   - Staff Member Name: *(your name or "Officer A. Rahman")*
   - Borrowed By: `Finance Dept — Audit Committee`
   - Due Date: pick **tomorrow**
   - Purpose/Notes: `Q3 audit inspection`
3. Click **Check Out (Issue)**
4. 🔒 **PIN modal appears** — "This document is classified. Enter your Quick-PIN…"
   → type `1234` → **Confirm & Check-Out**
5. Green card: *✓ Operation Confirmed* → point at it
6. Immediately click **Check In (Return)** (same code + staff name — no PIN needed
   for returns)
7. Green card again ✓

> **SAY:** "Custody is a two-step story: who released it, who holds it, when it's
> due back. For classified files, *issuing* it demands a fresh Quick-PIN — so a
> borrowed badge can't quietly walk a classified file out the door. Returns don't
> need the PIN; only releases do."

**Examiner note:** status flips AVAILABLE → CHECKED_OUT → AVAILABLE, and the
dashboard's Available/Checked-Out KPIs move with it — same transaction, not a copy.

---

## STEP 6 — Audit trail: everything you just did, written down (2 minutes)

**CLICK:**
1. Tab **Audit Trail**
2. Point at the **top rows** — they're the actions from Steps 3–5, just now
3. **Date filter:** set **From = Today** → list narrows → click **✕** to clear
4. Click the **Staff** sort button once — "same explicit-sort pattern as the registry"
5. Point at the **CSV export** button — "exports exactly what the filter shows"

> **SAY:** "The audit trail is append-only — rows are written, never edited or
> removed through the app. Here's the classified release we just authorized,
> logged with the confirming user. And on the disposal question…"

**CLICK (optional, 20s):** scroll/scan for the **DISPOSE** row of LEG-2026-042:

> **SAY:** "When a record's retention expired, disposal didn't delete it — the
> row stays, status reads DISPOSED, and its full history remains. That's a
> records-management requirement: you destroy the *file*, never the *evidence*."

**Examiner note:** every log row keeps a denormalized file code, so history
survives even record deletion.

---

## STEP 7 — Roles & backup (1 minute)

**CLICK:** Tab **Options** → point (don't click Restore):

1. **Download Backup (.db)** — "one click, consistent snapshot of the whole database"
2. **Change Password** / **Manage Staff** — "admins reset anyone's password or PIN"
3. Mention: **CSV Import/Export** in the Registry for bulk onboarding

> **SAY:** "Two roles: admin and records officer. Staff can't import, dispose,
> back up, or manage users — those routes return 403 server-side. Backups are
> deliberate admin actions, and restoring one signs everyone out for safety."

---

## STEP 8 — Close (1 minute)

> **SAY:** "Quick summary: full lifecycle — register, circulate, retain, dispose;
> classified data behind server-side PIN verification; an append-only audit trail
> behind every action; role-based access; one-click backups. It's covered by an
> automated test suite — six suites, 82 checks, all green — and documented in the
> README. That's the walkthrough — happy to take questions."

**For Q&A proof, show (if you pre-ran it):** the terminal with
`ALL SUITES PASSED`, or the `tests/` folder + README in the project.

---

## Cut list — if you're running long, drop in this order

| Drop | Saves | Why it's safe to drop |
|---|---|---|
| Ctrl+K quick find demo | ~40s | Nice-to-have, not core |
| CSV/backup section (Step 7) | ~60s | Can survive as a spoken one-liner |
| LEG disposal story in audit | ~30s | Mention it only verbally |
| Register-a-record live | ~90s | Not in the core flow anyway |

**Never cut:** the PIN unlock (Step 4), the circulation PIN (Step 5), audit proof (Step 6).

---

## After the demo — 30-second cleanup

1. Confirm **FIN-2026-088 is Available** (Circulation tab or registry status) —
   the script checks it back in, but verify.
2. Registry still shows **4 records**.
3. If you registered a throwaway record during Q&A: row menu →
   🗑 *Delete Document* (non-classified = one confirm).
4. Don't run tests while you still need the session.
