// src/lib/tax/stateTaxEngine.ts
// ✅ Cloudflare Workers: sem fs/path/process.cwd()

import compiled2025 from "../../data/compiled_2025_all_states.json" assert { type: "json" };

export type FilingStatus = "single";
export type TaxType = "flat" | "progressive";

export type StateTaxRules = {
  state: string;
  year: number;
  hasIncomeTax: boolean;

  // Tax Foundation import
  taxType?: TaxType;
  flatRate?: { filingStatus: FilingStatus; rate: number };

  // deductions/exemptions (opcional)
  standardDeduction?: Partial<Record<FilingStatus, number>>;
  personalExemption?: Partial<Record<FilingStatus, number>>;

  // brackets (progressivo)
  brackets?: Partial<
    Record<
      FilingStatus,
      Array<{
        upTo: number | null;
        rate: number;
      }>
    >
  >;

  notes?: string;
  verified?: boolean;
  confidence?: "verified" | "estimated";
  source?: string[];
  lastReviewed?: string;
  errors?: string[];
};

export type StateTaxInput = {
  state: string;
  year: number;
  filingStatus: FilingStatus;
  taxableIncome: number;
};

export type StateTaxResult = {
  state: string;
  year: number;
  hasIncomeTax: boolean;
  taxableBase: number;
  tax: number;
  effectiveRate: number;
  breakdown: Array<{
    bracketUpTo: number | null;
    rate: number;
    amountTaxed: number;
    taxForBracket: number;
  }>;
  note?: string;
};

/**
 * Estados sem income tax (defensivo)
 */
const NO_INCOME_TAX_STATES = new Set([
  "AK",
  "FL",
  "NV",
  "SD",
  "TN",
  "TX",
  "WA",
  "WY",
]);

/* =========================
   Utils
========================= */

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp0 = (n: number) => (n < 0 ? 0 : n);
const normalizeState = (s: string) => String(s || "").toUpperCase().trim();

/* =========================
   Loader de regras (COMPILED JSON)
========================= */

// ✅ “registry” de anos compilados
const COMPILED_RULES: Record<number, Record<string, StateTaxRules>> = {
  2025: compiled2025 as Record<string, StateTaxRules>,
};

// cache simples por (year,state)
const RULES_CACHE: Record<string, StateTaxRules> = {};

export function loadStateRules(year: number, stateRaw: string): StateTaxRules | null {
  const state = normalizeState(stateRaw);
  const y = Number(year);

  const cacheKey = `${y}:${state}`;
  const cached = RULES_CACHE[cacheKey];
  if (cached) return cached;

  const fromCompiled = COMPILED_RULES?.[y]?.[state] ?? null;
  if (!fromCompiled) return null;

  // validação leve
  if (fromCompiled.state && normalizeState(fromCompiled.state) !== state) {
    throw new Error(
      `Invalid state tax rules: expected ${state}, got ${fromCompiled.state}`
    );
  }
  if (fromCompiled.year && Number(fromCompiled.year) !== y) {
    throw new Error(
      `Invalid state tax rules: expected year ${y}, got ${fromCompiled.year}`
    );
  }

  RULES_CACHE[cacheKey] = fromCompiled;
  return fromCompiled;
}

/* =========================
   Cálculo por brackets
========================= */

function applyBrackets(
  taxable: number,
  brackets: Array<{ upTo: number | null; rate: number }>
) {
  let remaining = taxable;
  let lastCap = 0;
  let tax = 0;

  const breakdown: StateTaxResult["breakdown"] = [];

  for (const bracket of brackets) {
    if (remaining <= 0) break;

    const cap = bracket.upTo ?? Infinity;
    const bandSize = cap === Infinity ? remaining : Math.max(0, cap - lastCap);

    const amountTaxed = Math.min(remaining, bandSize);
    const taxForBracket = amountTaxed * bracket.rate;

    tax += taxForBracket;

    breakdown.push({
      bracketUpTo: bracket.upTo,
      rate: bracket.rate,
      amountTaxed: round2(amountTaxed),
      taxForBracket: round2(taxForBracket),
    });

    remaining -= amountTaxed;
    if (cap !== Infinity) lastCap = cap;
  }

  return {
    tax: round2(tax),
    breakdown,
  };
}

/* =========================
   Engine principal
========================= */

export function calcStateTax(input: StateTaxInput): StateTaxResult {
  const state = normalizeState(input.state);
  const year = Number(input.year);
  const filingStatus = input.filingStatus;
  const taxableIncome = clamp0(Number(input.taxableIncome || 0));

  // Estados sem imposto estadual (defensivo)
  if (NO_INCOME_TAX_STATES.has(state)) {
    return {
      state,
      year,
      hasIncomeTax: false,
      taxableBase: round2(taxableIncome),
      tax: 0,
      effectiveRate: 0,
      breakdown: [],
      note: "No state income tax",
    };
  }

  const rules = loadStateRules(year, state);
  if (!rules) {
    throw new Error(`State rules not available for ${state} (${year})`);
  }

  if (!rules.hasIncomeTax) {
    return {
      state,
      year,
      hasIncomeTax: false,
      taxableBase: round2(taxableIncome),
      tax: 0,
      effectiveRate: 0,
      breakdown: [],
      note: rules.notes,
    };
  }

  const standardDeduction = rules.standardDeduction?.[filingStatus] ?? 0;
  const personalExemption = rules.personalExemption?.[filingStatus] ?? 0;

  const taxableBase = clamp0(taxableIncome - standardDeduction - personalExemption);

  // ✅ flat tax
  if (rules.taxType === "flat" && rules.flatRate?.rate != null) {
    const tax = round2(taxableBase * rules.flatRate.rate);
    return {
      state,
      year,
      hasIncomeTax: true,
      taxableBase: round2(taxableBase),
      tax,
      effectiveRate: taxableBase > 0 ? round2(tax / taxableBase) : 0,
      breakdown: [
        {
          bracketUpTo: null,
          rate: rules.flatRate.rate,
          amountTaxed: round2(taxableBase),
          taxForBracket: tax,
        },
      ],
      note: rules.notes,
    };
  }

  // progressive
  const brackets = rules.brackets?.[filingStatus];
  if (!brackets || brackets.length === 0) {
    throw new Error(`Missing brackets/flatRate for ${state} (${year})`);
  }

  const { tax, breakdown } = applyBrackets(taxableBase, brackets);

  return {
    state,
    year,
    hasIncomeTax: true,
    taxableBase: round2(taxableBase),
    tax,
    effectiveRate: taxableBase > 0 ? round2(tax / taxableBase) : 0,
    breakdown,
    note: rules.notes,
  };
}
