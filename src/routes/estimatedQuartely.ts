import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireApiAuth } from "../lib/requireApiAuth";
import { getSupabase } from "../lib/supabaseEdge";

// ✅ ÚNICA fonte de dados (mesmo pro Free e Premium)
// Preferir JSON imports com assert em ESM/Workers
import federalConstants from "../data/federal_constants.json" assert { type: "json" };
import statesData from "../data/compiled_2026_all_states.json" assert { type: "json" }; // legacy brackets source
import { loadStateBaseRules, applyStateConformity, applyStateDeductions } from "../lib/tax/stateBaseCalc";
import { calcStateTaxFromTaxableBase } from "../lib/tax/stateTaxEngine";
import federal2026 from "../data/federal/2026.json" assert { type: "json" };

type FilingStatus = "single" | "mfj" | "hoh" | "mfs";
type Strategy = "safeHarbor" | "currentYear";

const TAX_YEAR = 2026;

export const estimatedQuarterlyRoute = new Hono<{
  Bindings: Env;
  Variables: { userId: string };
}>();

/* ===============================
 Helpers
================================ */

function clamp0(n: number) {
  return n < 0 ? 0 : n;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function round0(n: number) {
  return Math.round(n);
}

// ✅ pega premium constants do MESMO federal2026.json
function premium() {
  // 2026.json stores premium constants at the top-level (qbi, niit, ctc, eitc, itemized, ca, etc.)
  return (federal2026 as any) ?? {};
}

type SeTaxConstants = {
  ssWageBase: number;
  seNetEarningsFactor: number; // 0.9235
  ssRate: number; // 0.124 (SE portion)
  medicareRate: number; // 0.029 (SE portion)
  additionalMedicareRate: number; // 0.009
  additionalMedicareThreshold: Record<FilingStatus, number>;
};

type FederalConstantsFile = Record<
  string,
  {
    seTax?: Partial<SeTaxConstants>;
  }
>;

function getSeTaxConstants(taxYear: number): SeTaxConstants {
  const file = federalConstants as unknown as FederalConstantsFile;
  const C = file[String(taxYear)]?.seTax;
  if (!C) throw new Error(`SE tax constants not found for tax year ${taxYear}`);

  const ssWageBase = Number(C.ssWageBase);
  const seNetEarningsFactor = Number(C.seNetEarningsFactor);
  const ssRate = Number(C.ssRate);
  const medicareRate = Number(C.medicareRate);
  const additionalMedicareRate = Number(C.additionalMedicareRate);

  if (
    !Number.isFinite(ssWageBase) ||
    !Number.isFinite(seNetEarningsFactor) ||
    !Number.isFinite(ssRate) ||
    !Number.isFinite(medicareRate) ||
    !Number.isFinite(additionalMedicareRate)
  ) {
    throw new Error(`Invalid SE tax constants for year ${taxYear}`);
  }

  const t = C.additionalMedicareThreshold as any;
  if (!t || typeof t !== "object") {
    throw new Error(`Missing additionalMedicareThreshold map for year ${taxYear}`);
  }

  for (const s of ["single", "mfj", "mfs", "hoh"] as FilingStatus[]) {
    const v = Number(t[s]);
    if (!Number.isFinite(v)) {
      throw new Error(`Missing additionalMedicareThreshold for ${s} in ${taxYear}`);
    }
  }

  return {
    ssWageBase,
    seNetEarningsFactor,
    ssRate,
    medicareRate,
    additionalMedicareRate,
    additionalMedicareThreshold: t as Record<FilingStatus, number>,
  };
}

/**
 * ✅ SE Tax (corrigido):
 * - Social Security considera wage base restante após W-2 wages
 * - Additional Medicare considera earned income combinado (W-2 + netEarnings)
 */
function calcSelfEmploymentTax(p: {
  filingStatus: FilingStatus;
  netProfitAnnual: number;
  w2WagesAnnual: number;
}) {
  const { filingStatus } = p;

  const netProfit = clamp0(Number(p.netProfitAnnual ?? 0));
  const w2Wages = clamp0(Number(p.w2WagesAnnual ?? 0));

  const se = getSeTaxConstants(TAX_YEAR);

  const netEarnings = netProfit * se.seNetEarningsFactor;

  // SS portion (cap-aware with W-2 wages)
  const ssCapRemaining = Math.max(0, se.ssWageBase - w2Wages);
  const ssTaxable = Math.max(0, Math.min(netEarnings, ssCapRemaining));
  const ssTax = ssTaxable * se.ssRate;

  // Medicare portion (no cap)
  const medicareTax = netEarnings * se.medicareRate;

  // Additional Medicare (combined earned)
  const threshold = se.additionalMedicareThreshold[filingStatus];
  const combinedEarned = w2Wages + netEarnings;
  const addlTaxable = Math.max(0, combinedEarned - threshold);
  const additional = addlTaxable * se.additionalMedicareRate;

  return {
    netEarnings: round2(netEarnings),
    ssTax: round2(ssTax),
    medicareTax: round2(medicareTax),
    additionalMedicareTax: round2(additional),
    total: round2(ssTax + medicareTax + additional),
  };
}

function calcTaxFromBrackets(taxableIncome: number, filingStatus: FilingStatus) {
  const brackets = (federal2026 as any).brackets?.[filingStatus] as
    | Array<{ upTo: number | null; rate: number }>
    | undefined;

  if (!brackets?.length) return 0;

  let tax = 0;
  let prev = 0;

  for (const b of brackets) {
    const upTo = b.upTo ?? Infinity;
    const amount = clamp0(Math.min(taxableIncome, upTo) - prev);
    tax += amount * Number(b.rate ?? 0);
    prev = upTo;
    if (taxableIncome <= upTo) break;
  }

  return round2(tax);
}

function getStandardDeduction(filingStatus: FilingStatus) {
  return Number((federal2026 as any).standardDeduction?.[filingStatus] ?? 0);
}


function calcStateIncomeTax(args: {
  year: number;
  state: string;
  filingStatus: FilingStatus;
  federalAGI: number;
  input: Record<string, any>;
  useItemized?: boolean;
}) {
  const { year, state, filingStatus, federalAGI, input, useItemized = false } = args;

  // If state has no income tax, short-circuit quickly using the brackets table
  const row = (statesData as any)[state];
  if (row && row.hasIncomeTax === false) return 0;

  const baseRules = loadStateBaseRules(year, state);
  const conformity = applyStateConformity(federalAGI, baseRules, {
    year,
    state,
    filingStatus,
    input,
  });

  const deductions = applyStateDeductions(conformity.value, baseRules, {
    year,
    state,
    filingStatus,
    input,
    federalAGI,
    useItemized,
  });

  return calcStateTaxFromTaxableBase({
    year,
    state,
    filingStatus,
    taxableBase: deductions.value,
  }).tax;
}


/** ---------- Premium: Itemized (SALT cap) ---------- */
function calcItemizedDeduction(p: {
  saltPaid: number;
  mortgageInterest: number;
  charity: number;
  otherItemized: number;
}) {
  const saltCap = Number(premium()?.itemized?.saltCap ?? 0);
  const saltDed = Math.min(clamp0(p.saltPaid), saltCap);

  return round2(
    clamp0(saltDed) +
      clamp0(p.mortgageInterest) +
      clamp0(p.charity) +
      clamp0(p.otherItemized)
  );
}

/** ---------- Premium: QBI ---------- */
function calcQbiDeduction(p: {
  filingStatus: FilingStatus;
  qbiBase: number; // qualified business income (simplified proxy)
  taxableBeforeQbi: number;
  netCapitalGains: number;

  // QBI wage/UBIA tests + SSTB
  businessType: "nonSstb" | "sstb";
  w2Wages: number;
  ubia: number;
}) {
  const q = premium()?.qbi;
  if (!q) return 0;

  const rate = Number(q.rate ?? 0.2);

  // Thresholds + phaseout range (must come from JSON; fallbacks are standard amounts)
  const threshold = Number(q.threshold?.[p.filingStatus] ?? 0);

  // IRS phaseout range: MFJ 100k; others 50k (MFS is 50k in practice)
  const phaseoutRange =
    Number(q.phaseoutRange?.[p.filingStatus] ?? 0) ||
    (p.filingStatus === "mfj" ? 100000 : 50000);

  const baseQbi = clamp0(p.qbiBase);

  // 20% of taxable income (minus net capital gains)
  const taxableLimitBase = clamp0(p.taxableBeforeQbi - clamp0(p.netCapitalGains));
  const taxableLimit = round2(taxableLimitBase * rate);

  // Tentative (pre wage/UBIA limit)
  const tentative = round2(baseQbi * rate);

  // If below threshold, no wage/UBIA limit and no SSTB disallowance
  if (p.taxableBeforeQbi <= threshold || phaseoutRange <= 0) {
    return round2(Math.min(tentative, taxableLimit));
  }

  const upper = threshold + phaseoutRange;
  const withinPhaseout = p.taxableBeforeQbi < upper;
  const excess = clamp0(p.taxableBeforeQbi - threshold);
  const ratio = withinPhaseout ? excess / phaseoutRange : 1;

  // Wage/UBIA limit (full)
  const w2 = clamp0(p.w2Wages);
  const ubia = clamp0(p.ubia);
  const wageLimit = round2(
    Math.max(0.5 * w2, 0.25 * w2 + 0.025 * ubia)
  );

  // SSTB: phase-out the entire deduction (and reduce wages/UBIA) over the same range
  if (p.businessType === "sstb") {
    if (!withinPhaseout) return 0;

    const factor = 1 - ratio; // remaining allowed portion
    const adjQbi = round2(baseQbi * factor);
    const adjW2 = round2(w2 * factor);
    const adjUbia = round2(ubia * factor);

    const adjTentative = round2(adjQbi * rate);
    const adjWageLimit = round2(
      Math.max(0.5 * adjW2, 0.25 * adjW2 + 0.025 * adjUbia)
    );

    return round2(Math.min(adjTentative, adjWageLimit, taxableLimit));
  }

  // Non-SSTB: wage/UBIA limitation phases in over the range
  // If wage limit >= tentative, no reduction.
  const fullLimited = round2(Math.min(tentative, wageLimit));

  let phased = fullLimited;
  if (wageLimit < tentative && withinPhaseout) {
    // Reduction = ratio * (tentative - wageLimit)
    phased = round2(tentative - ratio * (tentative - wageLimit));
  } else if (wageLimit < tentative && !withinPhaseout) {
    phased = fullLimited; // fully limited above upper bound
  }

  return round2(Math.min(phased, taxableLimit));
}
/** ---------- Premium: NIIT ---------- */
function calcNiit(p: {
  filingStatus: FilingStatus;
  magi: number;
  netInvestmentIncome: number;
}) {
  const n = premium()?.niit;
  if (!n) return 0;

  const rate = Number(n.rate ?? 0.038);
  const threshold = Number(n.threshold?.[p.filingStatus] ?? 0);

  const excess = clamp0(p.magi - threshold);
  const base = Math.min(clamp0(p.netInvestmentIncome), excess);
  return round2(base * rate);
}

/** ---------- Premium: CTC/ODC ---------- */
function calcChildCredits(p: {
  filingStatus: FilingStatus;
  magi: number;
  federalTaxBeforeCredits: number;
  qualifyingChildren: number;
  otherDependents: number;
}) {
  const c = premium()?.ctc;
  if (!c) {
    return {
      ctcNonRefundableUsed: 0,
      ctcRefundable: 0,
      totalCreditsApplied: 0,
      notes: ["CTC constants missing."],
    };
  }

  const perChild = Number(c.perQualifyingChild ?? 0);
  const perOtherDep = Number(c.perOtherDependent ?? 0);

  const phaseStart = Number(c.phaseoutStart?.[p.filingStatus] ?? 0);
  const phaseStep = Number(c.phaseoutStep ?? 1000);
  const phaseAmtPerStep = Number(c.phaseoutAmountPerStep ?? 50);

  const maxRefundablePerChild = Number(c.maxRefundablePerChild ?? 0);

  const baseCredit =
    clamp0(p.qualifyingChildren) * perChild +
    clamp0(p.otherDependents) * perOtherDep;

  const over = clamp0(p.magi - phaseStart);
  const steps = phaseStep > 0 ? Math.ceil(over / phaseStep) : 0;
  const phaseout = steps * phaseAmtPerStep;

  const afterPhase = clamp0(baseCredit - phaseout);

  const maxRefundable = clamp0(p.qualifyingChildren) * maxRefundablePerChild;

  const nonRefundableLimit = clamp0(p.federalTaxBeforeCredits);
  const nonRefundableUsed = Math.min(afterPhase, nonRefundableLimit);

  const remainingCredit = clamp0(afterPhase - nonRefundableUsed);
  const refundable = Math.min(remainingCredit, maxRefundable);

  return {
    ctcNonRefundableUsed: round2(nonRefundableUsed),
    ctcRefundable: round2(refundable),
    totalCreditsApplied: round2(nonRefundableUsed + refundable),
    notes: ["CTC/ODC computed with simplified refundable logic (ACTC cap)."],
  };
}

/** ---------- Premium: EITC ---------- */
function calcEitc(p: {
  filingStatus: FilingStatus;
  earnedIncome: number;
  agi: number;
  children: number;
  investmentIncome: number;
}) {
  const e = premium()?.eitc;
  if (!e) return { credit: 0, note: "EITC constants missing." };

  const invLimit = Number(e.investmentIncomeLimit ?? 0);
  if (p.investmentIncome > invLimit) {
    return { credit: 0, note: "Investment income too high for EITC." };
  }

  const kids = Math.min(3, Math.max(0, Math.floor(p.children)));
  const key = `${p.filingStatus}_${kids}`;

  const row = e.table?.[key];
  if (!row) return { credit: 0, note: "EITC table row missing." };

  const phaseInRate = Number(row.phaseInRate ?? 0);
  const maxCredit = Number(row.maxCredit ?? 0);
  const phaseOutStart = Number(row.phaseOutStart ?? 0);
  const phaseOutRate = Number(row.phaseOutRate ?? 0);

  const baseIncome = Math.min(p.earnedIncome, p.agi);

  const creditPhaseIn = Math.min(maxCredit, baseIncome * phaseInRate);

  const over = clamp0(baseIncome - phaseOutStart);
  const phaseOut = over * phaseOutRate;

  return {
    credit: round2(clamp0(creditPhaseIn - phaseOut)),
    note: "EITC computed from table.",
  };
}

/** ---------- Premium: CA credits ---------- */
function calcCaCredits(p: {
  state: string;
  earnedIncome: number;
  qualifyingChildren: number;
  hasYoungChild: boolean;
}) {
  if (p.state !== "CA") return { caCredits: 0, notes: [] as string[] };

  const ca = premium()?.ca;
  if (!ca) return { caCredits: 0, notes: ["CA constants missing."] };

  // CalEITC table per kids
  let caleitc = 0;
  const kids = Math.min(3, Math.max(0, Math.floor(p.qualifyingChildren)));
  const row = ca.calEitcTable?.[String(kids)];
  if (row) {
    const maxCredit = Number(row.maxCredit ?? 0);
    const phaseOutStart = Number(row.phaseOutStart ?? 0);
    const phaseOutRate = Number(row.phaseOutRate ?? 0);

    const over = clamp0(p.earnedIncome - phaseOutStart);
    caleitc = clamp0(maxCredit - over * phaseOutRate);
  }

  // YCTC
  let yctc = 0;
  if (p.hasYoungChild) {
    const y = ca.yctc;
    const amount = Number(y?.amount ?? 0);
    const incomeLimit = Number(y?.incomeLimit ?? 0);
    if (incomeLimit <= 0 || p.earnedIncome <= incomeLimit) yctc = amount;
  }

  return {
    caCredits: round2(caleitc + yctc),
    notes: ["CA credits computed using simplified CalEITC + YCTC."],
  };
}

/* ===============================
 Validation
================================ */

const stateSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, "State must be a 2-letter code (e.g., CA, TX, NY)");

