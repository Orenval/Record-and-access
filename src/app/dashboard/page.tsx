import { redirect } from "next/navigation";

// Requirement 2: The /dashboard route redirects directly to /bookmarks.
export default function DashboardPage() {
  redirect("/bookmarks");
}
