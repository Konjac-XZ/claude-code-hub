/**
 * Next.js Instrumentation Hook
 *
 * Keep this entrypoint Edge-safe: Next.js may compile instrumentation for the
 * Edge runtime even when the actual startup work is Node-only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNodeInstrumentation } = await import("./instrumentation.node");
    await registerNodeInstrumentation();
  }
}
