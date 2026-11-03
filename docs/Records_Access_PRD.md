# Records and Access Slice — PRD

## 1. Overview

A flow where a signed-in user can create, view, and delete their own
records, built so that no user can ever reach another user's data,
under any circumstance, through any route. The record type chosen for
this slice is a **Bookmark** (a URL and a label), since the brief
states the domain itself does not matter, and a single real field
keeps the UI as thin as possible so the actual engineering work, query
scoping, audit logging, status codes, and query counts, stays the
focus rather than the record type itself.

This is a standalone repository, separate from the other three
assessments. Authentication is reused from the same minimal port used
elsewhere: sign in and session checking only, no sign up, no email
verification, no password reset. Two test users must exist to produce
the required attack evidence (see Section 9), so the existing
`scripts/create-user.js` pattern is reused to create both.

## 2. Screens

- **List view** (`/bookmarks`): every bookmark belonging to the
  signed-in user, newest first, shown as its label and its URL. A
  genuine empty state when the user has zero bookmarks, no placeholder
  or fake entries.
- **Create** (a form, inline or its own route): a URL field and a
  label field only.
- **Detail view** (`/bookmarks/[publicId]`): the one bookmark, its
  label and URL.
- **Delete**, from the detail view, with a confirmation step before
  anything is removed.

Nothing else. No edit, no search, no tags, no sharing, no dashboard
widgets, per the brief's own scope line.

## 3. Behavior

- A user sees only their own bookmarks, everywhere, without exception.
  This includes the list, the detail view, and any API response, not
  just what is rendered on screen.
- Switching between list and detail does not trigger a full page
  reload, but the URL still changes with each view, so every view is
  independently addressable and shareable.
- A deletion is recorded for audit before the bookmark disappears, not
  after.
- Nothing in the URL or the interface ever exposes the bookmark's real
  database identifier.

## 4. Do Not Build

No landing page. No editing, search, tags, sharing, or collaboration.
No dashboard widgets. Create, list, view, delete. Nothing added beyond
this list, even if it would be quick to build, since every hour spent
outside the brief is an hour not spent on what is actually graded.

## 5. Data Model

```prisma
model Bookmark {
  id        String   @id @default(cuid())
  publicId  String   @unique @default(nanoid(12))
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  label     String
  url       String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([userId, createdAt])
}

model BookmarkDeletionAudit {
  id              String   @id @default(cuid())
  userId          String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  bookmarkPublicId String
  bookmarkLabel   String
  deletedAt       DateTime @default(now())

  @@index([userId])
}
```

`id` is the real database primary key and never leaves the server.
`publicId` is a separate, random, unguessable value (a 12 character
nanoid, not a sequential number) used in every URL and every API
response. The two are deliberately different columns, not one field
serving both purposes.

`BookmarkDeletionAudit` stores a denormalized snapshot
(`bookmarkLabel`) rather than only a foreign key to the deleted
bookmark, because the bookmark itself will no longer exist after
deletion. An audit record that only points at a row that is gone
cannot actually answer "what was deleted," which is the whole point of
having it.

## 6. Why a Separate Public ID, and What It Does Not Do

Exposing `publicId` instead of `id` has one real purpose: it keeps the
database's own internal identifiers, and anything that could be
inferred from them (row count, creation order, which table a record
lives in), away from anyone looking at a URL or a network request.

It is not, on its own, an access control mechanism, and the PRD is
explicit about this because it is a named trap in the brief: hiding or
obscuring an identifier is not the same as protecting the record
behind it. A `publicId` is still just as guessable to brute-force as
any other identifier if nothing else stands in the way. The actual
protection in this system comes from Section 7 below, the scoped
query, not from the identifier being hard to guess. Both exist
together, but only one of them is doing the real security work.

## 7. Access Control: Scoping the Query, Not Checking After

Every read, update, or delete on a `Bookmark` must include the
authenticated user's ID in the same database query that fetches the
row, never as a separate check performed in application code after the
row has already been retrieved.

Correct:
```ts
const bookmark = await prisma.bookmark.findFirst({
  where: { publicId, userId: session.userId },
});
```

Not acceptable, even though it looks similar:
```ts
const bookmark = await prisma.bookmark.findUnique({ where: { publicId } });
if (bookmark.userId !== session.userId) {
  throw new ForbiddenError();
}
```

The second version is a real trap named directly in the brief: it
works today, and it will be forgotten the day someone adds a new route
and does not remember to repeat the check. The first version makes
that mistake structurally impossible, since there is no code path that
can return another user's row at all. If the `userId` condition is
ever accidentally removed from the query, every route built against
this pattern breaks the same way, loudly, rather than one route
quietly leaking data while the others stay safe by accident.

This is the single architectural decision the whole slice is graded
on. Every route handler must be written this way, with no exceptions
for routes that feel too simple to bother.

## 8. Status Codes

- **401**: no valid session at all. The request is not authenticated,
  regardless of which bookmark or route is involved.
- **404**: the scoped query (Section 7) returned no row. This covers
  two different real situations, a bookmark that genuinely does not
  exist, and a bookmark that exists but belongs to someone else, and
  the response is identical either way, on purpose. Returning 403 here
  instead would confirm to an attacker that a given identifier exists,
  just not theirs, which is itself a real information leak that
  enables enumeration. Returning a uniform 404 for both cases denies an
  attacker that signal entirely.
- **403**: reserved for a case unrelated to ownership, a valid session
  making a mutating request without a valid CSRF token. This is a
  genuine, distinct meaning for 403 in this slice: "I know who you
  are, and the resource may well be yours, but I am refusing this
  specific request for a different security reason."

