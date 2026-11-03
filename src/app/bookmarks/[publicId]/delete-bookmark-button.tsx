"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, ensureCsrfToken } from "@/lib/api-client";
import styles from "../bookmarks.module.css";

export function DeleteBookmarkButton({
  publicId,
  label,
}: {
  publicId: string;
  label: string;
}) {
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    ensureCsrfToken();
  }, []);

  const handleDelete = async () => {
    setError("");
    setIsDeleting(true);

    try {
      // apiFetch only auto-fetches a CSRF token for POST, so make sure the
      // double-submit cookie exists before issuing the DELETE.
      await ensureCsrfToken();

      const res = await apiFetch(
        `/api/bookmarks/${encodeURIComponent(publicId)}`,
        { method: "DELETE" }
      );

      if (!res.success) {
        if (res.status === 401) {
          router.push("/signin?expired=1");
          return;
        }
        if (res.status === 404) {
          router.push("/bookmarks");
          router.refresh();
          return;
        }
        if (res.status === 403) {
          setError(
            "Your security token expired. Refresh the page and try again."
          );
          return;
        }
        setError(res.message);
        return;
      }

      router.push("/bookmarks");
      router.refresh();
    } catch {
      setError("An unexpected error occurred. Please try again.");
    } finally {
      setIsDeleting(false);
    }
  };

  if (confirming) {
    return (
      <div className={styles.confirmBox} role="group" aria-label="Confirm delete">
        <p className={styles.confirmText}>
          Delete &ldquo;{label}&rdquo;? This cannot be undone.
        </p>

        {error && (
          <div className="alert-box error" role="alert">
            {error}
          </div>
        )}

        <div className={styles.confirmActions}>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? "Deleting..." : "Confirm delete"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setConfirming(false);
              setError("");
            }}
            disabled={isDeleting}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={styles.dangerButton}
      onClick={() => setConfirming(true)}
    >
      Delete bookmark
    </button>
  );
}
