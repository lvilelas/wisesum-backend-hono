/**
 * Federal assumptions helper (official + estimated).
 *
 * - Keep the last known OFFICIAL values in a small map below.
 * - For any year > last official, we estimate using an inflation rate (compounded).
 * - Returns meta so you can print "estimated" in the PDF/UI.
 *
 * This is designed for MVP comparators (not tax filing).
 */

export type FilingStatus = "single"; // expand later if needed: "married_joint", etc.

export type EstimateMethod = "official" | "estimated";

export type EstimateMeta = {
  method: EstimateMethod;
  baseYear: number; // last official year used
  inflationRate: number; // rate applied per year (compounded)
  yearsForward: number; // year - baseYear
  note?: string;
};

export type EstimatedValue = {
  year: number;
  value: number;
  meta: EstimateMeta;
};

/**
 * Env-like shape used by Workers (c.env) or any caller.
 * Keep as strings to mirror env var behavior.
 */
export type FederalAssumptionsEnv = {
  TAX_EST_INFLATION_RATE?: string;
  TAX_EST_ROUNDING_STEP?: string;
};

// -----------------------------
// 1) OFFICIAL values (you maintain these)
// -----------------------------
// Put ONLY values you are confident are official.
// The lib will always use the highest year in this map as "last official".
//
// Example shown for 2024 single.
// Add 2025 official later when IRS publishes it.
const OFFICIAL_FEDERAL_STANDARD_DEDUCTION: Record<
  number,
  Record<FilingStatus, number>
> = {
  2024: { single: 14600 },
};

// -----------------------------
// 2) Defaults & helpers
// -----------------------------
function clampRate(r: number) {
  if (!Number.isFinite(r)) return 0.03;
  // guardrails to avoid insane configs
  return Math.min(0.10, Math.max(0.0, r));
}

function roundToNearest(value: number, step: number) {
  // step=50 => rounds to nearest $50
  return Math.round(value / step) * step;
}

function getLastOfficialYear(): number {
  const years = Object.keys(OFFICIAL_FEDERAL_STANDARD_DEDUCTION)
    .map((y) => Number(y))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);

  if (years.length === 0) {
    throw new Error("No official federal standard deduction values configured.");
  }
  return years[years.length - 1];
}

function getOfficialValue(year: number, status: FilingStatus): number | null {
  const row = OFFICIAL_FEDERAL_STANDARD_DEDUCTION[year];
  return row?.[status] ?? null;
}

function parseNumberOr<T extends number>(value: unknown, fallback: T): T {
  // Mirrors Number(process.env.X ?? fallback) semantics:
  // - undefined/null => fallback
  // - non-numeric string => NaN => fallback (after finite check)
  const n = typeof value === "string" ? Number(value) : Number(value);
  return (Number.isFinite(n) ? (n as T) : fallback);
}

// -----------------------------
// 3) Public API
// -----------------------------

/**
 * Returns the federal standard deduction for a given year.
 *
 * If year <= last official year and present in OFFICIAL map => official.
 * If year > last official year => estimated (compounded by inflation rate).
 *
 * @param year tax year requested
 * @param status filing status (currently "single")
 * @param opts inflationRate: annual adjustment used for estimation (default 3%)
 *             roundingStep: rounding in dollars for estimated values (default $50)
 * @param env  (Workers) pass c.env to support configurable defaults without process.env
 */
export function getFederalStandardDeduction(
  year: number,
  status: FilingStatus = "single",
  opts?: { inflationRate?: number; roundingStep?: number },
  env?: FederalAssumptionsEnv
): EstimatedValue {
  const y = Number(year);
  if (!Number.isFinite(y) || y < 1900) {
    throw new Error(`Invalid year: ${year}`);
  }

  const lastOfficial = getLastOfficialYear();

  // If we have an exact official value for that year, return it.
  const official = getOfficialValue(y, status);
  if (official != null) {
    return {
      year: y,
      value: official,
      meta: {
        method: "official",
        baseYear: y,
        inflationRate: 0,
        yearsForward: 0,
        note: "Official value (configured locally).",
      },
    };
  }

  // If requested year is before/within last official but missing from map, fail fast.
  // This prevents silent wrong outputs for past years you intended to be official.
  if (y <= lastOfficial) {
    throw new Error(
      `Missing OFFICIAL federal standard deduction for year ${y} (${status}). ` +
        `Add it to OFFICIAL_FEDERAL_STANDARD_DEDUCTION.`
    );
  }

  // Estimate from last official year
  const base = getOfficialValue(lastOfficial, status);
  if (base == null) {
    throw new Error(
      `Missing OFFICIAL base value for lastOfficial=${lastOfficial} (${status}).`
    );
  }

  // ✅ Same business logic/calculation, only swapped process.env -> env
  const defaultInflation = parseNumberOr(env?.TAX_EST_INFLATION_RATE, 0.03);
  const inflationRate = clampRate(opts?.inflationRate ?? defaultInflation);
  const yearsForward = y - lastOfficial;

  // Compounded estimate: base * (1 + r)^(yearsForward)
  const estimatedRaw = base * Math.pow(1 + inflationRate, yearsForward);

  // Conservative-ish rounding helps stability and avoids false precision
  const defaultRoundingStep = parseNumberOr(env?.TAX_EST_ROUNDING_STEP, 50);
  const roundingStep = Math.max(
    1,
    Math.floor(opts?.roundingStep ?? defaultRoundingStep)
  );
  const estimated = roundToNearest(estimatedRaw, roundingStep);

  return {
    year: y,
    value: estimated,
    meta: {
      method: "estimated",
      baseYear: lastOfficial,
      inflationRate,
      yearsForward,
      note:
        "Estimated from last official IRS value using an inflation rate. " +
        "Not for tax filing; comparison use only.",
    },
  };
}
