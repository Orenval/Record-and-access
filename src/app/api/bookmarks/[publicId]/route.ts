// =============================================================================
// /api/bookmarks/[publicId] — Read and Delete One Bookmark
// =============================================================================
// Both handlers resolve ownership inside the same scoped query that touches the
// row. A missing bookmark and a bookmark owned by someone else therefore take
// exactly the same path and produce the same 404 response, so the API cannot be
// used to enumerate other users' identifiers.
//
// Check order: 401 (no session) -> 403 (CSRF, DELETE only) -> scoped query.
// The publicId is never looked up without the session's userId.

import { NextResponse } from "next/server";
import { validateSession } from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";
import { deleteBookmark, getBookmark } from "@/lib/bookmarks";

type RouteContext = { params: Promise<{ publicId: string }> };

// One constant response for "not found" and "belongs to another user".
function notFound(): NextResponse {
  return NextResponse.json(
    { success: false, message: "Bookmark not found" },
    { status: 404 }
  );
}

export async function GET(
  _request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const sessionData = await validateSession();
  if (!sessionData) {
    return NextResponse.json(
      { success: false, message: "Not authenticated" },
      { status: 401 }
    );
  }

  const { publicId } = await params;
  const bookmark = await getBookmark(sessionData.session.userId, publicId);
  if (!bookmark) {
    return notFound();
  }

  return NextResponse.json({
    success: true,
    message: "Bookmark retrieved",
    data: { bookmark },
  });
}

export async function DELETE(
  request: Request,
  { params }: RouteContext
): Promise<NextResponse> {
  const sessionData = await validateSession();
  if (!sessionData) {
    return NextResponse.json(
      { success: false, message: "Not authenticated" },
      { status: 401 }
    );
  }

  const csrfValid = await validateCsrfToken(request);
  if (!csrfValid) {
    return NextResponse.json(
      { success: false, message: "Invalid CSRF token" },
      { status: 403 }
    );
  }

  const { publicId } = await params;
  const deleted = await deleteBookmark(sessionData.session.userId, publicId);
  if (!deleted) {
    return notFound();
  }

  return NextResponse.json({
    success: true,
    message: "Bookmark deleted",
  });
}
