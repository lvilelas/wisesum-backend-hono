import { Hono } from "hono";
import Stripe from "stripe";
import type { Env } from "..//env";
import { requireApiAuth } from "../lib/requireApiAuth";
import { getSupabase } from "../lib/supabaseEdge";

export const accountRoute = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

function getStripe(env: Env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-08-16",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

const ACTIVE_STATUSES = new Set<Stripe.Subscription.Status>([
  "active",
  "trialing",
  "past_due",
  "unpaid",
]);

async function hasActiveSubscription(env: Env, customerId: string): Promise<boolean> {
  const stripe = getStripe(env);
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 20,
  });
  return subs.data.some((s) => ACTIVE_STATUSES.has(s.status));
}

async function deleteClerkUser(env: Env, userId: string) {
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to delete Clerk user: ${res.status} ${txt}`);
  }
}

accountRoute.post("/account/delete", requireApiAuth, async (c) => {
  try {
    const userId = c.get("userId");
    const supabase = getSupabase(c.env);

    const { data: entitlement, error } = await supabase
      .from("entitlements")
      .select("*")
      .eq("clerk_user_id", userId)
      .maybeSingle();

    if (error) {
      console.error("Entitlement fetch error", error);
      return c.json({ message: "Failed to load subscription information." }, 500);
    }

    const customerId = entitlement?.stripe_customer_id?.toString() || null;
    if (customerId) {
      const active = await hasActiveSubscription(c.env, customerId);
      if (active) {
        return c.json(
          { message: "You have an active subscription. Please cancel your subscription before deleting your account." },
          409,
        );
      }
    }

    await supabase.from("entitlements").delete().eq("clerk_user_id", userId);

    await deleteClerkUser(c.env, userId);

    return c.json({ ok: true });
  } catch (err: any) {
    console.error("Account deletion error", err);
    return c.json({ message: err?.message || "Failed to delete account." }, 500);
  }
});
