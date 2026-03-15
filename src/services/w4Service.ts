/*
 * Service functions for W‑4 Withholding calculations.  These helpers
 * encapsulate the core business logic needed to estimate federal
 * income tax based on an annual salary, optional side income,
 * filing status and simple dependent credits.  They also compute
 * annual withholding and determine whether the user is on track for
 * a refund or a tax bill.  Premium results include a more detailed
 * breakdown of the tax computation to drive planning and education.
 */

export type FilingStatus = "single" | "married" | "hoh";

export interface W4Input {
  /**
   * Annual W‑2 salary in dollars.  If the user enters a different pay
   * frequency on the client, it should be converted to annual before
   * calling this function.
   */
  annualSalary: number;
  /**
   * Pay frequency string (weekly, biweekly, semimonthly or monthly).
   * Used to convert a per‑paycheck withholding amount into an annual
   * total.  If omitted or invalid, defaults to 26 (biweekly) periods.
   */
  payFrequency: string;
  /** Optional side income (e.g. freelance income) in dollars. */
  sideIncome?: number;
  /** Number of qualifying children under age 17. */
  children: number;
  /** Number of other dependents (non‑child). */
  dependents: number;
  /** Federal tax withheld per paycheck in dollars. */
  withholdingPerPaycheck: number;
  /** Filing status: single, married filing jointly (married) or head of household (hoh). */
  filingStatus: FilingStatus;
  /** Tax year for the estimate; currently defaults to 2026. */
  year?: number;

  /**
   * OPTIONAL premium fields
   *
   * The following fields are only honored for premium users.  Free users
   * can omit them or supply zeros.  Premium subscribers may provide
   * additional income and withholding details for a more accurate
   * recommendation.
   */
  /** Annual income for a spouse or second job in dollars. */
  spouseIncome?: number;
  /** Year‑to‑date wages already earned this year.  Used together with
   * remainingPayPeriods to spread withholding across the rest of the year.
   */
  ytdWages?: number;
  /** Year‑to‑date federal withholding already taken this year. */
  ytdWithholding?: number;
  /** Additional deductions beyond the standard deduction in dollars. */
  deductions?: number;
  /** Additional withholding amount to withhold for the rest of the year in dollars. */
  extraWithholding?: number;
  /** Number of pay periods remaining this year.  Overrides the default derived from payFrequency. */
  remainingPayPeriods?: number;
  /** Optional state code for potential state tax calculations (currently unused). */
  state?: string;
}

export interface W4Computed {
  year: number;
  /** Estimated federal tax after applying credits. */
  estimatedTax: number;
  /** Initial tax liability before credits. */
  initialTax: number;
  /** Total credits applied (child + other). */
  totalCredits: number;
  /** Total annual withholding based on per‑paycheck amount. */
  annualWithholding: number;
  /** Difference between withholding and estimated tax.  Positive means refund; negative means tax owed. */
  difference: number;
  /** Recommended adjustment per paycheck to better align withholding. */
  recommendedChangePerPaycheck: number;
  /** The effective tax rate (estimatedTax / annual income) */
  effectiveTaxRate: number;
  /** Standard deduction used based on filing status and year. */
  standardDeduction: number;
  /** Detailed breakdown of the progressive tax calculation for premium users. */
  bracketTaxes: Array<{ range: string; rate: number; income: number; tax: number }>;
}

// Approximate 2026 federal income tax brackets for each filing status.
// These values are estimates and should be updated if official figures differ.
const FEDERAL_BRACKETS_2026: Record<FilingStatus, Array<{ upTo: number | null; rate: number }>> = {
  single: [
    { upTo: 11600, rate: 0.1 },
    { upTo: 47150, rate: 0.12 },
    { upTo: 100525, rate: 0.22 },
    { upTo: 191950, rate: 0.24 },
    { upTo: 243725, rate: 0.32 },
    { upTo: 609350, rate: 0.35 },
    { upTo: null, rate: 0.37 },
  ],
  married: [
    { upTo: 23200, rate: 0.1 },
    { upTo: 94300, rate: 0.12 },
    { upTo: 201050, rate: 0.22 },
    { upTo: 383900, rate: 0.24 },
    { upTo: 487450, rate: 0.32 },
    { upTo: 731200, rate: 0.35 },
    { upTo: null, rate: 0.37 },
  ],
  hoh: [
    { upTo: 15550, rate: 0.1 },
    { upTo: 59850, rate: 0.12 },
    { upTo: 95350, rate: 0.22 },
    { upTo: 182100, rate: 0.24 },
    { upTo: 228900, rate: 0.32 },
    { upTo: 550400, rate: 0.35 },
    { upTo: null, rate: 0.37 },
  ],
};

