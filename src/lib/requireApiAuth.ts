// backend-worker/src/lib/requireApiAuth.ts
import type { MiddlewareHandler } from "hono";
import { verifyToken } from "@clerk/backend";
import { getSupabase } from "./supabaseEdge";

type Env = {
  // pode manter CLERK_SECRET_KEY se você usa em outras partes,
  // mas para validar token no edge vamos usar CLERK_JWT_KEY
  CLERK_SECRET_KEY?: string;

  CLERK_JWT_KEY: string; // ✅ PUBLIC KEY (PEM)
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

export const requireApiAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: { userId: string };
}> = async (c, next) => {
  const auth = c.req.header("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) return c.json({ message: "Unauthorized" }, 401);

  let userId: string;

  try {
    console.log("requireApiAuth loaded ✅");
console.log("has CLERK_JWT_KEY?", Boolean(c.env.CLERK_JWT_KEY));
console.log("jwtKey prefix:", (c.env.CLERK_JWT_KEY || "").slice(0, 30));
    // ✅ valida localmente com a public key (não depende de JWKS/JWK)
    const result = await verifyToken(token, { jwtKey: c.env.CLERK_JWT_KEY });
    userId = result.sub;
    if (!userId) return c.json({ message: "Unauthorized" }, 401);
  } catch (e) {
    console.error("Clerk token verify error:", e);
    return c.json({ message: "Unauthorized" }, 401);
  }

  // 1) garante usuário no banco (mantido ✅)
  const supabase = getSupabase(c.env);
  const { error } = await supabase
    .from("users")
    .upsert({ clerk_user_id: userId }, { onConflict: "clerk_user_id" });

  if (error) {
    console.error("Error upserting user:", error);
    return c.json({ message: "Failed to sync user" }, 500);
  }

  // 2) injeta userId no contexto (mantido ✅)
  c.set("userId", userId);

  await next();
};
