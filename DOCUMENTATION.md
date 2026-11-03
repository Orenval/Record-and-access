# Documentation

This file is the project handoff. This entry covers **Section 5 — the Records
and Access slice**, matching `docs/Records_Access_PRD.md` Section 14. It records
what was built, how it is protected, what it costs, and where the limits are,
with the evidence gathered while building and testing it.

## 5. Records and Access Slice

A signed-in user can create, list, view, and delete their own bookmarks
(`label` + `url`). There is no sharing, no public access, and no cross-user
visibility of any kind.

### 5.1 The four questions

**Q1 — What was built, and why this shape?**
A bookmark slice on top of the existing authentication system: two tables
(`Bookmark`, `BookmarkDeletionAudit`), one data-access module
(`src/lib/bookmarks.ts`), two API routes (`/api/bookmarks`,
`/api/bookmarks/[publicId]`), and two real pages (`/bookmarks`,
`/bookmarks/[publicId]`). Ownership is carried by `userId` taken only from the
validated session; every query that touches a bookmark row includes that
`userId` in its own `WHERE` clause.

**Q2 — How is it protected?**
Session-derived identity, a single scoped data-access module, explicit column
allowlists, uniform 404s for ownership misses, session-bound CSRF on mutations,
server-side Zod validation (including an `http`/`https` allowlist and rejection
of embedded credentials), and an audit row written inside the same transaction
that performs the delete.

**Q3 — What does it cost?**
Two indexes on `Bookmark` plus its unique `publicId` index, one index on
`BookmarkDeletionAudit`, and at most one bookmark query per action except
delete, which needs three statements to keep the audit guarantee. Measured
before/after: list 2 -> 1, detail 3 -> 1, delete with audit 4 -> 3 (2 -> 1
without audit). `validateSession()` adds two auth queries per HTTP request and
is deliberately excluded from those numbers and disclosed with them.

**Q4 — What are the limits?**
This is a slice, not an authorization framework. There is no sharing model, no
pagination, no update operation, and the audit trail covers deletions only. The
audit table is not tamper-evident, and a compromised application process could
still write false audit rows. Reasonable next steps are server-side pagination,
a shared end-to-end test suite, and rate limiting on creation.

---

### 5.2 Authentication versus authorization

**What/why.** Authentication answers "who is making this request" and is handled
by the existing session cookie plus `validateSession()`. Authorization answers
"may this identity touch this row" and is handled by `userId` scoping in
`src/lib/bookmarks.ts`. They are separate steps with separate failure codes:
no identity is `401`, an identity without access to the row is `404`.

**Security.** `userId` is read only from `sessionData.session.userId`. It is
never read from the request body, query string, or URL. A create request that
supplies `userId`, `publicId`, or `id` in its JSON body is parsed by the Zod
schema, which strips unknown keys; the live test proved the forged identifiers
were ignored and the row was owned by the signed-in user.

**Cost.** One session lookup pair per request (session SELECT plus
`lastActivityAt` update), already part of the auth system, plus the bookmark
query itself. No extra authorization round trip.

**Tradeoff.** Keeping authorization inside the data-access module means routes
stay thin, but it also means any future bookmark read/write must go through that
module. That is intentional: there is exactly one place to audit.

---

### 5.3 Scoping the query versus checking after the fetch

**What/why.** The insecure pattern is: fetch a row by identifier, then compare
its owner in application code. The pattern here is: put the owner in the same
`WHERE` clause that fetches the row, so a row owned by someone else is never
returned at all. Every function in `src/lib/bookmarks.ts` takes `userId` as a
required first argument.

**Security.** This removes the fetch-then-compare class of bug entirely. There
is no branch in which an unauthorized row is loaded into memory and then
filtered; there is no temporary state in which the check can be skipped, and no
time-of-check/time-of-use gap between reading ownership and acting on it. The
delete path uses a scoped `deleteMany`, not `delete`, so the ownership
condition is part of the deletion statement itself.

**Cost.** One query per action instead of two or three. The ownership condition
uses the `(userId, createdAt)` index for lists and the unique `publicId` index
for single-row lookups.

