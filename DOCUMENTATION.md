# Bookmarks: Records and Access Slice

## Section 1: What This Is

This slice is a small bookmarks app where a signed-in user can create, list,
view, and delete their own bookmarks. A bookmark is just a label and a URL. The
record type does not matter much here. What matters is that no user can ever
reach another user's bookmarks, whether they click around the screens, edit an
identifier in the address bar, or call the API directly with a tool like curl.
To make that true, every database query that touches a bookmark includes the id
of the signed-in user, every deletion writes an audit record before the
bookmark disappears, and the URLs only ever contain a random public identifier,
never the real database id.

I deliberately left out anything the assignment did not ask for. There is no
editing, search, tags, sharing, or collaboration, no landing page, and no
dashboard widgets. The only screens are the list, the create form, the detail
view, and the delete confirmation. Sign in and session checking were reused from
an authentication project I built earlier, but only those two parts. I did not
bring over sign up, email verification, or password reset, since this slice only
needs to know who is making each request. Because there is no sign up page, the
test accounts are created with a script.

---

## Section 2: How To Run It

1. **Install dependencies:** `npm install`. A `postinstall` script
   (`scripts/fix-cmd-shims.js`) runs automatically. It only matters on Windows
   when the project folder name contains an ampersand, and it is explained in
   Section 6.
2. **Copy the env file and fill in the values:** `cp .env.example .env`. Two
   variables are needed, listed below.
3. **Create the PostgreSQL database** named in `DATABASE_URL`. Nothing creates it
   for you, so it has to exist before the next step.
4. **Run the migrations:** `npx prisma migrate dev`. This creates every table,
   index, and foreign key described in Section 4, and generates the Prisma
   client.
5. **Create two test users.** There is no sign up page, so run this once for each
   account:
   `node scripts/create-user.js <email> <password>`
   The evidence in this document uses `alice@test.bookmark` and
   `bob@test.bookmark`.
6. **Start the app:** `npm run dev`.
7. **Open it:** go to `http://localhost:3000`, sign in at `/signin`, and you land
   on `/bookmarks`.

**Environment variables and where each one comes from:**

```env
# A PostgreSQL connection string for your own local database.
# The database must already exist (step 3).
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/records_access"

# A random secret used to sign the CSRF tokens. Generate one with:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CSRF_SECRET="replace-with-64-hex-char-random-string"
```

There is no `SESSION_SECRET`. Sessions here are random tokens, and the database
stores only a hash of each token, so nothing needs to be signed. I explain this
in Section 6.

**Reproducing the evidence (optional).** With the dev server running, these
scripts reproduce the evidence in this document. Each run creates its own test
rows and deletes them afterward.

```bash
node scripts/run-attacks.mjs                    # the access control attacks
node scripts/verify-bookmark-security.mjs       # the full 26 assertion harness
node scripts/measure-query-counts.mjs           # the query counts
node scripts/test-bookmark-delete-rollback.mjs  # the audit rollback tests
```

---

## Section 3: The Flow, Step By Step

Here is what happens from a user's first action to the last, following the real
routes and files.

**1. Sign in.** The user opens `/signin` and submits their email and password.
The page sends them to `POST /api/auth/signin`. The server checks the password
against the stored hash, creates a session, and sets a cookie. The cookie holds
a random token and is `HttpOnly` and `SameSite=Strict`. Only a hash of the token
is stored in the `Session` table. On success the page sends the user to
`/bookmarks`.

**2. Open the list.** The user lands on `/bookmarks`
(`src/app/bookmarks/page.tsx`). This is a server component, so it runs on the
server before anything is sent to the browser. It calls `validateSession()`
first. If there is no valid session it redirects to `/signin` and never touches
bookmark data. `src/proxy.ts` also guards `/bookmarks` and `/dashboard`, and an
unauthenticated visit gets a `307` redirect to `/signin`. With a valid session,
the page calls the list function in `src/lib/bookmarks.ts`, passing the `userId`
taken from the session. The query returns only that user's bookmarks, newest
first. If there are none, the user sees a real empty state with no placeholder
content. (`/dashboard` is a leftover from the ported auth and only redirects to
`/bookmarks`.)

