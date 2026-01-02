import { Hono } from "hono";
import { cors } from "hono/cors";
import Stripe from "stripe";

import { billingRoute } from "./routes/billing";
import { calcRoute } from "./routes/calc";
import { pdfRoute } from "./routes/pdf";
import { estimatedQuarterlyRoute } from "./routes/estimatedQuartely";
import { reportHtmlRoute } from "./routes/report-html";
import { reportRoute } from "./routes/report";
import { accountRoute } from "./routes/account";
import { seTaxRoute } from "./routes/seTax";
import { getSupabase } from "./lib/supabaseEdge";

type Env = {
  FRONTEND_ORIGIN: string; // ex: https://wisesum.app
  FRONTEND_URL: string; // ex: https://wisesum.app

  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  STRIPE_PRICE_MONTHLY?: string;
  STRIPE_PRICE_YEARLY?: string;
  STRIPE_PRICE_ONE_TIME?: string;

  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // ...outros envs do seu projeto (clerk, etc) continuam existindo no seu env.ts
};

const app = new Hono<{ Bindings: Env }>();

function getStripe(env: Env) {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2023-08-16",
    httpClient: Stripe.createFetchHttpClient(),
  });
}

function isoFromUnixSeconds(s?: number | null) {
  if (!s) return null;
  return new Date(s * 1000).toISOString();
}

function addMonthsISO(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

function addYearsISO(years: number) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString();
}

/**
 * ✅ Stripe webhook — igual ao Express (vários eventos)
 * - Precisa ser RAW BODY
 * - NÃO usa auth
 * - Ideal ficar fora do CORS
 *
 * URL final: POST /api/billing/webhook
 */
app.post("/api/billing/webhook", async (c) => {
  console.log("WEBHOOK HIT", new Date().toISOString());

  const sig = c.req.header("stripe-signature") || c.req.header("Stripe-Signature");
  if (!sig) return c.text("Missing Stripe-Signature", 400);

  const stripe = getStripe(c.env);

  let event: Stripe.Event;
  try {
    const rawBody = await c.req.raw.text();

    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      c.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    console.error("Stripe webhook signature error:", err?.message ?? err);
    return c.text(`Webhook Error: ${err?.message ?? "invalid signature"}`, 400);
  }

  try {
    const supabase = getSupabase(c.env);

    switch (event.type) {
      /**
       * ✅ 1) checkout.session.completed
       * Mesma ideia do Express: usa metadata clerk_user_id + price_id
       * e seta premium_until baseado no price.
       */
      case "checkout.session.completed": {
        console.log("Processing checkout.session.completed");
        const session = event.data.object as Stripe.Checkout.Session;

        const clerkUserId = session.metadata?.clerk_user_id || null;
        const priceId =
          session.metadata?.price_id ||
          ((session as any).line_items?.data?.[0]?.price?.id as string | undefined) ||
          null;

        // mesma regra que você tinha:
        // monthly => +1 mês; one_time => +1 ano; yearly => +1 ano (se existir)
        let premiumUntil: string | null = null;
        if (priceId === c.env.STRIPE_PRICE_MONTHLY) premiumUntil = addMonthsISO(1);
        else if (priceId === c.env.STRIPE_PRICE_ONE_TIME) premiumUntil = addYearsISO(1);
        else if (priceId === c.env.STRIPE_PRICE_YEARLY) premiumUntil = addYearsISO(1);
        console.log("Calculated premiumUntil:", premiumUntil);
        const record: any = {
          stripe_customer_id: session.customer?.toString() ?? null,
          plan: priceId ?? "free",
          premium_until: premiumUntil,
          updated_at: new Date().toISOString(),
        };
        console.log("Upsert record:", record);
        // Express fazia:
        // - se clerk_user_id existe, upsert por clerk_user_id
        // - senão, upsert por stripe_customer_id
        if (clerkUserId) {
          record.clerk_user_id = clerkUserId;
          const { error } = await supabase.from("entitlements").upsert(record, {
            onConflict: "clerk_user_id",
          });
          if (error) {
            console.error("SUPABASE UPSERT ERROR (checkout clerk):", error);
            return c.text("Supabase upsert failed", 500);
          }
        } else if (record.stripe_customer_id) {
          const { error } = await supabase.from("entitlements").upsert(record, {
            onConflict: "stripe_customer_id",
          });
          if (error) {
            console.error("SUPABASE UPSERT ERROR (checkout customer):", error);
            return c.text("Supabase upsert failed", 500);
          }
        } else {
          console.warn("checkout.session.completed without clerk_user_id or customer");
        }

        break;
      }

      /**
       * ✅ 2) customer.subscription.*
       * No Express antigo você setava plan="premium".
       * Aqui eu seto plan=priceId quando premium pra bater com /billing/subscription.
       */
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;

        const customerId = sub.customer?.toString() ?? null;

        const isPremium = sub.status === "active" || sub.status === "trialing";
        const priceId = sub.items.data?.[0]?.price?.id ?? null;

        const premiumUntil =
          isPremium && sub.ended_at
            ? isoFromUnixSeconds(sub.ended_at)
            : null;

        const { error } = await supabase.from("entitlements").upsert(
          {
            stripe_customer_id: customerId,
            stripe_subscription_id: sub.id,
            plan: isPremium && priceId ? priceId : "free",
            premium_until: premiumUntil,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "stripe_customer_id" }
        );

        if (error) {
          console.error("SUPABASE UPSERT ERROR (subscription):", error);
          return c.text("Supabase upsert failed", 500);
        }

        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
        break;
    }

    return c.json({ received: true });
  } catch (err: any) {
    console.error("Webhook handling error:", err?.message ?? err);
    return c.text("Error processing webhook", 500);
  }
});

/**
 * ✅ CORS para o resto da API (exclui webhook)
 * ⚠️ NÃO usar "*" com credentials=true
 */
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/billing/webhook") return next();

  return cors({
    origin: (origin, ctx) => {
      if (!origin) return ctx.env.FRONTEND_ORIGIN;

      const allowed = new Set([
        ctx.env.FRONTEND_ORIGIN,
        "https://www.wisesum.app",
        "http://localhost:3000",
      ]);

      return allowed.has(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Stripe-Signature"],
    credentials: true,
  })(c, next);
});

app.options("/api/*", (c) => c.text("", 204));

app.get("/", (c) => c.json({ status: "ok" }));
app.get("/health", (c) => c.text("ok"));

// ✅ monta suas rotas reais
app.route("/api", billingRoute);
app.route("/api", calcRoute);
app.route("/api", pdfRoute);
app.route("/api", reportHtmlRoute);
app.route("/api", reportRoute);
app.route("/api", accountRoute);
app.route("/api", seTaxRoute);
app.route("/api", estimatedQuarterlyRoute);

export default app;
