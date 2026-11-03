// =============================================================================
// /api/bookmarks — List and Create
// =============================================================================
// GET  : returns only the signed-in user's bookmarks, newest first.
// POST : creates a bookmark owned by the signed-in user.
//
// Check order is deliberate and uniform across the bookmark API:
//   401 (no session) -> 403 (CSRF failure) -> 400 (validation) -> data access.
// The userId always comes from the validated session, never from the body.

import { NextResponse } from "next/server";
import { validateSession } from "@/lib/session";
import { validateCsrfToken } from "@/lib/csrf";
import { createBookmarkSchema } from "@/lib/bookmark-validation";
import { createBookmark, listBookmarks } from "@/lib/bookmarks";

function validationErrors(
  issues: { path: PropertyKey[]; message: string }[]
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const issue of issues) {
    const field = issue.path.join(".");
    if (!errors[field]) errors[field] = [];
    errors[field].push(issue.message);
  }
  return errors;
}

export async function GET(): Promise<NextResponse> {
  const sessionData = await validateSession();
  if (!sessionData) {
    return NextResponse.json(
      { success: false, message: "Not authenticated" },
      { status: 401 }
    );
  }

  const bookmarks = await listBookmarks(sessionData.session.userId);

  return NextResponse.json({
    success: true,
    message: "Bookmarks retrieved",
    data: { bookmarks },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid request body" },
      { status: 400 }
    );
  }

  const validation = createBookmarkSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      {
        success: false,
        message: "Validation failed",
        errors: validationErrors(validation.error.issues),
      },
      { status: 400 }
    );
  }

  const bookmark = await createBookmark(
    sessionData.session.userId,
    validation.data
  );

  return NextResponse.json(
    {
      success: true,
      message: "Bookmark created",
      data: { bookmark },
    },
    { status: 201 }
  );
}
