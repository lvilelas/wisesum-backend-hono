import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireApiAuth } from "../lib/requireApiAuth";
import { getSupabase } from "../lib/supabaseEdge";
import { computeW4, buildFreeW4Result, buildPremiumW4Result } from "../services/w4Service";

/*
 * W‑4 route implementation.  This endpoint accepts a POST request with
 * the user’s inputs for the W‑4 withholding check, computes the
 * estimated tax and withholding on the server, enforces free user
 * limits and returns either a free summary result or a premium
 * detailed result depending on the user’s entitlement.  Each call is
 * recorded in the w4_calculations table to support daily limits.
 */

// Zod schema to validate and coerce request body values.  All numbers
// must be passed as raw numbers (not strings) from the client.  The
// client should handle parsing and validation of text inputs before
// posting here.
const w4InputSchema = z.object({
  annualSalary: z.number().nonnegative(),
  payFrequency: z.enum(["weekly", "biweekly", "semimonthly", "monthly"]),
  sideIncome: z.number().nonnegative().optional(),
  children: z.number().nonnegative().int(),
  dependents: z.number().nonnegative().int(),
  withholdingPerPaycheck: z.number().nonnegative(),
  filingStatus: z.enum(["single", "married", "hoh"]),
  // Optional premium fields
  spouseIncome: z.number().nonnegative().optional(),
  ytdWages: z.number().nonnegative().optional(),
  ytdWithholding: z.number().nonnegative().optional(),
  deductions: z.number().nonnegative().optional(),
  extraWithholding: z.number().nonnegative().optional(),
  remainingPayPeriods: z.number().int().positive().optional(),
  state: z.string().optional(),
});

export const w4Route = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

w4Route.post("/w4", requireApiAuth, async (c) => {
  try {
    const raw = await c.req.text();
    const body = raw ? JSON.parse(raw) : null;
    const parsed = w4InputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { message: "Invalid input", errors: parsed.error.errors },
        400,
      );
    }
    const data = parsed.data;
    const userId = c.get("userId") as string;
    const supabase = getSupabase(c.env);

    // Check user entitlement (premium) from entitlements table
    const { data: entitlement, error: entErr } = await supabase
      .from("entitlements")
      .select("premium_until")
      .eq("clerk_user_id", userId)
      .maybeSingle();
    if (entErr) {
      console.error("Entitlement fetch error", entErr);
      return c.json({ message: "Failed to load entitlement" }, 500);
    }
    const isPremium =
      entitlement?.premium_until &&
      new Date(entitlement.premium_until) > new Date();

    // Free users have a daily limit of 3 W‑4 simulations
    if (!isPremium) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const { count, error: countErr } = await supabase
        .from("w4_calculations")
        .select("*", { count: "exact", head: true })
        .eq("clerk_user_id", userId)
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString());
      if (countErr) {
        console.error("W4 count error", countErr);
        return c.json({ message: "Failed to check daily limit" }, 500);
      }
      if ((count ?? 0) >= 3) {
        return c.json(
          { message: "Daily limit reached. Upgrade to run more W‑4 checks." },
          429,
        );
      }
    }

    // Compute result on the server
    const computed = computeW4({
      annualSalary: data.annualSalary,
      payFrequency: data.payFrequency,
      sideIncome: data.sideIncome ?? 0,
      children: data.children,
      dependents: data.dependents,
      withholdingPerPaycheck: data.withholdingPerPaycheck,
      filingStatus: data.filingStatus,
      spouseIncome: data.spouseIncome ?? 0,
      ytdWages: data.ytdWages ?? 0,
      ytdWithholding: data.ytdWithholding ?? 0,
      deductions: data.deductions ?? 0,
      extraWithholding: data.extraWithholding ?? 0,
      remainingPayPeriods: data.remainingPayPeriods ?? undefined,
      state: data.state ?? undefined,
    });

    // Persist the calculation for auditing and enforcement
    const { error: insertErr, data: insertData } = await supabase
      .from("w4_calculations")
      .insert({
        clerk_user_id: userId,
        annual_salary: data.annualSalary,
        side_income: data.sideIncome ?? 0,
        children: data.children,
        dependents: data.dependents,
        pay_frequency: data.payFrequency,
        withholding_per_paycheck: data.withholdingPerPaycheck,
        filing_status: data.filingStatus,
        estimated_tax: computed.estimatedTax,
        annual_withholding: computed.annualWithholding,
        difference: computed.difference,
        spouse_income: data.spouseIncome ?? 0,
        ytd_wages: data.ytdWages ?? 0,
        ytd_withholding: data.ytdWithholding ?? 0,
        deductions: data.deductions ?? 0,
        extra_withholding: data.extraWithholding ?? 0,
        remaining_pay_periods: data.remainingPayPeriods ?? null,
        state: data.state ?? null,
        created_at: new Date().toISOString(),
      })
      .select("id");
    if (insertErr) {
      console.error("W4 insert error", insertErr);
      // do not block response due to logging failure
    }
    const calculationId = insertData?.[0]?.id ? String(insertData[0].id) : null;

    // Build response based on entitlement
    if (isPremium) {
      const result = buildPremiumW4Result({ computed });
      return c.json({ calculationId, ...result });
    }
    const result = buildFreeW4Result({ computed });
    return c.json({ calculationId, ...result });
  } catch (err: any) {
    console.error("W4 route error", err);
    return c.json(
      { message: "Failed to compute W‑4", error: err?.message ?? String(err) },
      500,
    );
  }
});