// backend/src/services/simulationService.ts

import { FreeSummaryResult, PremiumDetailedResult } from "../lib/types";
import { calcStateTax, calcStateTaxFromTaxableBase } from "../lib/tax/stateTaxEngine";
import { loadStateBaseRules, applyStateConformity, applyStateDeductions } from "../lib/tax/stateBaseCalc";
import { getFederalStandardDeduction } from "../lib/tax/federalAssumptions";
import type { FilingStatus } from "../lib/tax/stateTaxEngine";
// ✅ 2026 federal confirmed JSON (single source for 2026)
import federal2026 from "../data/federal/2026.json" assert { type: "json" };

export type StateCode = string; // "CA", "TX", "NY"...

export type CalcInput = {
  w2Salary: number;
  income1099: number;
  state: StateCode;
  expenses: number;
  year?: number; // optional (default 2026 at route level)
};

type W2 = {
  federalTax: number;
  stateTax: number;
  ficaTax: number;
  netIncome: number;
  effectiveTaxRate: number;
};

type SE = {
  federalTax: number;
  stateTax: number;
  seTax: number;
  netIncome: number;
  effectiveTaxRate: number;
};

export type CalcComputed = {
  year: number;
  w2: W2;
  se: SE;
  annualDifference: number;
  monthlyDifference: number;
  breakEven1099Income: number;
  summary: string[];
  standardDeductionUsed: {
    value: number;
    meta: {
      method: "official" | "estimated";
      baseYear: number;
      inflationRate: number;
      yearsForward: number;
      note?: string;
    };
  };
};

function computeTaxableStateIncome(args: {
  year: number;
  state: string;
  filingStatus: FilingStatus;
  federalAGI: number;
  input?: Record<string, any>;
  useItemized?: boolean;
}) {
  const {
    year,
    state,
    filingStatus,
    federalAGI,
    input = {},
    useItemized = false,
  } = args;

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

  return {
    stateAGI: conformity.value,
    taxableStateIncome: deductions.value,
    warnings: [...conformity.warnings, ...deductions.warnings],
    missingInputs: Array.from(
      new Set([...conformity.missingInputs, ...deductions.missingInputs])
    ),
  };
}
// -------------------------
// FEDERAL PLACEHOLDERS (MVP)
// -------------------------
// (mantidos como você já tinha; o importante aqui é a standard deduction 2026 vir do JSON confirmado)

const FEDERAL_BRACKETS_2026_SINGLE: Array<{ upTo: number | null; rate: number }> =
  [
    { upTo: 11600, rate: 0.1 },
    { upTo: 47150, rate: 0.12 },
    { upTo: 100525, rate: 0.22 },
    { upTo: 191950, rate: 0.24 },
    { upTo: 243725, rate: 0.32 },
    { upTo: 609350, rate: 0.35 },
    { upTo: null, rate: 0.37 },
  ];

function calcProgressiveTax(
  taxable: number,
  brackets: Array<{ upTo: number | null; rate: number }>
) {
  let remaining = Math.max(0, taxable);
  let tax = 0;
  let lastCap = 0;

  for (const b of brackets) {
    if (remaining <= 0) break;
    const cap = b.upTo ?? Infinity;
    const bandSize = cap === Infinity ? remaining : Math.max(0, cap - lastCap);
    const amt = Math.min(remaining, bandSize);
    tax += amt * b.rate;
    remaining -= amt;
    if (cap !== Infinity) lastCap = cap;
  }

  return tax;
}

function calcFederalTaxFromTaxableIncome_single_placeholder(taxableIncome: number) {
  return calcProgressiveTax(
    Math.max(0, taxableIncome),
    FEDERAL_BRACKETS_2026_SINGLE
  );
}

function calcFederalTaxW2_single_placeholder(w2Salary: number, standardDeduction: number) {
  const taxable = Math.max(0, w2Salary - standardDeduction);
  return calcFederalTaxFromTaxableIncome_single_placeholder(taxable);
}

function calcFicaTax_placeholder(w2Salary: number) {
  const ssRate = 0.062;
  const ssWageBase = 168600; // placeholder
  const medicare = 0.0145;
  const addMed = 0.009;
  const addThreshold = 200000;

  const ss = Math.min(w2Salary, ssWageBase) * ssRate;
  const med = w2Salary * medicare;
  const add = Math.max(0, w2Salary - addThreshold) * addMed;
  return ss + med + add;
}

function calcSeTax_placeholder(netProfit: number) {
  const taxable = Math.max(0, netProfit) * 0.9235;

  const ssRate = 0.124;
  const ssWageBase = 168600; // placeholder
  const medicare = 0.029;

  const addMed = 0.009;
  const addThreshold = 200000;

  const ss = Math.min(taxable, ssWageBase) * ssRate;
  const med = taxable * medicare;
  const additional = Math.max(0, taxable - addThreshold) * addMed;

  return ss + med + additional;
}

/**
 * ✅ Standard Deduction loader:
 * - For 2026: MUST use confirmed JSON (federal/2026.json)
 * - For other years: use assumptions helper (official map / estimate)
 */