**3. Create a bookmark.** The user fills in a label and a URL and submits. The
frontend sends `POST /api/bookmarks` with the data and a CSRF token. The route
works through its checks in a fixed order: no session gives `401`, a bad CSRF
token gives `403`, invalid input gives `400`, and only then does it touch the
database. Validation is a Zod schema on the server. It allows only `http` and
`https` URLs, rejects URLs with credentials embedded in them, and strips any
field it does not recognize. The create function in `src/lib/bookmarks.ts` sets
the owner from the session and generates a new random `publicId`. The response
is `201` and contains only `label`, `publicId`, and `url`.

**4. View one bookmark.** The user clicks a bookmark and goes to
`/bookmarks/[publicId]`. That page also checks the session first, then calls
`getBookmark(userId, publicId)`. Both values sit in the same `WHERE` clause. If
the query finds nothing, the page calls `notFound()`. The user sees a normal
404 page whether the bookmark does not exist or belongs to someone else.

**5. Delete a bookmark.** From the detail page the user presses delete and
confirms. The frontend sends `DELETE /api/bookmarks/[publicId]` with the CSRF
token. After the same session and CSRF checks, the server opens one database
transaction. Inside it, it reads the bookmark's label (scoped to the user),
inserts a row into `BookmarkDeletionAudit`, and then runs a scoped
`deleteMany`. If any step fails, the whole transaction rolls back. If the delete
removes zero rows, the code throws `BookmarkDisappearedError`, which also rolls
back, so no audit row is left behind, and the user gets a `404`. On success the
user is back on the list and the bookmark is gone.

If you know this flow, you can predict where any behavior lives. Anything about
who is asking is in the session code. Anything about which rows can be touched
is in `src/lib/bookmarks.ts`. Everything else is a thin route or page that calls
into those two.

---

## Section 4: The Data Model

These are the tables this slice uses. Two are new (`Bookmark` and
`BookmarkDeletionAudit`) and three came with the ported sign in. The schema is
in `prisma/schema.prisma`, and the database is built by three forward-only
migrations: the initial one, `add_bookmarks`, and `reconcile_auth_schema`.

### `User`
```prisma
model User {
  id           String   @id @default(cuid())
  fullName     String
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  sessions               Session[]
  bookmarks              Bookmark[]
  bookmarkDeletionAudits BookmarkDeletionAudit[]
}
```
The account record. Email is unique so two accounts cannot share an address, and
the password is only ever stored as a hash.

### `Session`
```prisma
model Session {
  id               String    @id @default(cuid())
  userId           String
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  sessionTokenHash String    @unique
  createdAt        DateTime  @default(now())
  lastActivityAt   DateTime  @default(now())
  expiresAt        DateTime
  invalidatedAt    DateTime?

  @@index([userId])
}
```
One row per signed-in session. The token is stored as a hash, so a leaked
database does not hand out usable session cookies. The hash is unique so a
cookie always matches at most one session.

### `RateLimitAttempt`
```prisma
model RateLimitAttempt {
  id           String    @id @default(cuid())
  identifier   String
  route        String
  attemptCount Int       @default(1)
  lockedUntil  DateTime?
  windowStart  DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@unique([identifier, route])
}
```
Used by the sign in rate limiter that came with the ported auth. The unique pair
means one counter per person per route.

### `Bookmark`
```prisma
model Bookmark {
  id        String   @id @default(cuid())
  publicId  String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  label     String
  url       String

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([userId, createdAt])
}
```
Holds the bookmarks. Each one belongs to exactly one user.

- **`id` and `publicId` are two separate columns on purpose.** `id` is the real
  primary key and never leaves the server. `publicId` is a random 12 character
  nanoid and is the only identifier that appears in URLs or API responses. I
  explain why in Section 5.
- **`publicId` is unique.** This guarantees two bookmarks can never share a
  public identifier, so a lookup by `publicId` and `userId` can match at most
  one row.
- **`userId` is required.** A bookmark cannot exist without an owner, and the
  foreign key means it cannot point at a user that does not exist. The cascade
  means removing a user also removes their bookmarks.
- **`label` and `url` are plain text.** The rules about what a URL may look like
  (only `http` and `https`, no embedded credentials) are enforced by the Zod
  schema in the application, not by the database.
- **The two indexes** match the real queries and are explained in Section 5.

