// src/routes/seTax.ts
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireApiAuth } from "../lib/requireApiAuth";
import { getSupabase } from "../lib/supabaseEdge";

// ✅ Ajuste o path conforme seu repo.
// Ex.: se o arquivo estiver em "data/federal_constants.json" na raiz,
// e este arquivo estiver em "src/routes", talvez seja "../../data/...".
import federalConstants from "../data/federal_constants.json";

const TAX_YEAR = 2025;

// ---------- Schema ----------
const filingStatusSchema = z.enum(["single", "mfj", "mfs", "hoh"]);

const seTaxInputSchema = z.object({
  netProfit: z.number().min(0),
  w2Wages: z.number().min(0).default(0),
  filingStatus: filingStatusSchema,
  // opcional (se quiser abrir no futuro)
  // taxYear: z.number().int().optional(),
});

type FilingStatus = z.infer<typeof filingStatusSchema>;

// ---------- Helpers ----------
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------- DB helpers (no mesmo estilo do seu calc.ts) ----------
async function saveSeTaxSimulation(params: {
  supabase: ReturnType<typeof getSupabase>;
  userId: string;
  taxYear: number;
  filingStatus: FilingStatus;
  netProfit: number;
  w2Wages: number;
  total: number;
}) {
  const { supabase, userId, taxYear, filingStatus, netProfit, w2Wages, total } =
    params;

  const reportSnapshot = {
    taxYear,
    filingStatus,
    netProfit,
    w2Wages,
    total,
  };

  const { data, error } = await supabase
    .from("se_tax_simulations")
    .insert({
      clerk_user_id: userId,
      tax_year: taxYear,
      filing_status: filingStatus,
      net_profit: netProfit,
      w2_wages: w2Wages,
      report_snapshot: reportSnapshot,
      report_version: 1,
      // created_at: default now()
    })
    .select("id")
    .single();

  if (error) {
    console.error("SE simulation insert error", error);
    return null;
  }

  return data?.id ? String(data.id) : null;
}


