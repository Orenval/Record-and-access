// =============================================================================
// Bookmark Access-Control Verification
// =============================================================================
// Runs the Section 9 attack audit against a live server: list, create, detail,
// and delete, as two real users, including direct API calls that bypass the UI.
//
// Requires:
//   - the server running (default http://localhost:3100; override BASE_URL)
//   - alice@test.bookmark and bob@test.bookmark, created with:
//       node scripts/create-user.js alice@test.bookmark Password123!
//       node scripts/create-user.js bob@test.bookmark Password123!
//
// The harness signs in itself, creates its own fixtures, deletes them, and
// removes the sessions it created. It exits non-zero if any check fails.
// No application code is imported or modified.

import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ quiet: true });

const BASE = (process.env.BASE_URL || "http://localhost:3100").replace(/\/$/, "");
const ALICE = "alice@test.bookmark";
const BOB = "bob@test.bookmark";
const PASSWORD = "Password123!";
const RUN = Date.now();
const ALICE_LABEL = `SEC-HARNESS Alice ${RUN}`;
const BOB_LABEL = `SEC-HARNESS Bob ${RUN}`;

const { Client } = pg;
const results = [];

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

class Jar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(response) {
    const list =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const entry of list) {
      const pair = entry.split(";")[0];
      const index = pair.indexOf("=");
      if (index > 0) {
        this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }
  }
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function request(method, path, options = {}) {
  const { jar, csrf, body } = options;
  const headers = {};
  if (jar && jar.header()) headers.cookie = jar.header();
  if (csrf) headers["x-csrf-token"] = csrf;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(BASE + path, {
    method,
    headers,
    body,
    redirect: "manual",
  });
  if (jar) jar.absorb(response);
  const text = await response.text();
  return { status: response.status, text, location: response.headers.get("location") };
}