### `BookmarkDeletionAudit`
```prisma
model BookmarkDeletionAudit {
  id               String   @id @default(cuid())
  userId           String
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  bookmarkPublicId String
  bookmarkLabel    String
  deletedAt        DateTime @default(now())

  @@index([userId])
}
```
One row for every deleted bookmark, recording who deleted it, which bookmark it
was, and when.

- **It stores a copy of the label (`bookmarkLabel`) and the `publicId` as plain
  text, not a foreign key to `Bookmark`.** The bookmark row is gone after the
  delete, so a link to it would point at nothing. A copy of the label is the
  only way the audit row can still say what was deleted.
- **`deletedAt` defaults to the current time**, so the timestamp is set by the
  database at the moment the row is written.

### Which constraints make an invalid state impossible?

- `User.email` is unique, so two accounts cannot share an email.
- `Bookmark.publicId` is unique, so one public identifier can never lead to two
  different bookmarks.
- `Bookmark.userId` is required and is a foreign key, so a bookmark can never
  exist without a real owner. The same is true of `Session` and
  `BookmarkDeletionAudit`, so none of them can point at a user that does not
  exist.
- `Session.sessionTokenHash` is unique, so a session cookie can match only one
  session.

The only constraints I added for this slice are these indexes and foreign keys.
There are no CHECK constraints. I want to be clear about what the database does
**not** guarantee, because it matters more here than anywhere else:

- The database does not know who owns a row in the sense of who is asking. If a
  query forgot the `userId` condition, Postgres would happily return someone
  else's bookmark. The whole protection lives in application code, in one
  module, which is the reason I structured it that way (Section 5).
- The database does not stop an audit row from being edited or deleted later.
  It stays an honest record only because my code never does that.
- The order "audit first, then delete" is enforced by a transaction in the code,
  not by the schema.

---

## Section 5: The Concepts

### Authentication versus authorisation

**What it is.** Authentication answers "who is making this request?" Authorisation
answers "is this person allowed to touch this specific thing?" They are two
different questions, and passing the first does not mean passing the second.

**Why it is needed.** If an app only checks that someone is signed in, then any
signed-in user can read or delete any other user's data, as long as they can
guess an identifier. Being logged in proves who you are. It says nothing about
which rows are yours.

**How I implemented it.** Authentication is the ported session system. The
cookie holds a random token, the database holds only a hash of it, and
`validateSession()` (in `src/lib/session.ts`) looks the hash up on every
request. A session expires after 30 minutes of inactivity or 24 hours in total.
Authorisation is a separate step done by `userId` scoping in
`src/lib/bookmarks.ts`. The `userId` is read only from the validated session. It
is never read from the request body, the query string, or the URL. I proved this
with a forged create request that included someone else's `userId`, a `publicId`,
and an `id` in the body. The Zod schema stripped all three, and the new bookmark
was owned by the signed-in user.

**What I chose against, and why.** I did not scatter ownership checks across
each route handler. Keeping authorisation inside one data-access module means the
routes stay thin, and there is exactly one place to audit. The trade-off is that
every future read or write of a bookmark has to go through that module.

### Scoping the query versus checking after the fetch

**What it is.** There are two ways to protect a row. The risky way is to fetch it
by identifier, then compare its owner to the current user in code. The safe way
is to put the owner in the same `WHERE` clause that fetches the row, so a row
that belongs to someone else is never returned in the first place.

**Why it is needed.** The fetch-then-compare version works today and fails the
day someone writes a new route and forgets the comparison. Between loading the
row and checking it, the other user's data is already in memory. A scoped query
removes that whole class of mistake. There is no code path that can return
another user's row, so there is no check to forget.

**How I implemented it.** Every function in `src/lib/bookmarks.ts` takes
`userId` as a required first argument, and every query includes it:

```ts
const bookmark = await prisma.bookmark.findFirst({
  where: { publicId, userId },
  select: { publicId: true, label: true, url: true },
});
```

Delete uses a scoped `deleteMany` instead of `delete`, because `delete` only
accepts a unique key and cannot carry the ownership condition in the same
statement. All bookmark database access lives in that one module, and no route
or page calls Prisma for bookmarks directly.

**What I chose against, and why.** I rejected the fetch-then-compare pattern. I
also considered Postgres row level security, which would push the same rule into
the database itself and is a stronger guarantee. I did not use it because it
needs per-request database settings that are awkward with Prisma, and it went
beyond what this slice asked for. One side effect of scoping is that "row does
not exist" and "row is not yours" look identical to the data layer, so I cannot
return a different answer for each. That is what I want, as the status codes
section below explains.

