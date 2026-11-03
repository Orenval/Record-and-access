import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { validateSession } from "@/lib/session";
import { getBookmark } from "@/lib/bookmarks";
import { DashboardHeader } from "@/app/dashboard/dashboard-header";
import { DeleteBookmarkButton } from "./delete-bookmark-button";
import styles from "../bookmarks.module.css";

export default async function BookmarkDetailPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const sessionData = await validateSession();

  if (!sessionData) {
    redirect("/signin");
  }

  const { publicId } = await params;

  // Scoped by userId: a bookmark owned by another user is indistinguishable
  // from one that does not exist, and renders the same 404.
  const bookmark = await getBookmark(sessionData.session.userId, publicId);
  if (!bookmark) {
    notFound();
  }

  return (
    <div className="dashboard-page">
      <DashboardHeader user={sessionData.user} />
      <main className="dashboard-main">
        <div className={styles.container}>
          <div className={styles.headingRow}>
            <h1 className="dashboard-heading">Bookmark</h1>
            <Link href="/bookmarks" className="btn-secondary">
              Back to bookmarks
            </Link>
          </div>

          <section className={styles.panel}>
            <dl className={styles.detailList}>
              <div>
                <dt className={styles.detailTerm}>Label</dt>
                <dd className={styles.detailValue}>{bookmark.label}</dd>
              </div>
              <div>
                <dt className={styles.detailTerm}>URL</dt>
                <dd className={styles.detailValue}>
                  <a
                    href={bookmark.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.detailUrl}
                  >
                    {bookmark.url}
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <DeleteBookmarkButton
            publicId={bookmark.publicId}
            label={bookmark.label}
          />
        </div>
      </main>
    </div>
  );
}
