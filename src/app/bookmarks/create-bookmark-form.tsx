"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createBookmarkSchema,
  MAX_BOOKMARK_LABEL_LENGTH,
  MAX_BOOKMARK_URL_LENGTH,
} from "@/lib/bookmark-validation";
import { apiFetch, ensureCsrfToken } from "@/lib/api-client";
import styles from "./bookmarks.module.css";

export function CreateBookmarkForm() {
  const router = useRouter();

  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    ensureCsrfToken();
  }, []);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrors({});
    setGeneralError("");
    setSuccessMessage("");

    const clientValidation = createBookmarkSchema.safeParse({ label, url });
    if (!clientValidation.success) {
      const fieldErrors: Record<string, string> = {};
      for (const issue of clientValidation.error.issues) {
        const field = issue.path[0] as string;
        if (!fieldErrors[field]) {
          fieldErrors[field] = issue.message;
        }
      }
      setErrors(fieldErrors);
      return;
    }

    setIsSaving(true);

    try {
      const res = await apiFetch("/api/bookmarks", {
        method: "POST",
        body: JSON.stringify(clientValidation.data),
      });

      if (!res.success) {
        if (res.status === 401) {
          router.push("/signin?expired=1");
          return;
        }
        if (res.errors) {
          const fieldErrors: Record<string, string> = {};
          for (const [key, msgs] of Object.entries(res.errors)) {
            fieldErrors[key] = msgs[0];
          }
          setErrors(fieldErrors);
        } else {
          setGeneralError(res.message);
        }
        return;
      }

      setLabel("");
      setUrl("");
      setSuccessMessage("Bookmark added.");
      router.refresh();
    } catch {
      setGeneralError("An unexpected error occurred. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      {generalError && (
        <div className="alert-box error" role="alert">
          {generalError}
        </div>
      )}

      {successMessage && (
        <div className="alert-box success" role="status">
          {successMessage}
        </div>
      )}

      <div className={styles.formGrid}>
        <div className="form-group">
          <label htmlFor="bookmark-label" className="form-label">
            Label
          </label>
          <input
            id="bookmark-label"
            name="label"
            type="text"
            maxLength={MAX_BOOKMARK_LABEL_LENGTH}
            required
            className={`form-input ${errors.label ? "error" : ""}`}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-invalid={errors.label ? true : undefined}
            aria-describedby={errors.label ? "bookmark-label-error" : undefined}
            placeholder="Example site"
          />
          {errors.label && (
            <span id="bookmark-label-error" className="error-text">
              {errors.label}
            </span>
          )}
        </div>

        <div className="form-group">
          <label htmlFor="bookmark-url" className="form-label">
            URL
          </label>
          <input
            id="bookmark-url"
            name="url"
            type="url"
            maxLength={MAX_BOOKMARK_URL_LENGTH}
            required
            className={`form-input ${errors.url ? "error" : ""}`}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={errors.url ? true : undefined}
            aria-describedby={errors.url ? "bookmark-url-error" : undefined}
            placeholder="https://example.com"
          />
          {errors.url && (
            <span id="bookmark-url-error" className="error-text">
              {errors.url}
            </span>
          )}
        </div>
      </div>

      <button type="submit" className="btn-primary" disabled={isSaving}>
        {isSaving ? "Adding..." : "Add bookmark"}
      </button>
    </form>
  );
}
