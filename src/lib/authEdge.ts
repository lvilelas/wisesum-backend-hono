import type { MiddlewareHandler } from "hono";
import { verifyToken } from "@clerk/backend";
import type { Env } from "../env";
import { getSupabase } from "./supabaseEdge";

export type AuthedVars = { userId: string };

function extractBearer(req: Request) {
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  return null;
}

export const requireApiAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthedVars;
}> = async (c, next) => {
  const token = extractBearer(c.req.raw);
  if (!token) return c.json({ message: "Unauthorized" }, 401);

  try {
    const verified = await verifyToken(token, {
      jwtKey: c.env.CLERK_JWT_KEY,
      authorizedParties: [c.env.FRONTEND_URL], // opcional, mas recomendado
    });

    const userId = verified.sub;
    if (!userId) return c.json({ message: "Unauthorized" }, 401);

    // 1) garante user no banco
    const supabase = getSupabase(c.env);
    const { error } = await supabase
      .from("users")
      .upsert({ clerk_user_id: userId }, { onConflict: "clerk_user_id" });

    if (error) {
      console.error("Error upserting user:", error);
      return c.json({ message: "Failed to sync user" }, 500);
    }

    // 2) injeta no context
    c.set("userId", userId);

    await next();
  } catch (e) {
    console.error("Clerk token verify error:", e);
    return c.json({ message: "Unauthorized" }, 401);
  }
};