### Insecure direct object references (IDOR)

**What it is.** An IDOR happens when an app trusts an identifier from the client,
such as the one in the URL, and uses it to load a record without checking that
the person asking is allowed to see it. Change the number or string in the URL,
and you reach someone else's data.

**Why it is needed.** The detail and delete routes take an identifier straight
from the URL (`/bookmarks/[publicId]`). Without protection, anyone who learns
or guesses another user's `publicId` could open or delete that bookmark. Hiding
the identifier would not fix this. The protection has to be the ownership check.

**How I implemented it.** The identifier is never used alone. It is always
combined with the session's `userId` in the same query (previous concept). To
prove it, I created Alice and Bob and attacked every route as Bob against
Alice's real bookmark. I edited the URL, replayed Bob's session against Alice's
identifier, and called the API directly with curl. I also checked that sending
the internal database `id` where a `publicId` belongs returns `404`. The exact
commands and raw output are in `evidence/attack-log.txt`. The table below comes
from the full test harness, which passes all 26 assertions against both
`next dev` and the production build.

| # | Method | Path | Attempted | Result | Pass |
|---|---|---|---|---|---|
| 1 | GET | `/bookmarks` (page) | Open the list with no session | `307` to `/signin` | Pass |
| 2 | GET | `/bookmarks` (page) | List as Bob while Alice's row exists | `200`; Alice's label and `publicId` absent | Pass |
| 3 | GET | `/bookmarks/[alice-publicId]` (page) | Edit the URL to Alice's identifier as Bob | `404`; nothing leaked | Pass |
| 4 | GET | `/bookmarks/[alice-publicId]` (page) | Open Alice's detail URL with no session | `307` to `/signin` | Pass |
| 5 | GET | `/bookmarks/[internal-id]` (page) | Use the raw database `id` where a `publicId` belongs | `404` | Pass |
| 6 | GET | `/api/bookmarks` | List API with no session | `401` | Pass |
| 7 | GET | `/api/bookmarks` | List API as Bob | `200`, zero rows, no Alice data | Pass |
| 8 | GET | `/api/bookmarks/[alice-publicId]` | Replay Bob's session against Alice's identifier | `404` | Pass |
| 9 | GET | `/api/bookmarks/[missing]` | Request a nonexistent identifier | `404`, identical to row 8 | Pass |
| 10 | GET | `/api/bookmarks/[internal-id]` | Raw database `id` on the API | `404` | Pass |
| 11 | POST | `/api/bookmarks` | Create with no session | `401` | Pass |
| 12 | POST | `/api/bookmarks` | Create as Bob without a CSRF token | `403` | Pass |
| 13 | POST | `/api/bookmarks` | Create as Bob with forged `userId`, `publicId`, and `id` in the body | `201`; owned by Bob, forged fields ignored | Pass |
| 14 | POST | `/api/bookmarks` | Normal create as Alice | `201`; response keys are exactly `label`, `publicId`, `url` | Pass |
| 15 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete Alice's row as Bob with a valid CSRF token | `404`; Alice's row still there | Pass |
| 16 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete as Bob without a CSRF token | `403` | Pass |
| 17 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete as Alice while sending Bob's CSRF token | `403`; the token is tied to the session | Pass |
| 18 | DELETE | `/api/bookmarks/[alice-publicId]` | Delete with no session and no CSRF token | `401`; session is checked before CSRF | Pass |
| 19 | DELETE | `/api/bookmarks/[alice-publicId]` | Alice deletes her own row with her valid token | `200`; exactly one audit row written | Pass |
| 20 | DELETE | `/api/bookmarks/[alice-publicId]` | Repeat the same delete | `404`; no second audit row | Pass |
| 21 | GET | `/api/bookmarks` | List as Alice after Bob's create | `200`; Alice's row present, Bob's absent | Pass |
| 22 | GET | `/api/bookmarks` | List as Bob after Bob's create | `200`; Bob's row present, Alice's absent | Pass |
| 23 | GET | `/api/bookmarks/[alice-publicId]` | Confirm Alice's row survived every Bob attempt | `200` before her own delete | Pass |
| 24 | GET | `/api/bookmarks/[deleted]` | Fetch the row after Alice's own delete | `404` | Pass |