const filingSchema = z.enum(["single", "mfj", "hoh", "mfs"]);

const inputSchema = z.object({
  filingStatus: filingSchema,
  state: stateSchema,

  // Free inputs
  netProfitAnnual: z.number().min(0),
  otherIncomeAnnual: z.number().min(0).optional().default(0),
  withholdingAnnual: z.number().min(0).optional().default(0),

  // Premium: Safe Harbor
  priorYearTotalTax: z.number().min(0).optional(),
  priorYearAgi: z.number().min(0).optional(),
  strategy: z.enum(["safeHarbor", "currentYear"]).optional(),

  // Premium extras
  w2WagesAnnual: z.number().min(0).optional().default(0),
  interestIncomeAnnual: z.number().min(0).optional().default(0),
  dividendIncomeAnnual: z.number().min(0).optional().default(0),
  capitalGainsAnnual: z.number().min(0).optional().default(0),

  // Premium: NIIT (optional adjustments)
  netInvestmentIncomeAdjustmentsAnnual: z.number().min(0).optional().default(0),

  // Premium: QBI (Section 199A)
  qbiBusinessType: z.enum(["nonSstb", "sstb"]).optional().default("nonSstb"),
  qbiW2WagesAnnual: z.number().min(0).optional().default(0),
  qbiQualifiedPropertyUbiaAnnual: z.number().min(0).optional().default(0),


  hsaContributionAnnual: z.number().min(0).optional().default(0),
  iraContributionAnnual: z.number().min(0).optional().default(0),
  solo401kEmployeeAnnual: z.number().min(0).optional().default(0),
  solo401kEmployerAnnual: z.number().min(0).optional().default(0),
  otherAdjustmentsAnnual: z.number().min(0).optional().default(0),

  useItemized: z.boolean().optional().default(false),
  itemizedSaltPaidAnnual: z.number().min(0).optional().default(0),
  itemizedMortgageInterestAnnual: z.number().min(0).optional().default(0),
  itemizedCharityAnnual: z.number().min(0).optional().default(0),
  itemizedOtherAnnual: z.number().min(0).optional().default(0),

  qualifyingChildren: z.number().min(0).optional().default(0),
  otherDependents: z.number().min(0).optional().default(0),

  caHasYoungChild: z.boolean().optional().default(false),
});