function getStandardDeductionWithMeta(year: number) {
  if (year === 2026) {
    const value = Number((federal2026 as any)?.standardDeduction?.single ?? 0);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error("Missing confirmed standard deduction for 2026 in federal/2026.json");
    }
    return {
      value,
      meta: {
        method: "official" as const,
        baseYear: 2026,
        inflationRate: 0,
        yearsForward: 0,
        note: "Confirmed value from data/federal/2026.json",
      },
    };
  }

  // fallback to assumptions helper (official/estimated)
  const stdDed = getFederalStandardDeduction(year, "single");
  return {
    value: stdDed.value,
    meta: stdDed.meta,
  };
}

/**
 * compareResults (corrigido)
 * - effectiveTaxRate do 1099: divide por netProfit
 * - federal do 1099: aplica standard deduction UMA VEZ:
 *     AGI = netProfit - halfSeDeduction
 *     taxableFederal = AGI - standardDeduction
 */
async function compareResultsNew(inputs: CalcInput, year: number, standardDeduction: number) {
  const { w2Salary, income1099, state, expenses } = inputs;

  // ======================
  // W2
  // ======================
  const w2FederalTax = calcFederalTaxW2_single_placeholder(w2Salary, standardDeduction);
  const w2Fica = calcFicaTax_placeholder(w2Salary);

  const w2Taxable = computeTaxableStateIncome({ year, state, filingStatus: "single", federalAGI: w2Salary });
  const w2State = calcStateTaxFromTaxableBase({ year, filingStatus: "single", state, taxableBase: w2Taxable.taxableStateIncome }).tax;

  const w2Total = w2FederalTax + w2State + w2Fica;
  const w2Net = w2Salary - w2Total;

  // ======================
  // 1099
  // ======================
  const netProfit = Math.max(0, income1099 - expenses);

  const seTax = calcSeTax_placeholder(netProfit);
  const halfSeDeduction = seTax / 2;

  const agi = Math.max(0, netProfit - halfSeDeduction);
  const taxableFederal = Math.max(0, agi - standardDeduction);
  const seFederalTax = calcFederalTaxFromTaxableIncome_single_placeholder(taxableFederal);

  const seTaxable = computeTaxableStateIncome({ year, state, filingStatus: "single", federalAGI: agi, input: { /* optional state inputs */ } });
  const seStateTax = calcStateTaxFromTaxableBase({ year, filingStatus: "single", state, taxableBase: seTaxable.taxableStateIncome }).tax;

  const seTotal = seFederalTax + seStateTax + seTax;
  const seNet = income1099 - expenses - seTotal;

  const w2: W2 = {
    federalTax: w2FederalTax,
    stateTax: w2State,
    ficaTax: w2Fica,
    netIncome: w2Net,
    effectiveTaxRate: w2Salary > 0 ? w2Total / w2Salary : 0,
  };

  const se: SE = {
    federalTax: seFederalTax,
    stateTax: seStateTax,
    seTax,
    netIncome: seNet,
    effectiveTaxRate: netProfit > 0 ? seTotal / netProfit : 0,
  };

  const annualDifference = se.netIncome - w2.netIncome;
  const monthlyDifference = annualDifference / 12;

  return { w2, se, annualDifference, monthlyDifference };
}

/**
 * Break-even corrigido:
 * - Mantém w2Salary fixo
 * - Ajusta income1099 (bruto) até se.netIncome ≈ w2.netIncome
 */
async function findBreakEven(params: {
  year: number;
  w2Salary: number;
  state: StateCode;
  expenses: number;
  standardDeduction: number;
}): Promise<number> {
  const { year, w2Salary, state, expenses, standardDeduction } = params;

  const baseline = await compareResultsNew(
    { w2Salary, income1099: 0, state, expenses, year },
    year,
    standardDeduction
  );
  const targetNet = baseline.w2.netIncome;

  let low = 0;
  let high = Math.max(1, w2Salary * 5);

  for (let i = 0; i < 12; i++) {
    const test = await compareResultsNew(
      { w2Salary, income1099: high, state, expenses, year },
      year,
      standardDeduction
    );
    if (test.se.netIncome >= targetNet) break;
    high *= 2;
  }

  let mid = 0;
  for (let i = 0; i < 30; i++) {
    mid = (low + high) / 2;

    const test = await compareResultsNew(
      { w2Salary, income1099: mid, state, expenses, year },
      year,
      standardDeduction
    );

    if (test.se.netIncome >= targetNet) high = mid;
    else low = mid;
  }

  return mid;
}