**Tradeoff.** Scoped queries make "row exists but is not yours" and "row does
not exist" indistinguishable at the data layer. That is the desired behavior,
but it means the application cannot produce a distinct `403` for another user's
row even if a product requirement later asks for one.

---

### 5.4 Insecure direct object references (IDOR)

**What/why.** The detail and delete routes accept a client-controlled
identifier in the URL (`/bookmarks/[publicId]`). IDOR is the failure mode where
changing that identifier reaches another user's record. Here, the identifier is
always combined with the session's `userId` before any row is read or deleted.

**Security.** The full attack table is in 5.11. Every route was attacked as Bob
against Alice's real bookmark, both through the UI URL and by calling the API
directly with `curl`, including replaying Bob's session with Alice's identifier.
Every attempt returned `404`, no row was deleted, and the missing-row response
was byte-identical to the other-user response. The raw internal database `id`
was also rejected (`404`) when used where a `publicId` belongs.

**Cost.** No additional query. The identifier and the owner travel in the same
`WHERE` clause.

**Tradeoff.** A uniform `404` makes support and debugging slightly harder
because logs cannot distinguish "missing" from "not yours" without joining the
audit or ownership data. That ambiguity is the security property, not a bug.

---

### 5.5 Why raw database identifiers are not exposed

**What/why.** `Bookmark.id` is an internal `cuid` used for joins and referential
integrity. Clients only ever see `publicId`, a 12-character `nanoid` with a
unique index. Every read uses an explicit `select` allowlist
(`publicId`, `label`, `url`), so the internal `id` and the owning `userId`
cannot leak through an accidental `select *` or a serialized model.

**Security.** Hiding the internal identifier removes a stable, enumerable handle
and keeps the public surface independent of the primary key. The detail page
test confirmed the internal id does not appear in the rendered HTML while the
`publicId` does. Crucially, `publicId` is **not** a secret and is not treated as
one: the authorization decision is still `publicId + userId`, so leaking a
`publicId` does not grant access.

**Cost.** One extra unique index and a generated value per row. No extra query.

**Tradeoff.** `publicId` adds a second identifier to reason about, and any future
join that needs the internal id must happen server-side. That is a small price
for not shipping primary keys to the browser.

---

### 5.6 Audit logging

**What/why.** Deleting a bookmark writes a `BookmarkDeletionAudit` row capturing
`userId`, `bookmarkPublicId`, a snapshot of `bookmarkLabel`, and `deletedAt`.
The row is written **before** the delete, inside the same interactive
transaction, so the audit trail cannot silently miss a successful deletion.

**Security.** If the audit insert fails, the transaction rolls back and the
bookmark is not deleted. If a concurrent delete removes the row between the
scoped lookup and the scoped `deleteMany`, the zero-row result throws
`BookmarkDisappearedError`, which rolls the transaction back so no orphan audit
row is left, and the API returns `404`. The live test produced exactly one audit
row for Alice's successful deletion, matching her `userId`, the deleted
`publicId`, and the label snapshot. Both failure paths are exercised directly
by `scripts/test-bookmark-delete-rollback.mjs`: an injected audit-insert failure
leaves the bookmark in place with no audit row, and a delete that loses a race
returns `null` with no orphan audit row.

**Cost.** One `INSERT` and one transaction on delete: the shipped delete is
three bookmark-work statements (scoped lookup, audit insert, scoped delete)
instead of two. This is the reason the delete target in PRD Section 10 (2 -> 1)
is not reachable without dropping the audit requirement; see 5.10.

**Tradeoff.** The audit is deletion-only and is not cryptographically chained,
so it is an operational record, not tamper-evident proof. Extending it to reads
or updates would multiply write volume and was outside this slice.

---

### 5.7 Page architecture and URL state

**What/why.** The list lives at `/bookmarks` and each bookmark has its own real
URL at `/bookmarks/[publicId]`. Both are server components that render on the
server and use normal links, so a detail view can be reloaded, bookmarked, or
shared and still lands on the right record (or a `404` if the viewer is not the
owner). There is no modal-only or client-state-only view.

**Security.** Both pages call `validateSession()` and `redirect("/signin")`
before any data access, so an unauthenticated request never renders bookmark
content. The detail page calls `notFound()` when the scoped lookup returns
nothing, which renders the standard 404 page. Because the page and the API share
`getBookmark`, the page cannot drift into a different ownership rule.