function hasAnyPremiumFields(body: any) {
  if (!body || typeof body !== "object") return false;

  const premiumKeys = [
    "w2WagesAnnual",
    "interestIncomeAnnual",
    "dividendIncomeAnnual",
    "capitalGainsAnnual",
    "netInvestmentIncomeAdjustmentsAnnual",
    "qbiBusinessType",
    "qbiW2WagesAnnual",
    "qbiQualifiedPropertyUbiaAnnual",
    "hsaContributionAnnual",
    "iraContributionAnnual",
    "solo401kEmployeeAnnual",
    "solo401kEmployerAnnual",
    "otherAdjustmentsAnnual",
    "useItemized",
    "itemizedSaltPaidAnnual",
    "itemizedMortgageInterestAnnual",
    "itemizedCharityAnnual",
    "itemizedOtherAnnual",
    "qualifyingChildren",
    "otherDependents",
    "caHasYoungChild",
    "priorYearTotalTax",
    "priorYearAgi",
    "strategy",
  ];

  return premiumKeys.some((k) => k in body);
}

/* ===============================
 Safe Harbor helper
================================ */

/**
 * ✅ Safe Harbor multiplier:
 * - 100% prior-year total tax normally
 * - 110% if prior-year AGI > 150k (most statuses)
 * - 110% if filingStatus === "mfs" and AGI > 75k
 *
 * (Still simplified but correct thresholds.)
 */