async function signIn(email, jar) {
  const csrfResponse = await request("GET", "/api/auth/csrf", { jar });
  const csrf = JSON.parse(csrfResponse.text)?.data?.csrfToken;
  if (!csrf) throw new Error("could not obtain a CSRF token from " + BASE);
  const response = await request("POST", "/api/auth/signin", {
    jar,
    csrf,
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (response.status !== 200) {
    throw new Error(`sign-in failed for ${email}: ${response.status} ${response.text}`);
  }
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const created = [];
  const users = await db.query(
    'select "id", "email" from "User" where "email" = any($1)',
    [[ALICE, BOB]]
  );
  if (users.rows.length !== 2) {
    throw new Error(
      "test users missing. Create them with:\n" +
        "  node scripts/create-user.js alice@test.bookmark Password123!\n" +
        "  node scripts/create-user.js bob@test.bookmark Password123!"
    );
  }
  const aliceId = users.rows.find((row) => row.email === ALICE).id;
  const bobId = users.rows.find((row) => row.email === BOB).id;

  const aliceJar = new Jar();
  const bobJar = new Jar();
  const anonJar = new Jar();

  try {
    const csrfA = await signIn(ALICE, aliceJar).then(() =>
      request("GET", "/api/auth/csrf", { jar: aliceJar })
    );
    const aliceCsrf = JSON.parse(csrfA.text)?.data?.csrfToken;
    await signIn(BOB, bobJar);
    const bobCsrfResponse = await request("GET", "/api/auth/csrf", { jar: bobJar });
    const bobCsrf = JSON.parse(bobCsrfResponse.text)?.data?.csrfToken;
    record(Boolean(aliceCsrf && bobCsrf), "sessions", "alice + bob signed in");

    // 1. Unauthenticated page access
    let response = await request("GET", "/bookmarks", { jar: anonJar });
    record(
      response.status >= 300 &&
        response.status < 400 &&
        String(response.location).includes("/signin"),
      "GET /bookmarks (no session)",
      `${response.status} ${response.location}`
    );

    // 2. Unauthenticated API calls
    response = await request("GET", "/api/bookmarks", { jar: anonJar });
    record(response.status === 401, "GET /api/bookmarks (no session)", `${response.status}`);

    response = await request("POST", "/api/bookmarks", {
      jar: anonJar,
      body: JSON.stringify({ label: "x", url: "https://x.example" }),
    });
    record(response.status === 401, "POST /api/bookmarks (no session)", `${response.status}`);

    // 3. Alice creates the target row
    response = await request("POST", "/api/bookmarks", {
      jar: aliceJar,
      csrf: aliceCsrf,
      body: JSON.stringify({ label: ALICE_LABEL, url: "https://alice.example/secret" }),
    });
    const aliceBookmark = json(response.text)?.data?.bookmark;
    const alicePublicId = aliceBookmark?.publicId;
    if (alicePublicId) created.push(alicePublicId);
    const keys = aliceBookmark ? Object.keys(aliceBookmark).sort().join(",") : "";
    record(
      response.status === 201 && keys === "label,publicId,url",
      "POST /api/bookmarks as alice",
      `${response.status} keys=${keys || "(none)"} publicId=${alicePublicId}`
    );

    // 4. List isolation
    response = await request("GET", "/api/bookmarks", { jar: bobJar });
    const bobList = json(response.text)?.data?.bookmarks ?? [];
    record(
      response.status === 200 &&
        bobList.length === 0 &&
        !response.text.includes(ALICE_LABEL),
      "GET /api/bookmarks as bob (list isolation)",
      `${response.status} count=${bobList.length}`
    );

    response = await request("GET", "/bookmarks", { jar: bobJar });
    record(
      response.status === 200 &&
        !response.text.includes(ALICE_LABEL) &&
        !response.text.includes(alicePublicId),
      "GET /bookmarks page as bob (list isolation)",
      `${response.status}`
    );

    // 5. Cross-user read
    response = await request("GET", `/api/bookmarks/${alicePublicId}`, { jar: bobJar });
    const otherUserBody = response.text.trim();
    record(response.status === 404, "GET /api/bookmarks/[alice] as bob", `${response.status}`);

    const missing = await request("GET", "/api/bookmarks/doesnotexist0", { jar: aliceJar });
    record(
      missing.status === 404 && otherUserBody === missing.text.trim(),
      "GET /api/bookmarks/[missing] as alice",
      `${missing.status} identical=${otherUserBody === missing.text.trim()}`
    );

    response = await request("GET", `/bookmarks/${alicePublicId}`, { jar: bobJar });
    record(
      response.status === 404 &&
        !response.text.includes(ALICE_LABEL) &&
        !response.text.includes("https://alice.example/secret"),
      "GET /bookmarks/[alice] page as bob",
      `${response.status}`
    );

    // 6. Cross-user delete
    response = await request("DELETE", `/api/bookmarks/${alicePublicId}`, {
      jar: bobJar,
      csrf: bobCsrf,
    });
    record(
      response.status === 404,
      "DELETE /api/bookmarks/[alice] as bob (valid CSRF)",
      `${response.status}`
    );

    response = await request("GET", `/api/bookmarks/${alicePublicId}`, { jar: aliceJar });
    record(response.status === 200, "alice row still present after bob delete attempt", `${response.status}`);

    response = await request("DELETE", `/api/bookmarks/${alicePublicId}`, { jar: bobJar });
    record(
      response.status === 403,
      "DELETE /api/bookmarks/[alice] as bob (no CSRF)",
      `${response.status}`
    );

    response = await request("DELETE", `/api/bookmarks/${alicePublicId}`, {
      jar: aliceJar,
      csrf: bobCsrf,
    });
    record(
      response.status === 403,
      "DELETE /api/bookmarks/[alice] as alice with bob's CSRF",
      `${response.status}`
    );

    response = await request("DELETE", `/api/bookmarks/${alicePublicId}`, { jar: anonJar });
    record(
      response.status === 401,
      "DELETE /api/bookmarks/[alice] (no session)",
      `${response.status}`
    );

    response = await request("GET", `/bookmarks/${alicePublicId}`, { jar: anonJar });
    record(
      response.status >= 300 &&
        response.status < 400 &&
        String(response.location).includes("/signin"),
      "GET /bookmarks/[alice] page (no session)",
      `${response.status} ${response.location}`
    );

    // 7. Forged identifiers in the create body
    response = await request("POST", "/api/bookmarks", {
      jar: bobJar,
      csrf: bobCsrf,
      body: JSON.stringify({
        label: BOB_LABEL,
        url: "https://bob.example/injected",
        userId: aliceId,
        publicId: "ATTACKER0001",
        id: "attacker-internal",
      }),
    });
    const bobBookmark = json(response.text)?.data?.bookmark;
    const bobPublicId = bobBookmark?.publicId;
    if (bobPublicId) created.push(bobPublicId);
    const forged = await db.query(
      'select count(*)::int as n from "Bookmark" where "publicId" = $1 or "id" = $2',
      ["ATTACKER0001", "attacker-internal"]
    );
    const bobRow = await db.query(
      'select "userId" from "Bookmark" where "publicId" = $1',
      [bobPublicId]
    );
    record(
      response.status === 201 &&
        bobPublicId !== "ATTACKER0001" &&
        bobRow.rows.length === 1 &&
        bobRow.rows[0].userId === bobId &&
        forged.rows[0].n === 0,
      "POST /api/bookmarks as bob with forged userId/publicId/id",
      `${response.status} publicId=${bobPublicId}`
    );

    // 8. Isolation after both users have rows
    response = await request("GET", "/api/bookmarks", { jar: bobJar });
    record(
      response.status === 200 &&
        response.text.includes(BOB_LABEL) &&
        !response.text.includes(ALICE_LABEL),
      "bob list after create (isolation both ways)",
      `${response.status}`
    );

    response = await request("GET", "/api/bookmarks", { jar: aliceJar });
    record(
      response.status === 200 &&
        response.text.includes(ALICE_LABEL) &&
        !response.text.includes(BOB_LABEL),
      "alice list after bob create (isolation both ways)",
      `${response.status}`
    );

    // 9. Owner detail and raw-id rejection
    response = await request("GET", `/bookmarks/${alicePublicId}`, { jar: aliceJar });
    record(
      response.status === 200 &&
        response.text.includes(ALICE_LABEL) &&
        response.text.includes("https://alice.example/secret"),
      "GET /bookmarks/[alice] page as alice",
      `${response.status} url=${BASE}/bookmarks/${alicePublicId}`
    );

    const internal = await db.query(
      'select "id" from "Bookmark" where "publicId" = $1',
      [alicePublicId]
    );
    const internalId = internal.rows[0].id;

    response = await request("GET", `/api/bookmarks/${internalId}`, { jar: aliceJar });
    record(
      response.status === 404,
      "GET /api/bookmarks/[internal id] as owner",
      `${response.status} internalId=${internalId}`
    );

    response = await request("GET", `/bookmarks/${internalId}`, { jar: aliceJar });
    record(
      response.status === 404,
      "GET /bookmarks/[internal id] page as owner",
      `${response.status}`
    );

    // 10. Owner deletion
    response = await request("DELETE", `/api/bookmarks/${alicePublicId}`, {
      jar: aliceJar,
      csrf: aliceCsrf,
    });
    record(response.status === 200, "DELETE /api/bookmarks/[alice] as alice", `${response.status}`);

    response = await request("GET", `/api/bookmarks/${alicePublicId}`, { jar: aliceJar });
    record(response.status === 404, "GET deleted row as alice", `${response.status}`);

    response = await request("DELETE", `/api/bookmarks/${alicePublicId}`, {
      jar: aliceJar,
      csrf: aliceCsrf,
    });
    record(response.status === 404, "repeat DELETE of alice row", `${response.status}`);

    const audit = await db.query(
      'select count(*)::int as n from "BookmarkDeletionAudit" where "bookmarkPublicId" = $1',
      [alicePublicId]
    );
    record(audit.rows[0].n === 1, "exactly one audit row for the deletion", `count=${audit.rows[0].n}`);
  } finally {
    if (created.length > 0) {
      await db.query(
        'delete from "BookmarkDeletionAudit" where "bookmarkPublicId" = any($1)',
        [created]
      );
      await db.query('delete from "Bookmark" where "publicId" = any($1)', [created]);
    }
    await db.query('delete from "Bookmark" where "label" = any($1)', [[ALICE_LABEL, BOB_LABEL]]);
    await db.query('delete from "Session" where "userId" in ($1,$2)', [aliceId, bobId]);
    await db.end();
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\nTOTAL=${results.length} FAIL=${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error("FAILED: " + failure.name + " :: " + failure.detail);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("HARNESS ERROR:", error);
  process.exitCode = 1;
});
