import { Hono } from "hono";
import { z } from "zod";
import Stripe from "stripe";
import type { Env } from "..//env";
import { requireApiAuth } from "../lib/requireApiAuth";
import { getSupabase } from "../lib/supabaseEdge";

export const billingRoute = new Hono<{ Bindings: Env; Variables: { userId: string } }>();

function getStripe(env: Env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-08-16",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

const checkoutSchema = z.object({
  priceId: z.string().nonempty(),
  successUrl: z.string().url().nonempty(),
  cancelUrl: z.string().url().nonempty(),
});

async function getOrCreateCustomerForUser(env: Env, userId: string): Promise<string> {
  const supabase = getSupabase(env);
  const stripe = getStripe(env);

  const { data, error } = await supabase
    .from("entitlements")
    .select("stripe_customer_id")
    .eq("clerk_user_id", userId)
    .maybeSingle();

  if (error) throw error;

  if (data?.stripe_customer_id) return String(data.stripe_customer_id);

  // cria customer
  const customer = await stripe.customers.create({
    metadata: { clerk_user_id: userId },
  });

  // salva
  await supabase.from("entitlements").upsert(
    {
      clerk_user_id: userId,
      plan: "free",
      stripe_customer_id: customer.id,
    },
    { onConflict: "clerk_user_id" },
  );

  return customer.id;
}

billingRoute.post("/billing/checkout", requireApiAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parse = checkoutSchema.safeParse(body);
  if (!parse.success) {
    return c.json({ message: "Invalid input.", errors: parse.error.errors }, 400);
  }

  const { priceId, successUrl, cancelUrl } = parse.data;
  const userId = c.get("userId");

  try {
    const stripe = getStripe(c.env);
    const customerId = await getOrCreateCustomerForUser(c.env, userId);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { clerk_user_id: userId, price_id: priceId },
      subscription_data: { metadata: { clerk_user_id: userId } },
    });

    return c.json({ url: session.url });
  } catch (err: any) {
    console.error("Stripe checkout error", err);
    return c.json({ message: "Failed to create checkout session.", error: err?.message }, 500);
  }
});

billingRoute.post("/billing/portal", requireApiAuth, async (c) => {
  try {
    const userId = c.get("userId");
    const supabase = getSupabase(c.env);
    const stripe = getStripe(c.env);

    const { data: entitlement, error } = await supabase
      .from("entitlements")
      .select("*")
      .eq("clerk_user_id", userId)
      .maybeSingle();

    if (error) return c.json({ error: "Failed to load subscription." }, 500);
    if (!entitlement) return c.json({ error: "No subscription found for this user." }, 404);
    if (!entitlement.stripe_customer_id) return c.json({ error: "Missing Stripe customer ID." }, 400);

    const base = c.env.FRONTEND_URL;

    const session = await stripe.billingPortal.sessions.create({
      customer: String(entitlement.stripe_customer_id),
      return_url: `${base}/app/account`,
    });

    return c.json({ url: session.url });
  } catch (err: any) {
    console.error("Billing portal error", err);
    return c.json({ error: "Failed to create billing portal session." }, 500);
  }
});

billingRoute.get("/billing/subscription", requireApiAuth, async (c) => {
  try {
    const userId = c.get("userId");
    const supabase = getSupabase(c.env);

    const { data: entitlement, error } = await supabase
      .from("entitlements")
      .select("plan, premium_until")
      .eq("clerk_user_id", userId)
      .maybeSingle();

    if (error) return c.json({ message: "Failed to load subscription." }, 500);

    const PRICE_MAP: Record<
      string,
      { id: string; name: string; price: number; interval: "month" | "year" | "one_time" }
    > = {
      ...(c.env.STRIPE_PRICE_MONTHLY
        ? {
            [c.env.STRIPE_PRICE_MONTHLY]: {
              id: c.env.STRIPE_PRICE_MONTHLY,
              name: "Premium Monthly",
              price: 10,
              interval: "month",
            },
          }
        : {}),
      ...(c.env.STRIPE_PRICE_YEARLY
        ? {
            [c.env.STRIPE_PRICE_YEARLY]: {
              id: c.env.STRIPE_PRICE_YEARLY,
              name: "Premium Yearly",
              price: 99,
              interval: "year",
            },
          }
        : {}),
      ...(c.env.STRIPE_PRICE_ONE_TIME
        ? {
            [c.env.STRIPE_PRICE_ONE_TIME]: {
              id: c.env.STRIPE_PRICE_ONE_TIME,
              name: "Premium (One-time)",
              price: 99,
              interval: "one_time",
            },
          }
        : {}),
    };

    const planId = entitlement?.plan || "free";
    const planInfo =
      planId === "free"
        ? { id: "free", name: "Free", price: 0, interval: "month" as const }
        : (PRICE_MAP[planId] ?? { id: planId, name: "Unknown plan", price: 0, interval: "month" as const });

    return c.json({ plan: planInfo, premium_until: entitlement?.premium_until ?? null });
  } catch (err: any) {
    console.error("Subscription fetch error", err);
    return c.json({ message: "Failed to load subscription." }, 500);
  }
});