function safeHarborMultiplier(filingStatus: FilingStatus, priorYearAgi?: number) {
  const agi = Number(priorYearAgi ?? 0);
  if (!Number.isFinite(agi) || agi <= 0) return 1.0;

  const threshold = filingStatus === "mfs" ? 75_000 : 150_000;
  return agi > threshold ? 1.1 : 1.0;
}

/* ===============================
 Route
================================ */

estimatedQuarterlyRoute.post(
  "/calc/estimated-quarterly",
  requireApiAuth,
  async (c) => {
    console.log("== /api/calc/estimated-quarterly ==");

    try {
      const raw = await c.req.text();
      const body = raw ? JSON.parse(raw) : null;

      const parsed = inputSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { message: "Invalid input", errors: parsed.error.errors },
          400
        );
      }

      const {
        filingStatus,
        state,
        netProfitAnnual,
        otherIncomeAnnual,
        withholdingAnnual,

        priorYearTotalTax,
        priorYearAgi,

        w2WagesAnnual,
        interestIncomeAnnual,
        dividendIncomeAnnual,
        capitalGainsAnnual,

        hsaContributionAnnual,
        iraContributionAnnual,
        solo401kEmployeeAnnual,
        solo401kEmployerAnnual,
        otherAdjustmentsAnnual,

        useItemized,
        itemizedSaltPaidAnnual,
        itemizedMortgageInterestAnnual,
        itemizedCharityAnnual,
        itemizedOtherAnnual,

        qualifyingChildren,
        otherDependents,
        caHasYoungChild,

        // Premium: NIIT/QBI
        netInvestmentIncomeAdjustmentsAnnual,
        qbiBusinessType,
        qbiW2WagesAnnual,
        qbiQualifiedPropertyUbiaAnnual,
      } = parsed.data;

      const strategy: Strategy = parsed.data.strategy ?? "currentYear";

      const userId = c.get("userId") as string;
      const supabase = getSupabase(c.env);

      // Entitlements
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

      // 🔒 Se mandou campos premium e não é premium -> 403
      if (!isPremium && hasAnyPremiumFields(body)) {
        return c.json({ message: "Premium required." }, 403);
      }

      // Free daily limit — 1 por dia
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

      // ============================
      // 1) Income
      // ============================
      const investmentIncomeGross = clamp0(
        interestIncomeAnnual + dividendIncomeAnnual + capitalGainsAnnual
      );

      // NIIT uses "net investment income" which we simplify as (gross investment income - investment adjustments).
      // IMPORTANT: these adjustments should NOT reduce AGI in this MVP; they only reduce the NIIT base.
      const netInvestmentIncomeForNiit = clamp0(
        investmentIncomeGross - netInvestmentIncomeAdjustmentsAnnual
      );

      const earnedIncome = clamp0(netProfitAnnual + w2WagesAnnual);

      const grossIncome = clamp0(
        netProfitAnnual + w2WagesAnnual + otherIncomeAnnual + investmentIncomeGross
      );

      // ============================
      // 2) SE tax + above-the-line
      // ============================
      const se = calcSelfEmploymentTax({
        filingStatus,
        netProfitAnnual,
        w2WagesAnnual,
      });

      // Deduction is half of SS+Medicare portion (NOT including additional Medicare).
      // Here we approximate using total SE (including addl) / 2 would slightly over-deduct.
      // We'll follow common treatment: deductibleHalf is half of (SS + Medicare).
      const deductibleHalf = round2((se.ssTax + se.medicareTax) * 0.5);


      const aboveLineDeductions = round2(
        deductibleHalf +
          clamp0(hsaContributionAnnual) +
          clamp0(iraContributionAnnual) +
          clamp0(solo401kEmployeeAnnual) +
          clamp0(solo401kEmployerAnnual) +
          clamp0(otherAdjustmentsAnnual)
      );

      const agi = round2(clamp0(grossIncome - aboveLineDeductions));

      // ============================
      // 3) Deductions
      // ============================
      const standardDeduction = getStandardDeduction(filingStatus);

      const itemizedDeduction = calcItemizedDeduction({
        saltPaid: itemizedSaltPaidAnnual,
        mortgageInterest: itemizedMortgageInterestAnnual,
        charity: itemizedCharityAnnual,
        otherItemized: itemizedOtherAnnual,
      });

      const deduction = isPremium
        ? useItemized
          ? Math.max(itemizedDeduction, standardDeduction)
          : standardDeduction
        : standardDeduction;

      const taxableBeforeQbi = round2(clamp0(agi - deduction));

      // ============================
      // 4) QBI (premium)
      // ============================
      const qbiBase = isPremium
        ? clamp0(
            netProfitAnnual -
              deductibleHalf -
              solo401kEmployeeAnnual -
              solo401kEmployerAnnual -
              hsaContributionAnnual -
              iraContributionAnnual
          )
        : 0;

      const qbiDeduction = isPremium
        ? calcQbiDeduction({
            filingStatus,
            qbiBase,
            taxableBeforeQbi,
            netCapitalGains: capitalGainsAnnual,
            businessType: qbiBusinessType,
            w2Wages: qbiW2WagesAnnual,
            ubia: qbiQualifiedPropertyUbiaAnnual,
          })
        : 0;

      const taxableIncomeFederal = round2(clamp0(taxableBeforeQbi - qbiDeduction));

      // ============================
      // 5) Federal tax
      // ============================
      const federalIncomeTaxBeforeCredits = calcTaxFromBrackets(
        taxableIncomeFederal,
        filingStatus
      );

      const niitTax = isPremium
        ? calcNiit({
            filingStatus,
            magi: agi,
            netInvestmentIncome: netInvestmentIncomeForNiit,
          })
        : 0;

      const ctc = isPremium
        ? calcChildCredits({
            filingStatus,
            magi: agi,
            federalTaxBeforeCredits: federalIncomeTaxBeforeCredits,
            qualifyingChildren,
            otherDependents,
          })
        : {
            ctcNonRefundableUsed: 0,
            ctcRefundable: 0,
            totalCreditsApplied: 0,
            notes: [] as string[],
          };

      const eitc = isPremium
        ? calcEitc({
            filingStatus,
            earnedIncome,
            agi,
            children: qualifyingChildren,
            investmentIncome: investmentIncomeGross,
          })
        : { credit: 0, note: "" };

      const federalAfterNonRefundable = round2(
        clamp0(federalIncomeTaxBeforeCredits - ctc.ctcNonRefundableUsed)
      );

      const refundableCredits = round2(clamp0(eitc.credit) + clamp0(ctc.ctcRefundable));

      const federalIncomeTaxAfterCredits = round2(
        clamp0(federalAfterNonRefundable - refundableCredits)
      );

      const federalTotal = round2(clamp0(federalIncomeTaxAfterCredits + niitTax));

      // ============================
      // 6) State tax (+ CA credits premium)
      // ============================
      let stateIncomeTax = calcStateIncomeTax({ year: TAX_YEAR, state, filingStatus, federalAGI: agi, input: body, useItemized });

      const caCredits = isPremium
        ? calcCaCredits({
            state,
            earnedIncome,
            qualifyingChildren,
            hasYoungChild: caHasYoungChild,
          })
        : { caCredits: 0, notes: [] as string[] };

      if (isPremium && state === "CA") {
        stateIncomeTax = round2(clamp0(stateIncomeTax - caCredits.caCredits));
      }

      // ============================
      // 7) Totals
      // ============================
      const seTax = se.total;
      const totalTax = round2(seTax + federalTotal + stateIncomeTax);
      const remainingAfterWithholding = round2(clamp0(totalTax - withholdingAnnual));

      // ============================
      // 8) Quarterly
      // ============================
      let quarterly = [
        {
          label: "Q1" as const,
          dueDateLabel: "Apr 15",
          amount: round2(remainingAfterWithholding / 4),
        },
        {
          label: "Q2" as const,
          dueDateLabel: "Jun 15",
          amount: round2(remainingAfterWithholding / 4),
        },
        {
          label: "Q3" as const,
          dueDateLabel: "Sep 15",
          amount: round2(remainingAfterWithholding / 4),
        },
        {
          label: "Q4" as const,
          dueDateLabel: "Jan 15",
          amount: round2(remainingAfterWithholding / 4),
        },
      ];

      // ============================
      // 9) Safe Harbor
      // ============================
      let premiumPreview:
        | { safeHarborMinAnnual: number; safeHarborMinQuarterly: number; message: string }
        | undefined;

      if (priorYearTotalTax != null && priorYearTotalTax > 0) {
        const multiplier = safeHarborMultiplier(filingStatus, priorYearAgi);
        const safeHarborAnnual = round2(priorYearTotalTax * multiplier);
        const safeHarborQuarter = round2(safeHarborAnnual / 4);

        premiumPreview = {
          safeHarborMinAnnual: safeHarborAnnual,
          safeHarborMinQuarterly: safeHarborQuarter,
          message:
            "Premium calculates penalty-safe quarterly payments using Safe Harbor rules and your prior-year info.",
        };

        if (isPremium && strategy === "safeHarbor") {
          const remainingSafeHarbor = round2(clamp0(safeHarborAnnual - withholdingAnnual));
          const per = round2(remainingSafeHarbor / 4);

          quarterly = [
            { label: "Q1", dueDateLabel: "Apr 15", amount: per },
            { label: "Q2", dueDateLabel: "Jun 15", amount: per },
            { label: "Q3", dueDateLabel: "Sep 15", amount: per },
            { label: "Q4", dueDateLabel: "Jan 15", amount: per },
          ];
        }
      }

      // ============================
      // 10) Pie
      // ============================
      const netTakeHome = round2(clamp0(grossIncome - totalTax));

      const pieLabels = isPremium
        ? ["Federal (after credits)", "NIIT", "State", "FICA/SE", "Net"]
        : ["Federal", "State", "FICA/SE", "Net"];

      const pieValues = isPremium
        ? [federalIncomeTaxAfterCredits, niitTax, stateIncomeTax, seTax, netTakeHome]
        : [federalTotal, stateIncomeTax, seTax, netTakeHome];

      return c.json({
        tier: isPremium ? "premium" : "free",
        taxYear: TAX_YEAR,
        annual: {
          totalTax: round2(totalTax),
          remainingAfterWithholding: round2(remainingAfterWithholding),

          // breakdown (helpful for UI/debug; safe to ignore)
          seTax: round2(seTax),
          federalIncomeTaxAfterCredits: round2(federalIncomeTaxAfterCredits),
          niitTax: round2(niitTax),
          qbiDeduction: round2(qbiDeduction),
          taxableIncomeFederal: round2(taxableIncomeFederal),
          stateIncomeTax: round2(stateIncomeTax),
        },
        quarterly,
        pie: { labels: pieLabels, values: pieValues },
        notes: [
          isPremium
            ? "Premium: includes federal brackets + constants from data/federal/2026.json, plus QBI + NIIT when applicable."
            : "Free: uses standard deduction + federal brackets and basic SE tax.",
          "SE tax is computed using federal_constants.json and accounts for the Social Security wage base and Additional Medicare threshold.",
          ...(isPremium && qbiDeduction > 0
            ? [`QBI deduction applied: $${qbiDeduction.toLocaleString("en-US")}.`]
            : []),
          ...(isPremium && niitTax > 0
            ? [`NIIT (3.8%) applied: $${niitTax.toLocaleString("en-US")}.`]
            : []),
        ],
        premiumPreview: !isPremium ? premiumPreview : undefined,
      });
    } catch (err: any) {
      console.error("Estimated quarterly error", err);
      return c.json(
        { message: "Failed to calculate", error: err?.message || String(err) },
        500
      );
    }
  }
);