The 404 body for "another user's row" and for "missing row" was compared byte
for byte and is identical. After every one of Bob's delete attempts I checked
that Alice's bookmark was still there, because a delete attack only counts as
stopped if the data survived.

**What I chose against, and why.** The IDOR is the reason I did not rely on the
random `publicId` as protection. The `publicId` is hard to guess, but it is not a
secret, and an app that depends on an identifier staying hidden is one leak away
from exposing everything. The ownership condition is the actual control.

### Why raw database identifiers are not exposed

**What it is.** `Bookmark.id` is the internal primary key. The browser never sees
it. The only identifier a client ever receives is `publicId`, a separate random
value.

**Why it is needed.** An internal id is a stable handle into the database. It
can reveal how many records exist or in what order they were made, it ties the
public side of the app to the internal schema, and every leak of it is a leak of
something that can never be changed. A separate public identifier can be replaced
without touching the database design. I want to be honest that this is not what
makes the app safe. It reduces what an outsider learns, while the scoped query
does the real protecting.

**How I implemented it.** Every read uses an explicit `select` with only
`publicId`, `label`, and `url`, so the internal `id` and the owning `userId`
cannot leak by accident through a broad query or a serialised object. I checked
the rendered detail page and found the `publicId` in the HTML and the internal
`id` nowhere in it. The create response contains exactly three keys. The
screenshots in the Evidence section show the two identifiers side by side.

**What I chose against, and why.** The simplest option was to use the primary
key in URLs. I chose a second column because it keeps database identifiers off
the public surface, even though it costs one extra unique index and one more
value to reason about.

### Audit logging

**What it is.** An audit log is a permanent record of an action that mattered:
who did it, to what, and when. Here, every deletion writes a row to
`BookmarkDeletionAudit` with the user, the `publicId`, a copy of the label, and
the time.

**Why it is needed.** Once a row is deleted, the evidence that it ever existed is
gone. Without an audit record, there is no answer to "who deleted this and when,"
which matters for support questions and for noticing misuse. The record also has
to be written at the right moment. If it is written after the delete, a crash
between the two steps leaves a deleted bookmark with no trace.

**How I implemented it.** The delete runs in one database transaction: a scoped
lookup of the label, then the audit insert, then the scoped `deleteMany`. Because
the audit is written first and inside the same transaction, it is impossible to
have a delete without an audit row, or an audit row without a delete. I tested
both failure paths with `scripts/test-bookmark-delete-rollback.mjs`, which passes
3 of 3. When I forced the audit insert to fail, the bookmark stayed in place and
no audit row appeared. When I simulated a second delete winning a race, the code
returned `404` and no orphan audit row was left. The screenshots in the Evidence
section show a deletion and the resulting audit row.

**What I chose against, and why.** I did not write the audit row after the
delete, which is the mistake the brief warns about. I also did not use a soft
delete (a flag on the bookmark instead of removing it), because that would leave
deleted rows in the table and force every query to filter them out, which is its
own way of forgetting a condition.

### Page architecture: conditional rendering with URL state

**What it is.** The list and the detail view are different views of the same app,
and moving between them should feel fast, without reloading the whole page. But
each view should also have its own real URL, so it can be bookmarked, shared, or
reloaded and still land on the same thing.

**Why it is needed.** Both properties matter, for different reasons. Fast
navigation makes the app pleasant. A real URL makes every view addressable. If
the URL never changes while views swap, nothing can be shared and reloading drops
you back at the start. If every click reloads the whole page, the app feels slow.

**How I implemented it.** The list lives at `/bookmarks` and each bookmark lives
at `/bookmarks/[publicId]`. Both are server components. They check the session
and `redirect("/signin")` before any data is touched, and the detail page calls
`notFound()` when the scoped lookup returns nothing. The pages link to each other
with the Next.js `Link` component, so moving between them is a client-side
transition and not a full reload, while the address bar still updates. Because
the page and the API both use `getBookmark`, the page cannot end up with a
different ownership rule from the API.

**What I chose against, and why.** I did not build a single page that swaps views
using only client state, because the URL would never change and nothing could be
shared. I also did not use plain anchor tags that reload the whole page, because
that gives up the fast navigation the brief asks for.

### Status codes (401 versus 403, and why a miss is a 404)