**Cost.** One page render and one scoped query per view. The `publicId` in the
URL is the same value the API uses, so no extra translation step is needed.

**Tradeoff.** Server-rendered navigation is a full document request rather than
a client-side transition. For a list/detail slice this is simpler and keeps the
URL authoritative; a heavier app might add prefetching or a client cache later.

---

### 5.8 Status codes (401 versus 403, and 404 for ownership misses)

Check order is uniform across the bookmark API:
**401 (no session) -> 403 (CSRF failure) -> 400 (validation) -> data access
(404 or success).**

| Status | When it is returned | Body | Why not the alternative |
|---|---|---|---|
| 401 | No valid session, on any bookmark page or API route | `{"success":false,"message":"Not authenticated"}` | Authentication failure is a distinct condition. Returning 404 would hide a fixable client problem without gaining any secrecy. |
| 403 | Valid session, mutating request (POST/DELETE), missing or wrong CSRF token | `{"success":false,"message":"Invalid CSRF token"}` | This is not an ownership answer. It is a request-integrity refusal and is decided before any row lookup, so it reveals nothing about the identifier. |
| 404 | The scoped query returned no row: the bookmark is missing **or** belongs to another user | `{"success":false,"message":"Bookmark not found"}`, byte-identical in both cases | A 403 here would confirm that the identifier exists but is not yours, which is an enumeration oracle. A uniform 404 denies that signal. |
| 400 | Malformed JSON, or a label/URL that fails validation | `{"success":false,"message":"Invalid request body"}` or `{"success":false,"message":"Validation failed","errors":{...}}` | Validation is a client error, not an authorization decision; it is checked only after identity and CSRF. |
| 201 / 200 | Create succeeded / list, detail, or delete succeeded | `{success, message, data}` (create and list) or `{success, message}` (delete) | Normal success paths. |
| 307 | Unauthenticated request to `/bookmarks` or `/bookmarks/[publicId]` | Redirect to `/signin` | Pages redirect; APIs return 401. The distinction keeps browser behavior usable without weakening the API contract. |

The live tests confirm the ordering: a no-session `DELETE` with no CSRF token
returns `401`, not `403`; Bob's `DELETE` with a valid session and no CSRF token
returns `403`, not `404`; Bob's `DELETE` with a valid CSRF token returns `404`.
An Alice-session request carrying Bob's CSRF token also returns `403`, which
shows the token is validated against the session rather than merely present.

---

### 5.9 Database indexing

All indexes below were verified against the live database with
`prisma migrate diff` and `pg_indexes`.

| Index | Purpose |
|---|---|
| `Bookmark_publicId_key` (unique) | Detail and delete lookups by `publicId`; also enforces uniqueness of the public identifier. |
| `Bookmark_userId_idx` | Every list, lookup, and delete filters by the session's `userId` first. |
| `Bookmark_userId_createdAt_idx` | The list is `WHERE userId = ? ORDER BY createdAt DESC`; this index serves the filter and the sort. |
| `BookmarkDeletionAudit_userId_idx` | Supports per-user audit history queries and cascade behavior. |
| `Bookmark.userId -> User.id` (cascade) | Deleting a user removes their bookmarks. |
| `BookmarkDeletionAudit.userId -> User.id` (cascade) | Deleting a user removes their audit rows. |

**What/why.** The composite index matches the exact shape of the list query, so
the database can satisfy both the filter and the ordering without a separate
sort step. The unique index makes the public identifier both fast and
collision-free.

**Cost.** Write amplification on insert/update and storage for four indexes.
For a bookmark-sized workload this is negligible.

**Tradeoff.** There is no index for searching inside labels or URLs; this slice
does not offer search. Adding one later should be driven by a real query shape,
not added speculatively.

---

### 5.10 Query count as a cost (before and after)

Measured with Prisma query events on a client constructed with query logging
(`scripts/measure-bookmark-queries.mjs`, measurement-only and never imported by
the application). Transaction control statements (`BEGIN`/`COMMIT`) are shown
separately and excluded. The "before" functions are deliberately redundant but
still include `userId` in every `WHERE` clause, so the harness never exercises a
fetch-then-compare path.