This is a deliberate design decision, not an oversight, and it is
exactly what the brief's defense question ("why is this a 403 and not
a 404, or the other way round") is testing. Be ready to explain this
choice, including the information-leak reasoning above, out loud.

## 9. Proving Access Control: The Attack Audit Table

Two real user accounts are required, created the same way as the
existing auth test user:
```
node scripts/create-user.js alice@test.bookmark Password123!
node scripts/create-user.js bob@test.bookmark Password123!
```

With Alice's bookmarks created first, every route must then be
attacked as Bob, attempting to reach Alice's data by:
- Editing the `publicId` in the URL to one of Alice's known bookmark
  IDs
- Replaying a captured request with Bob's session but Alice's ID in it
- Calling the API endpoint directly with `curl`, bypassing the UI
  entirely

One row per route, in a table, recording the method, path, what was
attempted, what actually happened, and pass or fail. Every row must
read pass before submission, and the table itself, not just the final
pass/fail column, is part of what gets graded. A reviewer needs to see
what was actually tried, not just be told it was tried.

| Method | Path | Attempted | Result | Pass/Fail |
|---|---|---|---|---|
| GET | `/bookmarks/[alice-publicId]` | View Alice's bookmark while signed in as Bob | 404 returned | Pass |
| DELETE | `/api/bookmarks/[alice-publicId]` | Delete Alice's bookmark as Bob | 404 returned, no row deleted | Pass |
| GET | `/api/bookmarks/[alice-publicId]` (curl, no session) | Direct call, no auth at all | 401 returned | Pass |
| DELETE | `/api/bookmarks/[alice-publicId]` (curl, Bob's session cookie) | Bypass the UI entirely | 404 returned | Pass |

This table is a template. Every actual route the app exposes needs its
own row, including the list and create endpoints, even where a direct
cross-user attack is less obvious, the table should still show that it
was considered and tested, not skipped because it seemed safe.

## 10. Query Count: Measuring and Reducing

Each of the three main actions (list, view one bookmark, delete one
bookmark) needs its query count measured, both before and after at
least one real optimization, with a short note on what each query was
actually doing.

The intended reduction, designed in from the start rather than
discovered by accident:
- **Viewing a bookmark's detail page**: a naive first pass might run
  one query to check the bookmark exists, then a second to check it
  belongs to the current user, then a third to actually fetch it. The
  scoped query from Section 7 does all three in one call, since
  existence, ownership, and the data itself are all answered by the
  same `WHERE` clause at once.
- **Deleting a bookmark**: a naive first pass might fetch the bookmark
  to confirm ownership, then issue a separate delete call. A single
  scoped `deleteMany` (not `delete`, since `delete` requires a unique
  match and cannot carry the ownership condition in the same safe way)
  with both `publicId` and `userId` in the `where` clause does the
  ownership check and the deletion in one query, and its returned
  count tells you whether a row was actually deleted.
- **Listing bookmarks**: should always have been a single scoped
  query; worth documenting if an avoidable extra `COUNT` query for the
  empty state check gets removed in favor of checking the length of
  the single result set instead.

| Action | Before (query count) | After (query count) | What changed |
|---|---|---|---|
| View detail | 3 | 1 | Existence, ownership, and fetch combined into one scoped query |
| Delete (audit included) | 4 | 3 | Removed a redundant second ownership lookup; the remaining statements are one scoped label lookup, the audit insert, and one scoped `deleteMany` |
| List | 2 | 1 | Removed a separate `COUNT` query for the empty state |

These are the measured numbers from the actual build, captured with
Prisma query events (`scripts/measure-bookmark-queries.mjs`).
Transaction control statements are excluded, and `validateSession()`
costs two auth queries per HTTP request, which are excluded as
authentication overhead rather than bookmark work.

The delete target above (2 -> 1) is only reachable without the audit row
required by Section 7. Keeping the audit, the shipped path is 4 -> 3; the
no-audit floor is measured separately at 2 -> 1. Section 5 of
`DOCUMENTATION.md` names the single change that reduced the most queries
(the detail view, 3 -> 1) and explains why, since the brief's grading
bands ask for exactly that.

## 11. Indexing

- `@@index([userId])` on `Bookmark`, since every list and lookup
  filters by the current user first.
- `@@index([userId, createdAt])` on `Bookmark`, since the list is
  sorted newest first within one user's own bookmarks.
- `publicId` is already `@unique`, which Prisma backs with its own
  index, covering detail and delete lookups by identifier.
- `@@index([userId])` on `BookmarkDeletionAudit`, in case audit
  history ever needs to be queried per user.

## 12. Page Architecture: Conditional Views with URL State

The list and detail views render without a full page reload between
them, but each one still has its own real URL (`/bookmarks` and
`/bookmarks/[publicId]`), so a detail view can be bookmarked, shared,
or reloaded directly and still land on the right record. This is the
brief's own named trap to avoid: building fast, app-like navigation
and forgetting that nothing is actually shareable if the URL never
changes.

## 13. Evidence Checklist

- The full attack audit table from Section 9, every row passing.
- The query count table from Section 10, with real before/after
  numbers and a one-line classification per query.
- A screenshot of the audit log table after a real deletion, showing
  the record was written.
- A screenshot of a bookmark's detail URL, showing the identifier in
  it is the `publicId`, not the database `id`.

## 14. Documentation Handoff Note

`DOCUMENTATION.md` Section 5 for this slice still needs its own full
four-question treatment for each of: authentication versus
authorization, scoping the query versus checking after the fetch,
insecure direct object references, why raw database identifiers are
not exposed, audit logging, page architecture with URL state, status
codes (401 versus 403, and the reasoning behind choosing 404 over 403
for ownership misses), database indexing, and query count as a real
cost with before and after numbers. Capture the evidence in Section 13
as each piece is built and tested, not retroactively.