**What it is.** The status code tells the caller what kind of failure happened.
`401` means "I do not know who you are." `403` means "I know who you are, and I
am refusing this request." `404` means "there is nothing here for you."

**Why it is needed.** A wrong code can leak information. The most important case
is a request for another user's bookmark. If the app answered `403` there, it
would be telling the caller "that identifier exists, it is just not yours." That
lets an attacker work through identifiers and learn which ones are real. Answering
`404` for both "does not exist" and "belongs to someone else" gives them nothing.

**How I implemented it.** The check order is the same for every bookmark route:
session, then CSRF, then validation, then the data.

| Status | When | Why not the alternative |
|---|---|---|
| `401` | No valid session, on any bookmark page or API route | Failing to authenticate is its own condition. Hiding it behind a `404` would confuse legitimate clients without protecting anything. |
| `403` | Valid session, but a `POST` or `DELETE` with a missing or wrong CSRF token | This is not an ownership answer. It is decided before any row is looked up, so it reveals nothing about the identifier. |
| `404` | The scoped query returned no row, because the bookmark is missing or belongs to someone else | A `403` here would confirm the identifier exists. A uniform `404`, with an identical body, removes that signal. |
| `400` | Malformed JSON or a label or URL that fails validation | A client error, not an authorisation decision, so it is checked only after identity and CSRF. |
| `307` | An unauthenticated visit to a bookmark page | Pages redirect to sign in. APIs return `401`. |

The tests confirm the order. A delete with no session and no token returns `401`,
not `403`. Bob's delete with a valid session and no token returns `403`, not
`404`. Bob's delete with a valid token returns `404`. A request from Alice that
carries Bob's CSRF token also returns `403`, which shows the token is checked
against the session and not just present.

**What I chose against, and why.** I did not return `403` for ownership failures,
because of the enumeration problem above. The downside is that a real "this is
not yours" message is not possible, and debugging gets slightly harder because
the logs cannot tell a missing bookmark from someone else's. I accepted that,
since the ambiguity is the point. I kept `403` for a different, honest meaning:
the CSRF refusal.

### Database indexing

**What it is.** An index is an extra structure the database keeps so it can find
rows without reading the whole table, like the index at the back of a book. The
cost is a little extra storage and a little extra work on every write.

**Why it is needed.** Every query here filters by `userId` first. Without an
index on it, each list or lookup would scan the entire `Bookmark` table, and the
cost would grow with every user's data, not just the current user's.

**How I implemented it.** I checked each index against the live database with
`prisma migrate diff` and `pg_indexes`.

| Index | Why it exists |
|---|---|
| `Bookmark_publicId_key` (unique) | Detail and delete lookups by `publicId`, and it guarantees the identifier is unique. |
| `Bookmark_userId_idx` | Every list, lookup, and delete filters by the session's `userId`. |
| `Bookmark_userId_createdAt_idx` | The list is `WHERE userId = ? ORDER BY createdAt DESC`. This one index serves both the filter and the sort. |
| `BookmarkDeletionAudit_userId_idx` | Supports looking up a user's audit history. |

**What I chose against, and why.** I did not add an index on label or URL,
because this slice has no search. Adding one should follow a real query that
needs it, not be done speculatively.

### Query count as a cost

**What it is.** Every database query is a round trip, and round trips add latency
and load. Counting them for each action shows where the app is doing redundant
work.

**Why it is needed.** Extra queries are easy to add without noticing, especially
when ownership, existence, and fetching are each done as a separate step. Each one
costs time on every request and adds up as the app grows.

**How I implemented it.** I measured the three main actions against the live
PostgreSQL database by listening to Prisma's query events
(`scripts/measure-query-counts.mjs`), repeating each measurement three times.
Counts are data queries (`SELECT`, `INSERT`, `UPDATE`, `DELETE`), and transaction
control statements are excluded. The "before" versions are deliberately redundant
baselines I wrote for measurement. They are still scoped to the user in every
query, so the measurement never uses an unsafe pattern.

