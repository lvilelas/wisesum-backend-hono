/**
 * Federal assumptions helper (official + estimated).
 *
 * IMPORTANT:
 * - This helper MUST NOT be used for tax years that have confirmed JSON data.
 * - It is intended ONLY for future-year previews or MVP comparisons.
 *
 * If you call this for a year that already exists in the federal JSON,
 * you SHOULD throw and fix the caller.
 */

export type FilingStatus = "single"; // expand later if needed

export type EstimateMethod = "official" | "estimated";

export type EstimateMeta = {
  method: EstimateMethod;
  baseYear: number;
  inflationRate: number;
  yearsForward: number;
  note?: string;
};

export type EstimatedValue = {
  year: number;
  value: number;
  meta: EstimateMeta;
};

/**
 * Env-like shape used by Workers (c.env) or any caller.
 */
export type FederalAssumptionsEnv = {
  TAX_EST_INFLATION_RATE?: string;
  TAX_EST_ROUNDING_STEP?: string;
};

// -----------------------------
// 1) OFFICIAL values (FALLBACK ONLY)
// -----------------------------
// These values are ONLY used if no federal JSON exists for the requested year.
// They must NEVER override confirmed JSON data.
const OFFICIAL_FEDERAL_STANDARD_DEDUCTION: Record<
  number,
  Record<FilingStatus, number>
> = {
  2024: { single: 14600 }
};

// -----------------------------
// 2) Helpers
// -----------------------------
function clampRate(r: number) {
  if (!Number.isFinite(r)) return 0.03;
  return Math.min(0.10, Math.max(0.0, r));
}

function roundToNearest(value: number, step: number) {
  return Math.round(value / step) * step;
}

function getLastOfficialYear(): number {
  const years = Object.keys(OFFICIAL_FEDERAL_STANDARD_DEDUCTION)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (years.length === 0) {
    throw new Error("No OFFICIAL fallback values configured.");
  }
  return years[years.length - 1];
}

function getOfficialValue(year: number, status: FilingStatus): number | null {
  return OFFICIAL_FEDERAL_STANDARD_DEDUCTION[year]?.[status] ?? null;
}

function parseNumberOr<T extends number>(value: unknown, fallback: T): T {
  const n = typeof value === "string" ? Number(value) : Number(value);
  return (Number.isFinite(n) ? (n as T) : fallback);
}

// -----------------------------
// 3) Public API (GUARDED)
// -----------------------------

/**
 * Returns an ESTIMATED federal standard deduction.
 *
 * ⚠️ Guardrail:
 * If the requested year is EXPECTED to exist in confirmed federal JSON,
 * the caller MUST NOT use this function.
 */
export function getFederalStandardDeduction(
  year: number,
  status: FilingStatus = "single",
  opts?: { inflationRate?: number; roundingStep?: number },
  env?: FederalAssumptionsEnv
): EstimatedValue {
  const y = Number(year);
  if (!Number.isFinite(y) || y < 1900) {
    throw new Error(`Invalid tax year: ${year}`);
  }

  const lastOfficial = getLastOfficialYear();

  // ⛔ Guardrail: prevent silent override of confirmed JSON years
  if (y >= 2026) {
    throw new Error(
      `Federal assumptions must NOT be used for tax year ${y}. ` +
        `Confirmed federal JSON data should be loaded instead.`
    );
  }

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
        note: "Official fallback value (local config)."
      }
    };
  }

  if (y <= lastOfficial) {
    throw new Error(
      `Missing OFFICIAL fallback value for year ${y} (${status}).`
    );
  }

  const base = getOfficialValue(lastOfficial, status);
  if (base == null) {
    throw new Error(`Missing base value for ${lastOfficial}.`);
  }

  const defaultInflation = parseNumberOr(env?.TAX_EST_INFLATION_RATE, 0.03);
  const inflationRate = clampRate(opts?.inflationRate ?? defaultInflation);
  const yearsForward = y - lastOfficial;

  const estimatedRaw = base * Math.pow(1 + inflationRate, yearsForward);

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
        "Estimated fallback for preview only. " +
        "Must not be used when confirmed IRS data exists."
    }
  };
}