// Approximate 2026 standard deduction by filing status.  These values
// are used to compute taxable income and may differ from official
// numbers.  Adjust when official IRS numbers for 2026 are published.
const STANDARD_DEDUCTION_2026: Record<FilingStatus, number> = {
  single: 14600,
  married: 29200,
  hoh: 21900,
};

// Map payFrequency strings to the number of pay periods per year.
const PAY_PERIODS: Record<string, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

function calcProgressiveTax(
  taxableIncome: number,
  brackets: Array<{ upTo: number | null; rate: number }>,
): { tax: number; breakdown: Array<{ income: number; rate: number; tax: number; range: string }> } {
  let remaining = Math.max(0, taxableIncome);
  let tax = 0;
  let lastCap = 0;
  const breakdown: Array<{ income: number; rate: number; tax: number; range: string }> = [];

  for (const b of brackets) {
    if (remaining <= 0) break;
    const cap = b.upTo ?? Infinity;
    const bandSize = cap === Infinity ? remaining : Math.max(0, cap - lastCap);
    const amount = Math.min(remaining, bandSize);
    const bandTax = amount * b.rate;
    tax += bandTax;
    breakdown.push({ income: amount, rate: b.rate, tax: bandTax, range: `${lastCap}–${cap === Infinity ? "∞" : cap}` });
    remaining -= amount;
    if (cap !== Infinity) lastCap = cap;
  }

  return { tax, breakdown };
}

/**
 * Compute the W‑4 withholding results.  This helper applies the standard
 * deduction and simple credits to estimate federal tax.  It also
 * aggregates a breakdown of tax bands for premium insights.
 */
export function computeW4(input: W4Input): W4Computed {
  const year = input.year ?? 2026;
  const annualSalary = Math.max(0, input.annualSalary || 0);
  const sideIncome = Math.max(0, input.sideIncome || 0);
  const spouseIncome = Math.max(0, input.spouseIncome || 0);
  const children = Math.max(0, input.children || 0);
  const dependents = Math.max(0, input.dependents || 0);
  const withholding = Math.max(0, input.withholdingPerPaycheck || 0);
  const extraWithholding = Math.max(0, input.extraWithholding || 0);
  const ytdWithholding = Math.max(0, input.ytdWithholding || 0);
  const status: FilingStatus = input.filingStatus || "single";

  const payPeriods = PAY_PERIODS[input.payFrequency] ?? 26;
  // Annual income includes spouse/second job income for premium users
  const annualIncome = annualSalary + sideIncome + spouseIncome;
  const standardDeduction = STANDARD_DEDUCTION_2026[status] ?? STANDARD_DEDUCTION_2026.single;
  // Additional deductions beyond the standard deduction (premium only)
  const extraDeductions = Math.max(0, input.deductions || 0);
  // Taxable income cannot be negative
  const taxableIncome = Math.max(0, annualIncome - standardDeduction - extraDeductions);

  // Progressive tax and breakdown
  const { tax: initialTax, breakdown } = calcProgressiveTax(
    taxableIncome,
    FEDERAL_BRACKETS_2026[status] ?? FEDERAL_BRACKETS_2026.single,
  );

  // Credits: $2,000 per qualifying child, $500 per other dependent
  const creditTotal = children * 2000 + dependents * 500;
  const estimatedTax = Math.max(0, initialTax - creditTotal);

  // Annual withholding calculation.  For premium users with year‑to‑date data,
  // combine YTD withholding with projected withholding for the remaining
  // pay periods and any explicit extra withholding amount.  Otherwise
  // default to simple multiplication by pay periods.
  const remainingPeriods = Math.max(1, input.remainingPayPeriods ?? payPeriods);
  let annualWithholding: number;
  if (input.ytdWithholding !== undefined || input.extraWithholding !== undefined || input.remainingPayPeriods !== undefined) {
    // Use premium withholding logic: total withheld so far plus future withholding and extra
    annualWithholding = ytdWithholding + withholding * remainingPeriods + extraWithholding;
  } else {
    annualWithholding = withholding * payPeriods + extraWithholding;
  }
  const difference = annualWithholding - estimatedTax;
  // If a premium user provided remainingPayPeriods use it to compute the recommended adjustment; otherwise fall back to total pay periods
  const periodsForAdjustment = input.remainingPayPeriods ?? payPeriods;
  const recommendedChangePerPaycheck = periodsForAdjustment > 0 ? (estimatedTax - annualWithholding) / periodsForAdjustment : 0;

  const effectiveTaxRate = annualIncome > 0 ? estimatedTax / annualIncome : 0;

  // Build bracket summary for premium users
  const bracketTaxes: Array<{ range: string; rate: number; income: number; tax: number }> = breakdown.map(
    (b) => ({ range: b.range, rate: b.rate, income: b.income, tax: b.tax }),
  );

  return {
    year,
    estimatedTax,
    initialTax,
    totalCredits: creditTotal,
    annualWithholding,
    difference,
    recommendedChangePerPaycheck,
    effectiveTaxRate,
    standardDeduction,
    bracketTaxes,
  };
}