| Action | Before | After | What changed |
|---|---|---|---|
| List | 2 | 1 | Removed a separate `COUNT` used only for the empty state. The page checks the length of the single result instead. |
| View detail | 3 | 1 | Existence, ownership, and the row data are answered by one scoped `findFirst`. The two extra lookups are gone. |
| Delete (with audit, as shipped) | 4 | 3 | Removed a redundant second ownership lookup. What remains is one scoped label lookup, the audit insert, and one scoped `deleteMany`. |
| Delete (no audit, for comparison) | 2 | 1 | A single scoped `deleteMany` replaces lookup then delete. Not shipped, because it would drop the audit. |

For the shipped code, list is one scoped `SELECT` ordered by `createdAt`, detail
is one scoped `SELECT` by `publicId` and `userId`, and delete is a scoped
`SELECT` of the label, an `INSERT` into the audit table, and a scoped `DELETE`.
The list query count stayed at one when I measured it with 0, 1, and 20 rows, so
there is no N+1 problem.

**The single change that cut the most queries** was combining existence,
ownership, and fetch for the detail view, which went from 3 queries to 1. It
saved the most because all three questions are answered by the same `WHERE`
clause, so the extra queries were pure repetition.

**A deviation from my plan.** I planned for delete to drop from 2 queries to 1.
That is only possible without the audit write. With the audit required before the
delete, three statements is the honest minimum, so the real result is 4 down to
3. I kept the audit guarantee and did not shave the number to match my plan. The
2 to 1 figure is shown above as a separate variant for comparison.

**What these counts leave out.** Every authenticated request also pays for
session validation: a session lookup, a user lookup, and an update to
`lastActivityAt`. That is shared authentication cost, not bookmark work, so I left
it out of the table and am noting it here so the numbers are not mistaken for the
full cost of a request.

**What I chose against, and why.** I did not measure only the optimised code. A
before and after needs a real baseline, and writing one that is redundant but
still safe was a better choice than comparing against code that did not exist.

### The single change that would have prevented the most audit failures

The most valuable decision in this slice was making `userId` a required first
argument of every function in `src/lib/bookmarks.ts`, and keeping all bookmark
database access inside that one module. Nearly every access-control failure in
this kind of app comes from one place: a query that forgot the owner condition.
With this design, a function cannot be called without an owner, no route calls
Prisma for bookmarks on its own, and there is one file to audit. If I had built
the routes first and added ownership checks to each afterward, the way many apps
grow, that single mistake would have shown up in the attack table.

---

## Section 6: What Went Wrong

### 1. The ported auth brought in far more than I asked for

**Symptom.** After I copied the sign in system into this project, the folder
tree was full of things I did not want: `forgot-password`, `resend-code`,
`reset-password`, `signup`, `verify-email`, and `verify-reset-code` routes, matching
pages under `(auth)`, `email.ts` and `reset-code.ts` in `src/lib`, an OTP input
component, and a `User` model with `emailVerified` and links to verification code
and password reset token tables.

**Investigation.** I looked through the explorer and the schema and compared them
against the three things I actually needed: sign in, session checking, and the
user table. Almost everything else was dead weight.

**Cause.** The copy had brought over the whole auth system instead of only the
parts I named. It did not match what this slice needs.

**Fix.** I removed the extra routes and pages, deleted the email and reset code
files and the OTP component, trimmed the `User` model, and searched the codebase
for leftover imports and references. I recorded the schema change in a new
forward-only migration (`reconcile_auth_schema`) instead of rewriting the existing
one, then confirmed sign in and the route protection still worked.

### 2. The project folder name broke the Prisma tooling on Windows

**Symptom.** `npx prisma studio` would not start. The project lives in a folder
called `Record & Access`.

**Investigation.** I traced the failure to the command shims that npm creates
under `node_modules/.bin`. Each one is a small `.cmd` file for Windows.

**Cause.** `cmd.exe` treats an ampersand as the start of a new command. The shims
set a variable from the folder path, so the path was cut off at the `&` and the
tools could not find their own files.

**Fix.** I added `scripts/fix-cmd-shims.js`, run automatically through
`postinstall`, which wraps that assignment in quotes in every shim. I also made
the `lint`, `build`, `dev`, and `start` scripts call the local binaries through
`node` directly, and added a `db:studio` script. Renaming the folder would have
been the quickest fix, but this also works for anyone who clones into a path with
an ampersand.

### 3. My query count prediction was wrong for delete

**Symptom.** When I measured delete, the count was 4 down to 3. My plan had said
2 down to 1.

**Investigation.** I listed every statement the delete runs, in order, and
compared it to the plan.

