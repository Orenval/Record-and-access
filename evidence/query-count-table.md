# Bookmark Query Count Evidence & Analysis

**Date:** 2026-11-03  
**Environment:** Next.js + PostgreSQL + Prisma ORM (`@prisma/adapter-pg`)  
**Test Users:**  
- **Alice:** `alice@test.bookmark`  
- **Bob:** `bob@test.bookmark`   
**Raw Terminal Log File:** [`evidence/query-count-log.txt`](file:///c:/Users/NEW%20USER/Desktop/Record%20&%20Access/evidence/query-count-log.txt)  
**Measurement Harness:** [`scripts/measure-query-counts.mjs`](file:///c:/Users/NEW%20USER/Desktop/Record%20&%20Access/scripts/measure-query-counts.mjs)

---

## 1. Query Counting Methodology

> Queries were counted on the live PostgreSQL database by attaching an event listener to Prisma Client's `query` event emitter (`db.$on("query")`), capturing every SQL statement in real time; the headline numbers report data queries (`SELECT`, `INSERT`, `UPDATE`, `DELETE`), while transaction control statements (`BEGIN`, `COMMIT`) are tracked and disclosed in parentheses and detailed classifications.

The "before" versions are deliberately redundant baselines written for measurement, retaining full user-scoping in every query so that no insecure patterns are ever executed.

*Note on Session Authentication Overhead:* Every authenticated request to `/api/bookmarks` or `/bookmarks` executes `validateSession()`, which requires **3 data queries** (`SELECT` from `Session` by token hash, `SELECT` from `User` to populate user relations, and `UPDATE` `Session.lastActivityAt` for idle timeout refresh). As this is shared authentication infrastructure common to all protected application routes, it is excluded from the bookmark domain data operation counts below and disclosed here for complete transparency.

---

## 2. Query Count Table

The "before" versions are deliberately redundant baselines written for measurement.

| Action | Before (queries) | After (queries) | What changed |
|---|:---:|:---:|---|
| **List** | 2 | 1 | Removed redundant `SELECT COUNT(*)` empty-state check; application checks the length of the single returned array instead. |
| **View Detail** *(3Q baseline)* | 3 | 1 | Consolidated separate existence check, ownership check, and data retrieval into a single user-scoped `findFirst`. |
| **View Detail** *(2Q baseline)* | 2 | 1 | Consolidated separate existence check and data retrieval into a single user-scoped `findFirst`. |
| **Delete** *(shipped, audit enforced)* | 4 *(6 total statements)* | 3 *(5 total statements)* | Eliminated redundant pre-existence lookup; scoped `findFirst` reads label directly for the audit snapshot within the transaction. |
| **Delete** *(no audit, PRD §10 target)* | 2 | 1 | Replaced lookup-then-delete with a direct user-scoped `deleteMany` (shown for comparison; not shipped because dropping audit violates security spec). |

---

## 3. Query Classification Breakdown

### 3.1 List Action

#### Before (2 Data Queries):
1. **`SELECT COUNT`** — `SELECT COUNT(*) FROM "Bookmark" WHERE "userId" = $1`:
   - *What it does:* Checks whether the user has zero or more bookmarks.
   - *Why it is not needed:* Completely redundant. The UI can inspect `bookmarks.length === 0` on the returned array without performing a separate count query.
2. **`SELECT`** — `SELECT "id", "publicId", "label", "url" FROM "Bookmark" WHERE "userId" = $1 ORDER BY "createdAt" DESC`:
   - *What it does:* Fetches the user's bookmarks sorted in descending order of creation.
   - *Why it is needed:* Primary data fetch required to render the bookmarks list.

#### After (1 Data Query):
1. **`SELECT`** — `SELECT "id", "publicId", "label", "url" FROM "Bookmark" WHERE "userId" = $1 ORDER BY "createdAt" DESC`:
   - *What it does:* Fetches all bookmarks owned by the authenticated user in a single indexed query.
   - *Why it is needed:* The returned array satisfies both the data payload and empty-state condition in one round-trip.

---

### 3.2 View Detail Action

#### Before (3 Data Queries — 3Q Baseline):
1. **`SELECT`** — `SELECT "id" FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2 LIMIT 1`:
   - *What it does:* Verifies that a record matching the identifier exists for the user.
   - *Why it is not needed:* Redundant check; covered by the final data fetch.
2. **`SELECT`** — `SELECT "id" FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2 LIMIT 1`:
   - *What it does:* Re-verifies record ownership.
   - *Why it is not needed:* Redundant check; the `userId` filter is already present on the query.
3. **`SELECT`** — `SELECT "id", "publicId", "label", "url" FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2 LIMIT 1`:
   - *What it does:* Retrieves bookmark fields (`publicId`, `label`, `url`).
   - *Why it is needed:* Primary record data required for the detail view.

#### After (1 Data Query):
1. **`SELECT`** — `SELECT "id", "publicId", "label", "url" FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2 LIMIT 1`:
   - *What it does:* Retrieves bookmark fields while enforcing tenant isolation via `publicId AND userId`.
   - *Why it is needed:* Single user-scoped query simultaneously verifies existence, enforces authorization, and fetches the necessary data. If the bookmark does not exist or belongs to another user, `null` is returned immediately without leaking information.

---

### 3.3 Delete Action (Shipped Path with Mandatory Audit)

Every statement executed in order, including `BEGIN` and `COMMIT`, with the full breakdown of how totals are reached:

#### Before (4 Data Queries + 2 Transaction Control = 6 Statements Total):
1. **`TX CONTROL`** — `BEGIN`:
   - *What it does:* Opens the database transaction boundary.
   - *Why it is needed:* Enforces atomicity so that audit logging and bookmark deletion succeed or roll back together.
2. **`SELECT`** — `SELECT "id" FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2 LIMIT 1`:
   - *What it does:* Scoped existence check prior to deletion logic.
   - *Why it is not needed:* Redundant round-trip; the subsequent label query can perform existence checking.
3. **`SELECT`** — `SELECT "id", "label" FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2 LIMIT 1`:
   - *What it does:* Reads the bookmark label to preserve in the audit trail.
   - *Why it is needed:* Required to snapshot the human-readable label before the row is deleted.
4. **`INSERT`** — `INSERT INTO "BookmarkDeletionAudit" ("id", "userId", "bookmarkPublicId", "bookmarkLabel", "deletedAt") VALUES (...)`:
   - *What it does:* Persists an immutable audit log entry recording deletion.
   - *Why it is needed:* Mandatory audit trail requirement specified in security specification Section 7.
5. **`DELETE`** — `DELETE FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2`:
   - *What it does:* Deletes the bookmark record scoped strictly to the authenticated user.
   - *Why it is needed:* Primary record deletion.
6. **`TX CONTROL`** — `COMMIT`:
   - *What it does:* Commits the database transaction.
   - *Why it is needed:* Atomically persists both the audit insert and the bookmark deletion to disk.

**How Totals Are Reached (Before):**  
- **Data Queries:** 4 (`SELECT` existence + `SELECT` label + `INSERT` audit + `DELETE` bookmark)  
- **Transaction Control:** 2 (`BEGIN` + `COMMIT`)  
- **Total Statements:** **6 statements** (4 data queries + 2 transaction control statements)

#### After (3 Data Queries + 2 Transaction Control = 5 Statements Total):
1. **`TX CONTROL`** — `BEGIN`:
   - *What it does:* Opens the database transaction boundary.
   - *Why it is needed:* Enforces atomicity so that audit logging and bookmark deletion succeed or roll back together.
2. **`SELECT`** — `SELECT "id", "label" FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2 LIMIT 1`:
   - *What it does:* Consolidated scoped lookup that validates existence, verifies user ownership, and reads the label in one step.
   - *Why it is needed:* Essential for audit payload and ownership check.
3. **`INSERT`** — `INSERT INTO "BookmarkDeletionAudit" (...) VALUES (...)`:
   - *What it does:* Records the deletion audit event.
   - *Why it is needed:* Security compliance and audit requirement.
4. **`DELETE`** — `DELETE FROM "Bookmark" WHERE "publicId" = $1 AND "userId" = $2`:
   - *What it does:* Atomically deletes the row scoped by `publicId AND userId`.
   - *Why it is needed:* Primary record deletion.
5. **`TX CONTROL`** — `COMMIT`:
   - *What it does:* Commits the transaction boundary.
   - *Why it is needed:* Atomically persists both the audit insert and the bookmark deletion to disk.

**How Totals Are Reached (After):**  
- **Data Queries:** 3 (`SELECT` label + `INSERT` audit + `DELETE` bookmark)  
- **Transaction Control:** 2 (`BEGIN` + `COMMIT`)  
- **Total Statements:** **5 statements** (3 data queries + 2 transaction control statements)

---

## 4. Single Change That Reduced the Count the Most

The single change that reduced the query count the most was consolidating existence checking, authorization verification, and data retrieval into a single scoped query for **View Detail (3 &rarr; 1, saving 2 database round-trips)**. In unoptimized architectures, developers often write separate queries to check whether a record exists (`SELECT id WHERE id = ?`), verify ownership (`SELECT userId WHERE id = ?`), and retrieve the record (`SELECT * WHERE id = ?`). Because relational SQL evaluates multiple conditions in a single `WHERE` clause (`WHERE publicId = $1 AND userId = $2`), all three questions are answered in a single query execution. Eliminating the two extraneous round-trips provides a 66.7% query reduction while eliminating race conditions between existence checks and fetches.

---

## 5. Deviation Analysis: PRD Section 10 Target vs. Real Measured Results

PRD Section 10 predicted that Delete query count would drop from **2 queries to 1 query**. In the live implementation, the measured result is **4 queries to 3 queries** (or 6 statements to 5 statements including transaction control).

### Why the Shipped Code Does Not Match 2 &rarr; 1:
- PRD Section 7 strictly mandates an immutable audit trail (`BookmarkDeletionAudit`) recorded whenever a user deletes a bookmark, capturing the user ID, public ID, and label.
- Shipped `deleteBookmark` executes inside an atomic Prisma transaction (`db.$transaction`):
  1. `BEGIN` transaction
  2. `SELECT` scoped label for audit snapshot (1 query)
  3. `INSERT` audit row (1 query)
  4. `DELETE` scoped row (1 query)
  5. `COMMIT` transaction
- Because SQL does not allow inserting into an audit table and deleting from a target table within a single standard DML query without stored procedures or triggers, an honest audit-compliant delete requires a minimum of **3 data queries**.
- As evidenced in **Delete Scenario D**, if the audit requirement is intentionally bypassed, a naive lookup-then-delete baseline executes **2 queries**, and an optimized direct `deleteMany` executes **1 query** (`2 -> 1`). However, skipping the audit write would violate security requirements. The shipped application maintains the security guarantee at 3 data queries (5 total statements).

---

## 6. Real Measurement Verification Matrix (Step 4 Results)

All data below represents actual numbers executed against the live database from [`evidence/query-count-log.txt`](file:///c:/Users/NEW%20USER/Desktop/Record%20&%20Access/evidence/query-count-log.txt).

### 6.1 N+1 Query Invariance for List
To verify that query count does not scale with row count (N+1 query problem), the list action was measured across 0, 1, and 20 bookmarks:

| Row Count | Baseline Queries | Shipped Queries | Status |
|:---:|:---:|:---:|:---:|
| **0 items** | 2 | 1 | Invariant |
| **1 item** | 2 | 1 | Invariant |
| **20 items** | 2 | 1 | Invariant |

*Result:* Query count is strictly $O(1)$ constant (exactly 1 data query for shipped code) regardless of the number of rows. There is **zero N+1 query vulnerability**.

### 6.2 Owned vs. Cross-User Detail
- **Owned Bookmark (Alice reading Alice's bookmark):**
  - Baseline (3Q): 3 data queries
  - Baseline (2Q): 2 data queries
  - Shipped: **1 data query** (Returns record)
- **Cross-User Attempt (Bob reading Alice's bookmark):**
  - Baseline (3Q): 1 data query (Immediately evaluates to `null` on Query 1; short-circuits)
  - Shipped: **1 data query** (Returns `null`; 0 information leaked)

### 6.3 Owned vs. Cross-User Delete
- **Owned Bookmark (Alice deleting Alice's bookmark):**
  - Baseline (Audit): 4 data queries + 2 tx control = 6 statements
  - Shipped (Audit): **3 data queries + 2 tx control = 5 statements** (Record deleted, audit created)
- **Cross-User Attempt (Bob deleting Alice's bookmark):**
  - Baseline (Audit): 1 data query + 2 tx control = 3 statements (Label lookup returns `null`; exits with 0 deletes, 0 audit rows)
  - Shipped (Audit): **1 data query + 2 tx control = 3 statements** (Label lookup returns `null`; exits with 0 deletes, 0 audit rows)

### 6.4 3-Run Measurement Stability
Every test scenario was executed across 3 consecutive iterations:
- List (0 items): `[1, 1, 1]` &rarr; 100% stable
- List (1 item): `[1, 1, 1]` &rarr; 100% stable
- List (20 items): `[1, 1, 1]` &rarr; 100% stable
- Detail (Owned): `[1, 1, 1]` &rarr; 100% stable
- Detail (Cross-User): `[1, 1, 1]` &rarr; 100% stable
- Delete (Owned Shipped): `[3, 3, 3]` data queries &rarr; 100% stable
- Delete (Cross-User Shipped): `[1, 1, 1]` data query &rarr; 100% stable
- Session Validation: `[3, 3, 3]` data queries &rarr; 100% stable