async function saveSeTaxReportSnapshot(params: {
  supabase: ReturnType<typeof getSupabase>;
  simulationId: string;
  snapshot: any;
}) {
  const { supabase, simulationId, snapshot } = params;

  const { error } = await supabase
    .from("se_tax_simulations")
    .update({
      report_snapshot: snapshot,
      report_version: 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", simulationId);

  if (error) {
    console.error("SE snapshot update error", error);
    return false;
  }
  return true;
}

// ---------- Compute using JSON ----------
function computeSelfEmploymentTax(params: {
  netProfit: number;
  w2Wages: number;
  filingStatus: FilingStatus;
  taxYear: number;
}) {
  const { netProfit, w2Wages, filingStatus, taxYear } = params;

  const C = (federalConstants as any)[String(taxYear)]?.seTax;
  if (!C) {
    throw new Error(`SE tax constants not found for tax year ${taxYear}`);
  }

  const {
    ssWageBase,
    seNetEarningsFactor,
    ssRate,
    medicareRate,
    additionalMedicareRate,
    additionalMedicareThreshold,
  } = C;

  const netEarnings = netProfit * seNetEarningsFactor;

  // SS (cap-aware)
  const ssCapRemaining = Math.max(0, ssWageBase - w2Wages);
  const ssTaxable = Math.max(0, Math.min(netEarnings, ssCapRemaining));
  const ssTax = ssTaxable * ssRate;

  // Medicare (no cap)
  const medicareTax = netEarnings * medicareRate;

  // Additional Medicare
  const threshold = additionalMedicareThreshold?.[filingStatus];
  if (typeof threshold !== "number") {
    throw new Error(`Missing additionalMedicareThreshold for ${filingStatus}`);
  }
  const combinedEarned = w2Wages + netEarnings;
  const addlTaxable = Math.max(0, combinedEarned - threshold);
  const additionalMedicareTax = addlTaxable * additionalMedicareRate;

  const seTax = ssTax + medicareTax;
  const deductibleHalf = seTax * 0.5;
  const total = seTax + additionalMedicareTax;

  return {
    taxYear,
    filingStatus,

    netProfit: round2(netProfit),
    w2Wages: round2(w2Wages),

    netEarnings: round2(netEarnings),

    ssWageBase: Number(ssWageBase),
    ssCapRemaining: round2(ssCapRemaining),
    ssTaxable: round2(ssTaxable),
    ssTax: round2(ssTax),

    medicareTax: round2(medicareTax),
    seTax: round2(seTax),
    deductibleHalf: round2(deductibleHalf),

    additionalMedicareThreshold: Number(threshold),
    additionalMedicareTax: round2(additionalMedicareTax),

    total: round2(total),
  };
}

// ---------- Route ----------
export const seTaxRoute = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

seTaxRoute.post("/calc/self-employment-tax", requireApiAuth, async (c) => {
  console.log("== /api/calc/self-employment-tax ==");
  console.log("method:", c.req.method);
  console.log("origin:", c.req.header("origin"));
  console.log("content-type:", c.req.header("content-type"));
  console.log("content-length:", c.req.header("content-length"));

  try {
    const raw = await c.req.text();
    const body = raw ? JSON.parse(raw) : null;

    const parsed = seTaxInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { message: "Invalid input", errors: parsed.error.errors },
        400
      );
    }

    const { netProfit, w2Wages, filingStatus } = parsed.data;
    const userId = c.get("userId") as string;

    const supabase = getSupabase(c.env);

    // Check entitlements (igual seu calc.ts)
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

    // Free daily limit (por tool)
    if (!isPremium) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const { count, error: countErr } = await supabase
        .from("se_tax_simulations")
        .select("*", { count: "exact", head: true })
        .eq("clerk_user_id", userId)
        .gte("created_at", today.toISOString())
        .lt("created_at", tomorrow.toISOString());

      if (countErr) {
        console.error("Count SE simulations error", countErr);
        return c.json({ message: "Failed to check daily limit" }, 500);
      }

      if ((count ?? 0) >= 1) {
        return c.json(
          { message: "Daily limit reached. Upgrade to simulate more." },
          429
        );
      }
    }

    // ✅ calcula server-side usando JSON
    const computed = computeSelfEmploymentTax({
      netProfit,
      w2Wages,
      filingStatus,
      taxYear: TAX_YEAR,
    });

    // ✅ salva simulação (best-effort)
    const simulationId =
      (await saveSeTaxSimulation({
        supabase,
        userId,
        taxYear: TAX_YEAR,
        filingStatus,
        netProfit,
        w2Wages,
        total: computed.total,
      })) ?? "";

    // ✅ retorno premium vs free (mesmo esquema do seu calc.ts)
    if (isPremium) {
      const premium = {
        tier: "premium",
        simulationId,
        ...computed,
      };

      if (simulationId) {
        await saveSeTaxReportSnapshot({
          supabase,
          simulationId,
          snapshot: premium,
        });
      }

      return c.json(premium);
    }

    // Free: retorna só o essencial
    const free = {
      tier: "free",
      simulationId,
      taxYear: computed.taxYear,
      filingStatus: computed.filingStatus,
      netProfit: computed.netProfit,
      w2Wages: computed.w2Wages,
      netEarnings: computed.netEarnings,
      seTax: computed.seTax,
      deductibleHalf: computed.deductibleHalf,
      total: computed.total,
    };

    if (simulationId) {
      await saveSeTaxReportSnapshot({
        supabase,
        simulationId,
        snapshot: free,
      });
    }

    return c.json(free);
  } catch (err: any) {
    console.error("SE calc error", err);
    return c.json(
      { message: "Failed to calculate", error: err?.message || String(err) },
      500
    );
  }
});