**Cause.** The plan counted only "check ownership, then delete." It left out the
audit write that the same plan required before every deletion. A delete that is
audited has to read the label, insert the audit row, and delete the bookmark.

**Fix.** There was nothing to fix in the code. The mistake was in the target. I
kept the audit guarantee, reported the real numbers, and showed the 2 to 1 figure
only as a clearly labelled variant without the audit, so the table stays honest.

### 4. A leftover secret that did nothing

**Symptom.** `.env.example` still listed a `SESSION_SECRET`, with a comment about
signing session data, even though this project never used one.

**Investigation.** I asked how sessions are created and validated, and traced it
in `src/lib/session.ts`.

**Cause.** The variable was left over from the template the auth system came from.
Sessions here are random tokens whose SHA-256 hash is stored in the database, and
validity is decided by a database lookup, not by checking a signature, so no
signing secret is needed. A fast hash like SHA-256 is fine for this, because a
session token is long and random, unlike a password.

**Fix.** I removed `SESSION_SECRET` and its comment. I kept `CSRF_SECRET`, since
the CSRF tokens do use it.

---

## Section 7: What This Slice Does Not Handle

**Left out because it was outside the brief:**

- Editing, search, tags, sharing, and collaboration, which the brief said not to
  build.
- Sign up, email verification, and password reset. Test users are created by a
  script.
- Auditing anything other than deletions. Logging reads or updates would multiply
  the write volume and the brief only asked for deletions.

**Left out because I did not get to it:**

- **Pagination.** The list returns every bookmark a user has. I tested up to 20
  rows. A user with thousands of bookmarks would get one very large response, and
  this is the first thing I would fix before real users touched it.
- **Rate limiting on creating bookmarks.** The ported rate limiter exists but is
  not applied to the bookmark routes, so someone signed in could create bookmarks
  in a loop.
- **A shared end to end test suite.** I have scripts that reproduce the attacks
  and the query counts, but they are not part of an automated test run.

**Things I know about and would need to change before real use:**

- **The protection lives only in application code.** The database would return
  someone else's bookmark to any query that forgot the `userId` condition. Moving
  the rule into the database with row level security, or at least keeping the
  single data-access module strictly enforced in code review, would be the next
  step.
- **The audit log is not tamper-proof.** It is an ordinary table, so nothing in the
  database stops its rows from being edited or deleted, and a compromised
  application could write false rows.
- **Deleting a user also deletes their audit history**, because the audit rows
  cascade with the user. For a real product I would keep the audit rows after an
  account is deleted.
- **The 404 makes debugging harder.** Logs cannot tell "missing" from "not yours."
  That is deliberate, but it would need extra, careful logging to help support.

---

## Section 8: If I Built This Again

If I built this again, the one thing I would change is how I bring in the sign in
code. I copied a whole authentication system and then spent a cleanup pass
removing sign up, email verification, password reset, and a trimmed-down schema,
and the same kind of over-copying slowed me down on an earlier project too. Next
time I would start from an empty project and copy in only the three pieces I
actually need, the user table, the sign in route, and the session check, one file
at a time. The access control itself went well because I designed it around one
rule from the start, but the setup lost time on code I never wanted.

---

## Evidence

Screenshots and logs referenced above are in the `evidence/` folder at the root of
this repository.

**Audit log after a deletion.** Deleting a bookmark through the app, then the new
row in `BookmarkDeletionAudit` with the user, the `publicId`, the label, and the
timestamp.

![Audit log evidence, part 1](./evidence/Evidence%203a.png)
![Audit log evidence, part 2](./evidence/Evidence%203b.png)
![Audit log evidence, part 3](./evidence/Evidence%203c.png)

**A URL with an identifier that is not the database id.** The detail page URL
contains the random 12 character `publicId`.

![Detail page URL showing the publicId](./evidence/Evidence%204a.png)

**The two identifiers compared.** The internal `Bookmark.id` next to the public
`Bookmark.publicId` for the same row.

![Bookmark id compared with publicId](./evidence/Evidence%204b.png)

**Other evidence files:**

- `evidence/attack-table.md` and `evidence/attack-log.txt`: the live access
  control attacks, with the exact curl commands and the raw output.
- `evidence/query-count-table.md` and `evidence/query-count-log.txt`: the query
  count measurements and the raw log.
