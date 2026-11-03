// =============================================================================
// Bookmark Query-Count Measurement
// =============================================================================
// Measurement-only harness. It is never imported by the application.
//
// The "naive" functions below are deliberately redundant but still scoped by
// userId, so running this script cannot exercise an insecure fetch-then-compare
// pattern. They exist only to produce honest before/after numbers.
//
// Counts are taken from Prisma's `query` events on a client constructed with
// query logging. Transaction control statements (BEGIN/COMMIT) are excluded
// from the "queries" count but shown separately.
//
// Not counted: validateSession() runs before every HTTP handler and costs two
// queries of its own (session SELECT + lastActivityAt UPDATE). Those are auth
// overhead, not bookmark work, so they are excluded here and disclosed with the
// results.

import "dotenv/config";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

// Resolve the app's "@/..." imports when loading its TypeScript modules.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(
        pathToFileURL(path.join(SRC, specifier.slice(2) + ".ts")).href,
        context
      );
    }
    return nextResolve(specifier, context);
  },
});

const BOOKMARK_FIELDS = { publicId: true, label: true, url: true };
const TX_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)\b/i;

let events = [];

function resetEvents() {
  events = [];
}

function snapshot() {
  const all = [...events];
  const meaningful = all.filter((q) => !TX_CONTROL.test(q.trim()));
  return { all, meaningful };
}

