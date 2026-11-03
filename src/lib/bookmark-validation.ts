// =============================================================================
// Bookmark Validation (Zod)
// =============================================================================
// The API always parses incoming data with this schema; the client may reuse it
// for inline feedback, but that is only a convenience. Because a stored URL is
// rendered as a clickable link, the URL check is a security boundary: only
// http/https URLs with a hostname and no embedded credentials are accepted.
// This blocks `javascript:`, `data:`, `mailto:`, and `http://user:pass@host`
// style values.

import { z } from "zod";

export const MAX_BOOKMARK_LABEL_LENGTH = 100;
export const MAX_BOOKMARK_URL_LENGTH = 2048;

function isSafeHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (!parsed.hostname) {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }

  return true;
}

export const createBookmarkSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, "Label is required")
    .max(
      MAX_BOOKMARK_LABEL_LENGTH,
      `Label must be at most ${MAX_BOOKMARK_LABEL_LENGTH} characters`
    ),
  url: z
    .string()
    .trim()
    .min(1, "URL is required")
    .max(
      MAX_BOOKMARK_URL_LENGTH,
      `URL must be at most ${MAX_BOOKMARK_URL_LENGTH} characters`
    )
    .refine(isSafeHttpUrl, "URL must be a valid http(s) URL without credentials"),
});

export type CreateBookmarkInput = z.infer<typeof createBookmarkSchema>;