/**
 * Build a free (summary) result.  Free users see only high‑level
 * information: tax, withholding, difference and a short summary.  The
 * recommendedChangePerPaycheck helps them adjust withholding without
 * exposing the full breakdown.
 */
export function buildFreeW4Result({ computed }: { computed: W4Computed }) {
  const { estimatedTax, annualWithholding, difference, recommendedChangePerPaycheck } = computed;
  return {
    tier: "free" as const,
    estimatedTax,
    annualWithholding,
    difference,
    recommendedChangePerPaycheck,
    summary: difference > 0
      ? [
          `You may receive a refund of $${Math.round(difference).toLocaleString()}.`,
          `Reduce your withholding by about $${Math.abs(recommendedChangePerPaycheck).toFixed(2)} per paycheck to keep more cash in hand.`,
        ]
      : difference < 0
      ? [
          `You may owe $${Math.round(-difference).toLocaleString()} at tax time.`,
          `Increase your withholding by about $${Math.abs(recommendedChangePerPaycheck).toFixed(2)} per paycheck to avoid a bill.`,
        ]
      : [
          `Your withholding appears well matched to your estimated tax.`,
        ],
  };
}

/**
 * Build a premium result.  Premium users receive the same summary
 * information along with a detailed breakdown of how their tax was
 * calculated, including the standard deduction, credits applied, tax by
 * bracket and effective tax rate.  This empowers deeper planning and
 * education.
 */
export function buildPremiumW4Result({ computed }: { computed: W4Computed }) {
  const {
    estimatedTax,
    initialTax,
    totalCredits,
    annualWithholding,
    difference,
    recommendedChangePerPaycheck,
    effectiveTaxRate,
    standardDeduction,
    bracketTaxes,
  } = computed;
  return {
    tier: "premium" as const,
    estimatedTax,
    initialTax,
    totalCredits,
    annualWithholding,
    difference,
    recommendedChangePerPaycheck,
    effectiveTaxRate,
    standardDeduction,
    bracketTaxes,
    summary: difference > 0
      ? [
          `Your withholding exceeds estimated tax by $${Math.round(difference).toLocaleString()}.`,
          `Consider reducing withholding by $${Math.abs(recommendedChangePerPaycheck).toFixed(2)} per paycheck.`,
        ]
      : difference < 0
      ? [
          `Your withholding falls short by $${Math.round(-difference).toLocaleString()}.`,
          `Increase withholding by about $${Math.abs(recommendedChangePerPaycheck).toFixed(2)} per paycheck.`,
        ]
      : [
          `Your withholding matches your estimated tax.  Nice job!`,
        ],
  };
}