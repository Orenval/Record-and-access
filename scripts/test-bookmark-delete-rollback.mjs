// =============================================================================
// Bookmark Delete Rollback Verification
// =============================================================================
// Exercises the two failure paths that are hard to hit through the HTTP API:
//
//   1. The audit insert fails -> the transaction rolls back and the bookmark
//      must still exist with no audit row.
//   2. The row disappears between the scoped lookup and the scoped delete
//      (concurrent delete) -> deleteBookmark returns null, the transaction
//      rolls back, and no orphan audit row is left.
//
// It uses the optional `db` parameter on the data-access functions, wrapping a
// real transaction client with a proxy that injects the failure. This is
// verification-only code; the application does not import it.

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

dotenv.config({ quiet: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");

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

const { Client } = pg;
const results = [];

function record(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  ::  " + detail : ""}`);
}

async function main() {
  const app = await import(pathToFileURL(path.join(SRC, "lib/bookmarks.ts")).href);
  const { createBookmark, deleteBookmark } = app;

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  const external = new Client({ connectionString: process.env.DATABASE_URL });
  await external.connect();

  const user = await db.user.findUnique({
    where: { email: "alice@test.bookmark" },
    select: { id: true },
  });
  if (!user) throw new Error("alice@test.bookmark not found");
  const userId = user.id;

  const RUN = Date.now();
  const created = [];

  async function fixture(suffix) {
    const bookmark = await createBookmark(
      userId,
      { label: `ROLLBACK-TEST ${RUN} ${suffix}`, url: `https://rollback.example/${suffix}` },
      db
    );
    created.push(bookmark.publicId);
    return bookmark.publicId;
  }

  async function auditCount(publicId) {
    return db.bookmarkDeletionAudit.count({ where: { bookmarkPublicId: publicId } });
  }

  async function bookmarkCount(publicId) {
    return db.bookmark.count({ where: { publicId, userId } });
  }

  try {
    // --- 1. audit insert failure ------------------------------------------
    const auditFailureId = await fixture("audit-failure");
    const auditFailureDb = {
      $transaction: (callback) =>
        db.$transaction((tx) =>
          callback({
            bookmark: {
              findFirst: (args) => tx.bookmark.findFirst(args),
              deleteMany: (args) => tx.bookmark.deleteMany(args),
            },
            bookmarkDeletionAudit: {
              create: async () => {
                throw new Error("INJECTED_AUDIT_FAILURE");
              },
            },
          })
        ),
    };

    let auditFailureThrew = false;
    let auditFailureMessage = "";
    try {
      await deleteBookmark(userId, auditFailureId, auditFailureDb);
    } catch (error) {
      auditFailureThrew = true;
      auditFailureMessage = String(error?.message || error);
    }

    const auditFailureStillThere = await bookmarkCount(auditFailureId);
    const auditFailureAudits = await auditCount(auditFailureId);
    record(
      auditFailureThrew &&
        auditFailureStillThere === 1 &&
        auditFailureAudits === 0,
      "audit insert failure rolls back the delete",
      `threw=${auditFailureThrew} bookmark=${auditFailureStillThere} audit=${auditFailureAudits}`
    );
    if (!auditFailureThrew) {
      console.log("  note: deleteBookmark did not throw; injected failure was not reached");
    } else {
      console.log(`  note: propagated error: ${auditFailureMessage}`);
    }

    // --- 2. row disappears between lookup and delete -----------------------
    const raceId = await fixture("concurrent-delete");
    const raceDb = {
      $transaction: (callback) =>
        db.$transaction(async (tx) =>
          callback({
            bookmark: {
              findFirst: async (args) => {
                const row = await tx.bookmark.findFirst(args);
                if (row) {
                  await external.query(
                    'delete from "Bookmark" where "publicId" = $1 and "userId" = $2',
                    [raceId, userId]
                  );
                }
                return row;
              },
              deleteMany: (args) => tx.bookmark.deleteMany(args),
            },
            bookmarkDeletionAudit: {
              create: (args) => tx.bookmarkDeletionAudit.create(args),
            },
          })
        ),
    };

    let raceResult;
    let raceError = "";
    try {
      raceResult = await deleteBookmark(userId, raceId, raceDb);
    } catch (error) {
      raceError = String(error?.message || error);
    }

    const raceStillThere = await bookmarkCount(raceId);
    const raceAudits = await auditCount(raceId);
    record(
      raceResult === null && !raceError && raceStillThere === 0 && raceAudits === 0,
      "concurrent delete returns null and leaves no orphan audit",
      `result=${raceResult} bookmark=${raceStillThere} audit=${raceAudits}${raceError ? " error=" + raceError : ""}`
    );

    // --- 3. positive control ---------------------------------------------
    const happyId = await fixture("happy-path");
    const happy = await deleteBookmark(userId, happyId, db);
    const happyAudits = await auditCount(happyId);
    const happyStillThere = await bookmarkCount(happyId);
    record(
      happy?.label?.startsWith(`ROLLBACK-TEST ${RUN}`) &&
        happyAudits === 1 &&
        happyStillThere === 0,
      "normal delete still succeeds and writes one audit row",
      `audit=${happyAudits} bookmark=${happyStillThere}`
    );
  } finally {
    if (created.length > 0) {
      await db.bookmarkDeletionAudit.deleteMany({
        where: { bookmarkPublicId: { in: created } },
      });
      await db.bookmark.deleteMany({ where: { publicId: { in: created } } });
    }
    await external.end();
    await db.$disconnect();
  }

  const failures = results.filter((result) => !result.ok);
  console.log(`\nTOTAL=${results.length} FAIL=${failures.length}`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("ROLLBACK TEST ERROR:", error);
  process.exitCode = 1;
});
