// =============================================================================
// Next.js Instrumentation — Process-Lifetime Maintenance
// =============================================================================
// `register()` runs once when the server process starts (Node.js runtime).
// Currently no periodic maintenance tasks are required.

export async function register(): Promise<void> {
  // Edge runtime instances have no long-lived process for a timer.
  if (process.env.NEXT_RUNTIME === "edge") return;
}