export async function computeSimulation(input: CalcInput): Promise<CalcComputed> {
  const year = Number(input.year ?? 2026);
  if (!Number.isFinite(year)) throw new Error("Invalid tax year");

  // ✅ 2026 -> confirmed JSON; other years -> assumptions helper
  const stdDed = getStandardDeductionWithMeta(year);
  const standardDeduction = stdDed.value;

  const results = await compareResultsNew(input, year, standardDeduction);
  const { w2, se, annualDifference, monthlyDifference } = results;

  const totalTaxW2 = w2.federalTax + w2.stateTax + w2.ficaTax;
  const totalTax1099 = se.federalTax + se.stateTax + se.seTax;

  const winnerPhrase =
    annualDifference >= 0
      ? `The 1099 contract yields $${Math.abs(Math.round(annualDifference)).toLocaleString()} more per year ($${Math.abs(
          Math.round(monthlyDifference)
        ).toLocaleString()} per month).`
      : `The W-2 employment yields $${Math.abs(Math.round(annualDifference)).toLocaleString()} more per year ($${Math.abs(
          Math.round(monthlyDifference)
        ).toLocaleString()} per month).`;

  const summary: string[] = [
    `Your W-2 net income is $${Math.round(w2.netIncome).toLocaleString()}, after paying $${Math.round(
      totalTaxW2
    ).toLocaleString()} in federal, state and FICA taxes.`,
    `Your 1099 net income is $${Math.round(se.netIncome).toLocaleString()}, after expenses and paying $${Math.round(
      totalTax1099
    ).toLocaleString()} in federal, state and self-employment taxes.`,
    winnerPhrase,
  ];

  const breakEven1099Income = await findBreakEven({
    year,
    w2Salary: input.w2Salary,
    state: input.state,
    expenses: input.expenses,
    standardDeduction,
  });

  return {
    year,
    w2,
    se,
    annualDifference,
    monthlyDifference,
    breakEven1099Income,
    summary,
    standardDeductionUsed: {
      value: stdDed.value,
      meta: stdDed.meta,
    },
  };
}

export function buildPremiumResult(params: {
  computed: CalcComputed;
  state: StateCode;
  simulationId: string;
}): PremiumDetailedResult & { summary: string[] } {
  const { computed, state, simulationId } = params;
  const {
    year,
    w2,
    se,
    annualDifference,
    monthlyDifference,
    breakEven1099Income,
    summary,
    standardDeductionUsed,
  } = computed;

  const stdDedLabel =
    standardDeductionUsed.meta.method === "official"
      ? `Federal standard deduction of $${standardDeductionUsed.value.toLocaleString()} applied (official).`
      : `Federal standard deduction of $${standardDeductionUsed.value.toLocaleString()} applied (estimated from ${
          standardDeductionUsed.meta.baseYear
        } using ${(standardDeductionUsed.meta.inflationRate * 100).toFixed(1)}%/yr).`;

  return {
    type: "premiumDetailedResult",
    winner: annualDifference >= 0 ? "1099" : "W2",
    annualDifference,
    monthlyDifference,
    breakEven1099Income,
    federalTaxW2: w2.federalTax,
    stateTaxW2: w2.stateTax,
    ficaTaxW2: w2.ficaTax,
    federalTax1099: se.federalTax,
    stateTax1099: se.stateTax,
    selfEmploymentTax1099: se.seTax,
    deductionsApplied: {
      standardDeduction: standardDeductionUsed.value,
      halfSelfEmploymentTaxDeduction: se.seTax / 2,
    },
    effectiveTaxRateW2: w2.effectiveTaxRate,
    effectiveTaxRate1099: se.effectiveTaxRate,
    assumptions: [
      `Tax year ${year}`,
      `State: ${String(state).toUpperCase()}`,
      "Single filer",
      "Simplified deductions only",
      stdDedLabel,
      "Half of self-employment tax deducted from AGI for 1099, then standard deduction applied",
      "State tax computed via JSON rules (not a substitute for professional advice).",
    ],
    recommendations: [
      annualDifference >= 0
        ? `Even though 1099 pays more in this scenario, your 1099 earnings would need to be at least $${Math.round(
            breakEven1099Income
          ).toLocaleString()} per year (before expenses) to yield the same net income as a W-2 salary after taxes.`
        : `In this scenario W-2 pays more. 1099 earnings would need to exceed $${Math.round(
            breakEven1099Income
          ).toLocaleString()} per year (before expenses) to match the net income of a W-2 salary.`,
    ],
    simulationId,
    pdfAvailable: true,
    chart: {
      labels: ["Federal", "State", "FICA/SE", "Net"],
      valuesW2: [w2.federalTax, w2.stateTax, w2.ficaTax, w2.netIncome],
      values1099: [se.federalTax, se.stateTax, se.seTax, se.netIncome],
    },
    summary,
  };
}

export function buildFreeResult(params: {
  computed: CalcComputed;
}): FreeSummaryResult & { summary: string[] } {
  const { computed } = params;
  const { w2, se, annualDifference, monthlyDifference, breakEven1099Income, summary } = computed;

  return {
    type: "freeSummaryResult",
    winner: annualDifference >= 0 ? "1099" : "W2",
    annualDifference,
    monthlyDifference,
    breakEven1099Income,
    chart: {
      labels: ["W2 net", "1099 net"],
      values: [w2.netIncome, se.netIncome],
    },
    upgradePrompt: "Upgrade to view a detailed tax breakdown and download a PDF report.",
    summary,
  };
}
