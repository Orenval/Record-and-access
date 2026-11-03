import Link from "next/link";
import { redirect } from "next/navigation";
import { validateSession } from "@/lib/session";
import { listBookmarks } from "@/lib/bookmarks";
import { DashboardHeader } from "@/app/dashboard/dashboard-header";
import { CreateBookmarkForm } from "./create-bookmark-form";
import styles from "./bookmarks.module.css";

export default async function BookmarksPage() {
  const sessionData = await validateSession();

  if (!sessionData) {
    redirect("/signin");
  }

  const bookmarks = await listBookmarks(sessionData.session.userId);

  return (
    <div className="dashboard-page">
      <DashboardHeader user={sessionData.user} />
      <main className="dashboard-main">
        <div className={styles.container}>
          <div className={styles.headingRow}>
            <h1 className="dashboard-heading">
              {`Welcome back, ${sessionData.user.fullName}`}
            </h1>
          </div>

          <section className={styles.panel} aria-labelledby="create-bookmark-heading">
            <h2 id="create-bookmark-heading" className={styles.panelTitle}>
              Add a bookmark
            </h2>
            <CreateBookmarkForm />
          </section>

          <section className={styles.panel} aria-labelledby="bookmark-list-heading">
            <h2 id="bookmark-list-heading" className={styles.panelTitle}>
              Your bookmarks
            </h2>
            {bookmarks.length === 0 ? (
              <p className={styles.empty}>
                No bookmarks yet. Add your first bookmark above.
              </p>
            ) : (
              <ul className={styles.list}>
                {bookmarks.map((bookmark) => (
                  <li key={bookmark.publicId}>
                    <Link
                      href={`/bookmarks/${bookmark.publicId}`}
                      className={styles.item}
                    >
                      <span className={styles.itemLabel}>{bookmark.label}</span>
                      <span className={styles.itemUrl}>{bookmark.url}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
