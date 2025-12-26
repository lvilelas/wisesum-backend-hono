// backend-worker/src/lib/clerk.ts
import type { Context } from "hono";

export function getClerkUserId(c: Context) {
  const userId = c.get("userId");
  if (!userId) throw new Error("Missing Clerk userId on context");
  return userId as string;
}
