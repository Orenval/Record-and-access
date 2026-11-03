// =============================================================================
// Bookmark Data Access
// =============================================================================
// This is the ONLY module that reads or writes the Bookmark tables. Every
// function takes a userId as a required argument and puts it in the WHERE
// clause of the same query that touches the row. There is deliberately no
// fetch-then-compare path: a row belonging to another user can never be
// returned, because the ownership condition is part of the query itself.
//
// Only publicId, label, and url leave this module. The internal id and the
// owning userId are never selected or returned.

import { Prisma, PrismaClient } from "@prisma/client";
import prisma from "@/lib/prisma";

export type BookmarkSummary = {
  publicId: string;
  label: string;
  url: string;
};

export type CreateBookmarkData = {
  label: string;
  url: string;
};

// Explicit column allowlist shared by every read. Keeping this in one place
// makes it hard to accidentally expose the internal id later.
const bookmarkSelect = Prisma.validator<Prisma.BookmarkSelect>()({
  publicId: true,
  label: true,
  url: true,
});

// The optional db parameter exists only so the query-count harness can inject a
// client configured to emit query events. Application routes use the default.
type BookmarkDb = PrismaClient;

export async function listBookmarks(
  userId: string,
  db: BookmarkDb = prisma
): Promise<BookmarkSummary[]> {
  return db.bookmark.findMany({
    where: { userId },
    select: bookmarkSelect,
    orderBy: { createdAt: "desc" },
  });
}

export async function getBookmark(
  userId: string,
  publicId: string,
  db: BookmarkDb = prisma
): Promise<BookmarkSummary | null> {
  return db.bookmark.findFirst({
    where: { publicId, userId },
    select: bookmarkSelect,
  });
}

export async function createBookmark(
  userId: string,
  data: CreateBookmarkData,
  db: BookmarkDb = prisma
): Promise<BookmarkSummary> {
  return db.bookmark.create({
    data: {
      userId,
      label: data.label,
      url: data.url,
    },
    select: bookmarkSelect,
  });
}

class BookmarkDisappearedError extends Error {
  constructor() {
    super("Bookmark disappeared during delete");
    this.name = "BookmarkDisappearedError";
  }
}

// The audit row must exist before the bookmark is removed, and the removal must
// roll back if writing the audit fails. Both happen inside one transaction:
//   1. scoped lookup (existence + ownership + label in a single query),
//   2. audit insert,
//   3. scoped deleteMany.
// If the row is gone by the time the delete runs (a concurrent delete won the
// race), throwing rolls the transaction back so no orphan audit row is left.
export async function deleteBookmark(
  userId: string,
  publicId: string,
  db: BookmarkDb = prisma
): Promise<{ label: string } | null> {
  try {
    return await db.$transaction(async (tx) => {
      const bookmark = await tx.bookmark.findFirst({
        where: { publicId, userId },
        select: { label: true },
      });

      if (!bookmark) {
        return null;
      }

      await tx.bookmarkDeletionAudit.create({
        data: {
          userId,
          bookmarkPublicId: publicId,
          bookmarkLabel: bookmark.label,
        },
      });

      const deleted = await tx.bookmark.deleteMany({
        where: { publicId, userId },
      });

      if (deleted.count === 0) {
        throw new BookmarkDisappearedError();
      }

      return { label: bookmark.label };
    });
  } catch (error) {
    if (error instanceof BookmarkDisappearedError) {
      return null;
    }
    throw error;
  }
}