function classify(sql) {
  const q = sql.replace(/\s+/g, " ").trim();
  if (/^SELECT .*\bCOUNT\(/i.test(q)) return "COUNT for empty-state check";
  if (/^INSERT INTO .*BookmarkDeletionAudit/i.test(q)) {
    return "audit INSERT (label snapshot)";
  }
  if (/^SELECT .*\bFROM .*Bookmark/i.test(q)) {
    if (q.includes('"publicId"') && q.includes('"userId"')) {
      return "scoped Bookmark SELECT (publicId + userId)";
    }
    return "Bookmark SELECT (not fully scoped)";
  }
  if (/^DELETE FROM .*Bookmark/i.test(q)) {
    if (q.includes('"publicId"') && q.includes('"userId"')) {
      return "scoped Bookmark DELETE (publicId + userId)";
    }
    return "Bookmark DELETE by internal id";
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Naive (redundant but scoped) baselines — measurement only
// ---------------------------------------------------------------------------

async function naiveListBookmarks(userId, db) {
  const total = await db.bookmark.count({ where: { userId } });
  if (total === 0) return [];
  return db.bookmark.findMany({
    where: { userId },
    select: BOOKMARK_FIELDS,
    orderBy: { createdAt: "desc" },
  });
}

async function naiveGetBookmark(userId, publicId, db) {
  const exists = await db.bookmark.findFirst({
    where: { publicId, userId },
    select: { id: true },
  });
  if (!exists) return null;

  const owned = await db.bookmark.findFirst({
    where: { publicId, userId },
    select: { id: true },
  });
  if (!owned) return null;

  return db.bookmark.findFirst({
    where: { publicId, userId },
    select: BOOKMARK_FIELDS,
  });
}

async function naiveDeleteBookmark(userId, publicId, db) {
  return db.$transaction(async (tx) => {
    const exists = await tx.bookmark.findFirst({
      where: { publicId, userId },
      select: { id: true },
    });
    if (!exists) return null;

    const owned = await tx.bookmark.findFirst({
      where: { publicId, userId },
      select: { label: true },
    });
    if (!owned) return null;

    await tx.bookmarkDeletionAudit.create({
      data: {
        userId,
        bookmarkPublicId: publicId,
        bookmarkLabel: owned.label,
      },
    });

    const deleted = await tx.bookmark.deleteMany({
      where: { publicId, userId },
    });
    if (deleted.count === 0) return null;

    return { label: owned.label };
  });
}

// Supplementary: the ownership+delete portion the PRD's 2 -> 1 target refers
// to, with the audit requirement intentionally removed.
async function naiveDeleteNoAudit(userId, publicId, db) {
  const owned = await db.bookmark.findFirst({
    where: { publicId, userId },
    select: { id: true },
  });
  if (!owned) return null;
  await db.bookmark.deleteMany({ where: { publicId, userId } });
  return true;
}

async function scopedDeleteNoAudit(userId, publicId, db) {
  const result = await db.bookmark.deleteMany({ where: { publicId, userId } });
  return result.count > 0;
}

// ---------------------------------------------------------------------------

async function measure(name, fn) {
  resetEvents();
  const result = await fn();
  const { all, meaningful } = snapshot();
  return { name, result, all, meaningful };
}

function printMeasurement(m) {
  const extra =
    m.all.length !== m.meaningful.length
      ? ` (+${m.all.length - m.meaningful.length} transaction control)`
      : "";
  console.log(`\n--- ${m.name} ---`);
  console.log(`    queries: ${m.meaningful.length}${extra}`);
  for (const q of m.meaningful) {
    console.log(`      - ${classify(q)}`);
  }
}

async function main() {
  const app = await import(pathToFileURL(path.join(SRC, "lib/bookmarks.ts")).href);
  const shared = await import(pathToFileURL(path.join(SRC, "lib/prisma.ts")).href);
  const { listBookmarks, getBookmark, createBookmark, deleteBookmark } = app;

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({
    adapter,
    log: [{ emit: "event", level: "query" }],
  });
  db.$on("query", (event) => events.push(event.query));

  const LABEL_PREFIX = "Measurement Fixture";

  const alice = await db.user.findUnique({
    where: { email: "alice@test.bookmark" },
    select: { id: true },
  });
  if (!alice) throw new Error("alice@test.bookmark not found");
  const userId = alice.id;

  async function cleanup() {
    await db.bookmarkDeletionAudit.deleteMany({
      where: { userId, bookmarkLabel: { startsWith: LABEL_PREFIX } },
    });
    await db.bookmark.deleteMany({
      where: { userId, label: { startsWith: LABEL_PREFIX } },
    });
  }

  let sequence = 0;
  async function fixture() {
    sequence += 1;
    return createBookmark(
      userId,
      {
        label: `${LABEL_PREFIX} ${sequence}`,
        url: `https://measure.example/${sequence}`,
      },
      db
    );
  }

  try {
    await cleanup();

    const base = await fixture();

    const listAfter = await measure("List — shipped", () =>
      listBookmarks(userId, db)
    );
    const listBefore = await measure("List — naive", () =>
      naiveListBookmarks(userId, db)
    );

    const detailAfter = await measure("View detail — shipped", () =>
      getBookmark(userId, base.publicId, db)
    );
    const detailBefore = await measure("View detail — naive", () =>
      naiveGetBookmark(userId, base.publicId, db)
    );

    const deleteAfterFixture = await fixture();
    const deleteAfter = await measure("Delete — shipped (audit included)", () =>
      deleteBookmark(userId, deleteAfterFixture.publicId, db)
    );

    const deleteBeforeFixture = await fixture();
    const deleteBefore = await measure("Delete — naive (audit included)", () =>
      naiveDeleteBookmark(userId, deleteBeforeFixture.publicId, db)
    );

    const noAuditBeforeFixture = await fixture();
    const noAuditBefore = await measure(
      "Delete — naive, no audit (PRD's 2 -> 1 target)",
      () => naiveDeleteNoAudit(userId, noAuditBeforeFixture.publicId, db)
    );

    const noAuditAfterFixture = await fixture();
    const noAuditAfter = await measure(
      "Delete — scoped deleteMany only, no audit",
      () => scopedDeleteNoAudit(userId, noAuditAfterFixture.publicId, db)
    );

    for (const m of [
      listAfter,
      listBefore,
      detailAfter,
      detailBefore,
      deleteAfter,
      deleteBefore,
      noAuditBefore,
      noAuditAfter,
    ]) {
      printMeasurement(m);
    }

    const rows = [
      ["List", listBefore.meaningful.length, listAfter.meaningful.length],
      ["View detail", detailBefore.meaningful.length, detailAfter.meaningful.length],
      [
        "Delete (audit included, shipped)",
        deleteBefore.meaningful.length,
        deleteAfter.meaningful.length,
      ],
      [
        "Delete (no audit, PRD target)",
        noAuditBefore.meaningful.length,
        noAuditAfter.meaningful.length,
      ],
    ];

    console.log("\n=== Query-count table (bookmark work only) ===");
    console.log("| Action | Before | After |");
    console.log("|---|---|---|");
    for (const [name, before, after] of rows) {
      console.log(`| ${name} | ${before} | ${after} |`);
    }

    console.log(
      "\nSanity: list rows=" +
        listAfter.result.length +
        ", detail ok=" +
        Boolean(detailAfter.result) +
        ", shipped delete ok=" +
        Boolean(deleteAfter.result) +
        ", naive delete ok=" +
        Boolean(deleteBefore.result)
    );
    console.log(
      "Not counted: validateSession() = 2 queries per HTTP request " +
        "(session SELECT + lastActivityAt UPDATE)."
    );
  } finally {
    await cleanup();
    await db.$disconnect();
    await shared.default.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("MEASUREMENT FAILED:", error);
    process.exit(1);
  });