| Action | Before | After | What changed |
|---|---|---|---|
| List | 2 | 1 | Removed a separate `COUNT` used only for the empty state; the page checks the length of the single result set instead. |
| View detail | 3 | 1 | Existence, ownership, and the row data are answered by one scoped `findFirst`; the two extra lookups are gone. |
| Delete (audit included, shipped) | 4 | 3 | Removed a redundant second ownership lookup; the remaining statements are one scoped label lookup, the audit insert, and one scoped `deleteMany`. |
| Delete (no audit, PRD Section 10 target) | 2 | 1 | A single scoped `deleteMany` replaces lookup-then-delete. Shown for completeness; this variant is **not** shipped because it would drop the audit guarantee. |

Per-query classification (shipped path):

- List: 1 x scoped `Bookmark` SELECT (`userId` filter, `createdAt` order).
- Detail: 1 x scoped `Bookmark` SELECT (`publicId` + `userId`).
- Delete: 1 x scoped `Bookmark` SELECT (label only) -> 1 x `BookmarkDeletionAudit` INSERT (label snapshot) -> 1 x scoped `Bookmark` DELETE (`publicId` + `userId`), plus one transaction-control statement.

**The single change that reduced the most queries** was combining existence,
ownership, and fetch for the detail view: 3 -> 1, removing two round trips. It
wins because all three questions are answered by the same `WHERE` clause, so the
extra queries were pure redundancy rather than necessary stages.

**Deviation from PRD Section 10.** The PRD's delete row says 2 -> 1, but the
PRD also requires an audit row written before deletion (Section 7). Keeping that
guarantee makes the floor three statements, not one. The shipped implementation
therefore records 4 -> 3 and does not weaken the audit or scoping requirement to
match a number. The 2 -> 1 figure is evidenced by the explicitly labeled
no-audit variant above.

**Excluded from these counts:** `validateSession()` costs two queries per HTTP
request (session SELECT plus `lastActivityAt` update). That is authentication
overhead shared by every route, not bookmark work, and it is disclosed here so
the numbers are not mistaken for total request cost.

**Verification:** `scripts/test-bookmark-delete-rollback.mjs` passes 3/3
(audit-failure rollback, concurrent-delete rollback, normal path). The final
production build (`npm run build` -> `npm run start`) serves the same routes and
passes the same access-control harness as `next dev`.

---

### 5.11 Attack audit table

Two real accounts are used (`alice@test.bookmark`, `bob@test.bookmark`). Alice
creates a bookmark first; every attempt below is made against that real row
unless stated otherwise. `scripts/verify-bookmark-security.mjs` reproduces the
table and passes 26/26 assertions against both `next dev` and the production
`next start` build (the 24 attack checks below, one audit-row assertion, and one
session-setup check). The database is restored to baseline after every run
(`User=2, Session=0, RateLimitAttempt=0, Bookmark=0,
BookmarkDeletionAudit=0`).

