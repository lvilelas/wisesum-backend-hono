import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireApiAuth } from "../lib/requireApiAuth";
import { getSupabase } from "../lib/supabaseEdge";

// ⚠️ pode usar fs internamente e quebrar no Worker.
// Vamos tentar usar, mas sem deixar isso derrubar a rota.
import { loadStateRules } from "../lib/tax/stateTaxEngine";

import {
  computeSimulation,
  buildPremiumResult,
  buildFreeResult,
  StateCode,
} from "../services/simulationService";

const TAX_YEAR = 2025;

const stateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "State must be a 2-letter code (e.g., CA, TX, NY)");

const calcInputSchema = z.object({
  w2Salary: z.number().min(0),
  income1099: z.number().min(0),
  state: stateSchema,
  expenses: z.number().min(0).default(0),
});

// ✅ salva a simulação e retorna o id
async function saveSimulation(params: {
  supabase: ReturnType<typeof getSupabase>;
  userId: string;
  w2Salary: number;
  income1099: number;
  expenses: number;
  state: StateCode;
  annualDifference: number;
}) {
  const {
    supabase,
    userId,
    w2Salary,
    income1099,
    expenses,
    state,
    annualDifference,
  } = params;

  const { error: insertError, data: insertData } = await supabase
    .from("simulations")
    .insert({
      clerk_user_id: userId,
      w2_salary: w2Salary,
      income_1099: income1099,
      state,
      expenses,
      result_winner: annualDifference >= 0 ? "1099" : "W2",
      result_difference: annualDifference,
      created_at: new Date().toISOString(),
    })
    .select("id");

  if (insertError) {
    console.error("Simulation insert error", insertError);
    return null;
  }

  return insertData?.[0]?.id ? String(insertData[0].id) : null;
}

// ✅ salva snapshot do report (best-effort)
async function saveReportSnapshot(params: {
  supabase: ReturnType<typeof getSupabase>;
  simulationId: string;
  snapshot: any;
}) {
  const { supabase, simulationId, snapshot } = params;

  const { error } = await supabase
    .from("simulations")
    .update({
      report_snapshot: snapshot,
      report_version: 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", simulationId);

  if (error) {
    console.error("Simulation snapshot update error", error);
    return false;
  }
  return true;
}

export const calcRoute = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

calcRoute.post("/calc", requireApiAuth, async (c) => {
  // logs OK (não contém secrets/tokens)
  console.log("== /api/calc ==");
  console.log("method:", c.req.method);
  console.log("origin:", c.req.header("origin"));
  console.log("content-type:", c.req.header("content-type"));
  console.log("content-length:", c.req.header("content-length"));

  try {
    // Alguns clients mandam body como string: fazemos parse robusto
    const raw = await c.req.text();
    const body = raw ? JSON.parse(raw) : null;

    const parsed = calcInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { message: "Invalid input", errors: parsed.error.errors },
        400
      );
    }

    const { w2Salary, income1099, state, expenses } = parsed.data;
    const userId = c.get("userId") as string;

    const supabase = getSupabase(c.env);

    // ✅ garante que o arquivo do estado existe (JSON individual)
    // Cloudflare Worker: se loadStateRules usar fs, isso pode dar exception.
    // Mantemos a validação, mas sem derrubar o endpoint por limitação de runtime.
    try {
      const rules = loadStateRules(TAX_YEAR, state);
      if (!rules) {
        return c.json(
          {
            message: `State rules not available for ${state} (${TAX_YEAR}). Missing file at src/lib/tax/${TAX_YEAR}/${state}.json`,
          },
          400
        );
      }
    } catch (e) {
      // Se você QUISER ser estrito e bloquear, troque por return 500/400 aqui.
      console.warn(
        "loadStateRules check skipped (likely fs not available on Worker):",
        e
      );
    }

    // Check entitlements
    const { data: entitlement, error: entitlementError } = await supabase
      .from("entitlements")
      .select("*")
      .eq("clerk_user_id", userId)
      .maybeSingle();

    if (entitlementError) {
      console.error("Entitlement fetch error", entitlementError);
      return c.json({ message: "Failed to load entitlement" }, 500);
    }

    const isPremium =
      entitlement?.premium_until &&
      new Date(entitlement.premium_until) > new Date();

    // Free daily limit
    if (!isPremium) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const { count, error: countErr } = await supabase
        .from("simulations")
        .select("*", { count: "exact", head: true })
        .eq("clerk_user_id", userId)
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString());

      if (countErr) {
        console.error("Count simulations error", countErr);
        return c.json({ message: "Failed to check daily limit" }, 500);
      }

      if ((count ?? 0) >= 1) {
        return c.json(
          { message: "Daily limit reached. Upgrade to simulate more." },
          429
        );
      }
    }

    // ✅ cálculo (IMPORTANTE: await)
    const computed = await computeSimulation({
      w2Salary,
      income1099,
      state: state as StateCode,
      expenses,
    });

    // ✅ salva a simulação (se falhar, ainda retorna resultado)
    const simulationId =
      (await saveSimulation({
        supabase,
        userId,
        w2Salary,
        income1099,
        expenses,
        state: state as StateCode,
        annualDifference: computed.annualDifference,
      })) ?? "";

    // ✅ monta resultado final
    if (isPremium) {
      const premium = buildPremiumResult({
        computed,
        state: state as StateCode,
        simulationId,
      });

      // ✅ snapshot (best-effort)
      if (simulationId) {
        await saveReportSnapshot({ supabase, simulationId, snapshot: premium });
      }

      return c.json(premium);
    }

    // Free também devolve simulationId (ajuda PDF/UX)
    const free = {
      ...buildFreeResult({ computed }),
      simulationId,
    };

    if (simulationId) {
      await saveReportSnapshot({ supabase, simulationId, snapshot: free });
    }

    return c.json(free);
  } catch (err: any) {
    console.error("Calc error", err);
    return c.json(
      { message: "Failed to calculate", error: err?.message || String(err) },
      500
    );
  }
});