| # | Method | Path | Attempted | Result | Pass |
|---|---|---|---|---|---|
| 1 | GET | `/bookmarks` (page) | Open the list with no session | `307` to `/signin` | Pass |
| 2 | GET | `/bookmarks` (page) | List while signed in as Bob, with Alice's row present | `200`; Alice's label and `publicId` absent | Pass |
| 3 | GET | `/bookmarks/[alice-publicId]` (page) | Edit the URL to Alice's identifier while signed in as Bob | `404`; no label or URL leaked | Pass |
| 4 | GET | `/bookmarks/[alice-publicId]` (page) | Open Alice's detail URL with no session | `307` to `/signin` | Pass |
| 5 | GET | `/bookmarks/[internal-id]` (page) | Use the raw database `id` where a `publicId` belongs, as the owner | `404` | Pass |
| 6 | GET | `/api/bookmarks` | Call the list API with no session | `401` `Not authenticated` | Pass |
| 7 | GET | `/api/bookmarks` | Call the list API as Bob | `200`, zero rows, no Alice data | Pass |
| 8 | GET | `/api/bookmarks/[alice-publicId]` | Replay Bob's session against Alice's identifier | `404` `Bookmark not found` | Pass |
| 9 | GET | `/api/bookmarks/[missing]` | Request a nonexistent identifier as Alice | `404`, byte-identical to row 8 | Pass |
| 10 | GET | `/api/bookmarks/[internal-id]` | Use the raw database `id` on the API as the owner | `404` | Pass |
| 11 | POST | `/api/bookmarks` | Create with no session | `401` `Not authenticated` | Pass |
| 12 | POST | `/api/bookmarks` | Create as Bob without a CSRF token | `403` `Invalid CSRF token` | Pass |
| 13 | POST | `/api/bookmarks` | Create as Bob with forged `userId` (Alice's), `publicId`, and `id` in the body | `201`; row owned by Bob, supplied `publicId` ignored, supplied `id` ignored, generated `publicId` returned | Pass |
| 14 | POST | `/api/bookmarks` | Create a normal bookmark as Alice | `201`; response keys exactly `label`, `publicId`, `url` | Pass |
| 15 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete Alice's row as Bob with Bob's valid CSRF token | `404`; Alice's row still present afterward | Pass |
| 16 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete as Bob without a CSRF token | `403` `Invalid CSRF token` | Pass |
| 17 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete as Alice while sending Bob's CSRF token | `403` `Invalid CSRF token`; token is session-bound | Pass |
| 18 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete with no session and no CSRF token | `401` (session is checked before CSRF) | Pass |
| 19 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete Alice's own row with her valid CSRF token | `200`; exactly one audit row written | Pass |
| 20 | DELETE | `/api/bookmarks/[alice-publicId]` | Repeat the same delete | `404`; no second audit row | Pass |
| 21 | GET | `/api/bookmarks` | List as Alice after Bob's create | `200`; Alice's row present, Bob's absent | Pass |
| 22 | GET | `/api/bookmarks` | List as Bob after Bob's create | `200`; Bob's row present, Alice's absent | Pass |
| 23 | GET | `/api/bookmarks/[alice-publicId]` | Confirm Alice's row survived every Bob attempt | `200` before her own delete | Pass |
| 24 | GET | `/api/bookmarks/[deleted]` | Fetch the row after Alice's own delete | `404` | Pass |

Supporting checks: the API `404` body for "another user's row" and "missing row"
compared byte-identical; the internal `Bookmark.id` did not appear in the
rendered detail HTML; the `publicId` did; forged identifiers produced zero rows
in the database.

---

### 5.12 Evidence checklist

Every item is reproducible, and the database is returned to baseline after each
run (`User=2, Session=0, RateLimitAttempt=0, Bookmark=0,
BookmarkDeletionAudit=0`).

**Access-control table & attack log** - Detailed in Section 5.11, persisted in [`evidence/attack-table.md`](./evidence/attack-table.md) and [`evidence/access-control-evidence.md`](./evidence/access-control-evidence.md), with raw sequential execution output in [`evidence/attack-log.txt`](./evidence/attack-log.txt). Reproduce against a live server with:

```bash
npm run dev
node scripts/run-attacks.mjs
# or full test harness:
node scripts/verify-bookmark-security.mjs
```

26/26 assertions pass against both `next dev` and the production build
(`npm run build`, then `npm run start`).

**Query count table & measurement log** - Detailed in Section 5.10, persisted in [`evidence/query-count-table.md`](./evidence/query-count-table.md) with raw measurement logs in [`evidence/query-count-log.txt`](./evidence/query-count-log.txt). Reproduce on the live database with:

```bash
node scripts/measure-query-counts.mjs
# or legacy harness:
node scripts/measure-bookmark-queries.mjs
```

**Delete rollback paths** - reproduce with:

```bash
node scripts/test-bookmark-delete-rollback.mjs
```

3/3 pass: an audit-insert failure rolls back the whole transaction (bookmark
still present, audit empty), a concurrent delete returns `null` with no orphan
audit row, and the normal path writes exactly one audit row.

**Visual Evidence Screenshots** - Primary visual verification artifacts are organized in `evidence/` alongside headless browser captures in `docs/evidence/`:

- **Evidence 3a to 3c (`evidence/Evidence 3a.png`, `evidence/Evidence 3b.png`, `evidence/Evidence 3c.png`):** Evidence shots showing **audit-log-after-deletion**. Captures the deletion UI flow and verifies that an immutable audit row is written to `BookmarkDeletionAudit` with the user ID, public ID, label snapshot, and deletion timestamp.
- **Evidence 4a (`evidence/Evidence 4a.png`):** Evidence shot showing **detail URL publicID**. Proves browser navigation to `/bookmarks/[publicId]` uses the non-sequential, random 12-character `publicId` (nanoid).
- **Evidence 4b (`evidence/Evidence 4b.png`):** Evidence shot showing **bookmark Id vs public ID**. Contrasts internal database cuid (`Bookmark.id`) with public identifier (`Bookmark.publicId`), proving internal primary keys are never exposed to clients.
- **Automated headless Chrome captures:** `scripts/capture-bookmark-evidence.mjs` generates `docs/evidence/detail-url.png` (detail page navigation with live URL banner) and `docs/evidence/audit-row.png` (database audit row after browser-driven deletion).

Each run generates fresh identifiers and deletes its rows and session
afterward. The screenshots prove the behavior, not the specific `publicId`
strings in them; the harness output and the SQL below show values from a live
run.

Values captured from the Phase 8 run, before cleanup:

```
audit.id               = cmvjk4db000099ctz8allzgb0
audit.userId           = cmvi771tc0000kktzhaqk7m2s  (alice@test.bookmark)
audit.bookmarkPublicId = NveOfuwXbvOy                (the deleted bookmark)
audit.bookmarkLabel    = "Phase8 Alice Secret"
audit.deletedAt        = 2026-10-22T12:08:36.060Z

detail URL             = http://localhost:3100/bookmarks/NveOfuwXbvOy
publicId               = NveOfuwXbvOy
internal Bookmark.id   = cmvjk46u100079ctz97e1x0h4
internal id in HTML    = false
publicId in HTML       = true
```

---

### 5.13 Notable decisions and the one documented deviation

- The two bookmark migrations were added as new, forward-only migrations
  (`add_bookmarks`, `reconcile_auth_schema`) rather than rewriting the existing
  init migration. The init migration stays untouched.
- `Bookmark.userId` is always taken from the session. The Zod schema strips
  unknown keys, so body-supplied ownership fields are ignored.
- The delete transaction audits before deleting and rolls back if the audit or
  the delete cannot complete. A concurrent disappearance returns `404` without
  leaving an orphan audit row.
- **Deviation:** PRD Section 10's delete target of 2 -> 1 is not reachable while
  keeping the Section 7 audit guarantee. The shipped path is 4 -> 3, and the
  2 -> 1 figure is shown as an explicitly labeled no-audit variant. The audit
  and scoping guarantees were not weakened to match the target.
- Query-count baselines use redundant but still fully scoped queries, so the
  measurement harness never demonstrates an insecure pattern.
- `npm run lint`, `build`, `dev`, and `start` call the local binaries through
  `node` directly, which keeps them working when the project path contains
  `&`. The ESLint config exempts CommonJS utility scripts from
  `no-require-imports`. The two pre-existing warnings in
  `src/lib/validation.ts` are in the protected auth slice and were left
  untouched.

---

## 6. Route Simplification, Rebranding, and Environment Resilience

Following the completion of the Records and Access slice, the application was refined to eliminate leftover artifact routes from the ported authentication template, establish direct navigation to the primary slice (`/bookmarks`), rebrand user-facing visual identity and accessibility tokens, and resolve Windows path handling for local tooling.

### 6.1 Route simplification and `/dashboard` deprecation

- **Direct landing on `/bookmarks`:** Post-sign-in navigation (`src/app/(auth)/signin/page.tsx`) and already-authenticated route guards (`src/app/(auth)/layout.tsx`) were updated to direct authenticated users immediately to `/bookmarks` instead of the legacy `/dashboard`.
- **`/dashboard` redirect:** The `/dashboard` route (`src/app/dashboard/page.tsx`) was repurposed into a server-side redirect to `/bookmarks` using Next.js `redirect("/bookmarks")`. This preserves compatibility with existing bookmarks and URL history while removing the redundant screen. The temporary button component was removed.
- **Header greeting:** At the top of `/bookmarks` (`src/app/bookmarks/page.tsx`), the previous "Back to dashboard" button was removed and replaced with a clean user greeting heading: `Welcome back, {user's name}`. No extraneous counters, statistics, or panels were introduced.
- **Route protection in proxy:** `src/proxy.ts` was updated so `PROTECTED_ROUTES = ["/bookmarks", "/dashboard"]`. Unauthenticated visits to `/bookmarks` and `/dashboard` are intercepted at the edge/middleware layer with a `307` redirect to `/signin`.

### 6.2 Visual identity and rebranding

- **Application metadata:** Page title updated from `"Auth Assessment"` to `"Bookmarks"`, and description set to `"A private, secure bookmarks application."` in `src/app/layout.tsx`. Manifest metadata in `package.json` (`"name": "bookmarks"`) and `README.md` (`# Bookmarks`) were brought into parity.
- **Logo component:** An inline SVG component (`src/components/logo.tsx`) was created, rendering a clean line sketch of an open book with a hanging ribbon bookmark (`fill="none"`, `stroke="currentColor"`). It is rendered beside the `"Bookmarks"` wordmark in the application header (`DashboardHeader`) and on the sign-in card.
- **Favicon modernization:** Added `src/app/icon.svg` using the Next.js App Router icon convention (`width="32"`, `height="32"`, stroke-width `2.2` in brand amber `#F49F04` with a transparent background). The legacy default `src/app/favicon.ico` was removed, allowing browsers to render the scalable SVG icon directly.

### 6.3 Color system and accessible contrast

- **Primary amber palette:** The application primary color was updated to amber `#F49F04` in `:root` inside `src/app/globals.css`.
- **WCAG contrast compliance:**
  - *Amber button backgrounds:* White text on `#F49F04` provides poor contrast (~1.8:1). A dedicated `--color-primary-text: #1f2937` token was introduced and applied to `.btn-primary` alongside `font-weight: 600`, achieving high-contrast dark text (>8:1 contrast ratio, AAA compliance).
  - *Text on white/light backgrounds:* Pure amber text on `#ffffff` fails WCAG AA legibility. A dedicated darker token `--color-primary-dark: #9A5B02` (hover: `--color-primary-dark-hover: #7C4801`) was added and mapped to `.dashboard-header__brand`, `.auth-brand`, `.btn-link`, and `.detailUrl`, achieving a 4.7:1 contrast ratio against `#ffffff`.

### 6.4 Windows CLI path resilience (`fix-cmd-shims`)

- **Root cause:** Running in paths with ampersands (e.g. `Record & Access`) causes Windows `cmd.exe` to interpret `&` in npm's default `.bin/*.cmd` shims (`SET dp0=%~dp0`) as a command separator, truncating `%dp0%` and breaking CLI tools like `npx prisma studio`.
- **Automated resolution:** Added `scripts/fix-cmd-shims.js`, wired into `"postinstall": "node scripts/fix-cmd-shims.js"` in `package.json`, which automatically wraps the `dp0` assignment in quotes (`SET "dp0=%~dp0"`) across all `.cmd` files in `node_modules/.bin`.
- Added shortcut script `"db:studio": "prisma studio"` to `package.json`.

---

## 7. Evidence Pack & Live Verification Artifacts

The application repository contains an audited evidence pack under [`evidence/`](./evidence/) capturing live security enforcement, query count optimization, and visual UI/database verification.

### 7.1 Access Control Attack Evidence (`evidence/attack-table.md`, `evidence/attack-log.txt`)

A complete 13-row access control attack suite was executed against the live application (`http://localhost:3000`) using real test accounts (`alice@test.bookmark` and `bob@test.bookmark`). All raw terminal outputs are recorded sequentially in [`evidence/attack-log.txt`](./evidence/attack-log.txt), and summarized in [`evidence/attack-table.md`](./evidence/attack-table.md) and [`evidence/access-control-evidence.md`](./evidence/access-control-evidence.md).

Key security contracts proven by the attack log:
1. **Authentication Enforcement (401 Unauthorized):** Requests to `/api/bookmarks` or `/api/bookmarks/[publicId]` without a valid session cookie return `401 Unauthorized`. Unauthenticated visits to page routes (`/bookmarks`, `/bookmarks/[publicId]`) return a `307` redirect to `/signin`.
2. **CSRF Protection on Mutating Endpoints (403 Forbidden):** Mutating endpoints (`POST`, `DELETE`) require a double-submit CSRF token matching the session. Requests with missing or forged tokens are refused with `403 Forbidden` prior to data lookup.
3. **Anti-Enumeration Uniform 404s:** When Bob attempts to fetch Alice's bookmark (`GET /api/bookmarks/4QNxK5vfsj4K`) vs. a non-existent ID (`GET /api/bookmarks/nonexistent99`), both return `404 Not Found` with byte-identical 50-byte response bodies (`{"success":false,"message":"Bookmark not found"}`), denying attackers an ID-enumeration oracle.
4. **Server-Side Ownership Enforcement (Row 11):** When Bob posts a bookmark with a forged `"userId"` set to Alice's ID (`cmvi771tc0000kktzhaqk7m2s`), Zod schema validation strips the field, and the server binds ownership strictly to Bob's session ID (`cmvi772dd0000nwtzavrrd76g`), proven by direct database query.
5. **Data Survival on Unauthorized Delete:** After unauthorized delete attempts by Bob (with or without CSRF token), Alice's bookmark was verified to survive intact.

### 7.2 Query Count Evidence & Optimization (`evidence/query-count-table.md`, `evidence/query-count-log.txt`)

Query counts were measured against live PostgreSQL using Prisma's event emitter (`db.$on("query")`) in [`scripts/measure-query-counts.mjs`](./scripts/measure-query-counts.mjs) across 3-run repetitions, documented in [`evidence/query-count-table.md`](./evidence/query-count-table.md) with raw output in [`evidence/query-count-log.txt`](./evidence/query-count-log.txt).

Key findings:
- **List ($2 \to 1$):** Removed redundant `COUNT(*)` query for empty checks; empty state is determined by array length. Measured across 0 rows, 1 row, and 20 rows, the query count is strictly constant ($O(1)$ scaling), proving **zero N+1 query vulnerability**.
- **View Detail ($3 \to 1$):** Consolidated redundant existence check, ownership check, and data retrieval into a single user-scoped `findFirst`, representing the single largest reduction (66.7% drop, saving 2 round-trips).
- **Delete ($4 \to 3$ data queries, $6 \to 5$ total statements including `BEGIN` and `COMMIT`):** Consolidated pre-existence lookup with label lookup inside an atomic transaction. Preserves the mandatory `BookmarkDeletionAudit` insert before deletion. Explains why the PRD Section 10 hypothetical target ($2 \to 1$) applies only if audit logging is omitted.
- **Session Validation Overhead:** Evaluated separately at **3 data queries** in Prisma Client (`Session` lookup, `User` relation lookup, `Session.lastActivityAt` update), disclosed alongside domain metrics as shared authentication infrastructure.

### 7.3 Visual Evidence Screenshots

Visual proof of key security, audit, and data isolation requirements is captured in `evidence/`:

| Evidence File | Artifact Category | Description & Verification Proof |
|---|---|---|
| [`evidence/Evidence 3a.png`](./evidence/Evidence%203a.png)<br>[`evidence/Evidence 3b.png`](./evidence/Evidence%203b.png)<br>[`evidence/Evidence 3c.png`](./evidence/Evidence%203c.png) | **Audit log after deletion** | Demonstrates the complete bookmark deletion sequence and database verification. Proves that deleting a bookmark writes an immutable audit entry to `BookmarkDeletionAudit` capturing `userId`, `bookmarkPublicId`, `bookmarkLabel`, and `deletedAt`. |
| [`evidence/Evidence 4a.png`](./evidence/Evidence%204a.png) | **Detail URL publicID** | Demonstrates detail page navigation (`/bookmarks/[publicId]`). Shows the browser address bar and URL structure containing the unguessable 12-character random nanoid (`publicId`), with no internal IDs exposed. |
| [`evidence/Evidence 4b.png`](./evidence/Evidence%204b.png) | **Bookmark Id vs. Public ID** | Demonstrates internal identity isolation. Directly contrasts the internal database primary key (`Bookmark.id`, cuid) against the client-facing public identifier (`Bookmark.publicId`), confirming internal IDs are never exposed in the URL, HTML responses, or API payloads. |

