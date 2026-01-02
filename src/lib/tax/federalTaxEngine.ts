import federal2026 from "../../data/federal/2026.json";

export type FilingStatus = "single" | "mfj" | "hoh" | "mfs";

type Bracket = { upTo: number | null; rate: number };

const clamp0 = (n: number) => (n < 0 ? 0 : n);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Calculates federal income tax using CONFIRMED IRS data.
 *
 * IMPORTANT:
 * - This engine does NOT estimate values.
 * - The caller must ensure the correct dataset is used.
 * - For now, only 2026 is supported explicitly.
 */
export function calcFederalIncomeTax(params: {
  filingStatus: FilingStatus;
  incomeBase: number;
  taxYear?: number;
}) {
  const { filingStatus, incomeBase, taxYear } = params;

  // 🔒 Guardrail: avoid silent mismatch
  if (taxYear != null && taxYear !== 2026) {
    throw new Error(
      `Federal tax engine only supports 2026 data. Requested taxYear=${taxYear}`
    );
  }

  // ✅ Single source of truth (confirmed IRS data)
  const data = federal2026;

  const safeIncome = clamp0(incomeBase);

  const stdDed = data.standardDeduction[filingStatus];
  if (stdDed == null) {
    throw new Error(
      `Standard deduction not found for filingStatus=${filingStatus}`
    );
  }

  const taxableIncome = clamp0(safeIncome - stdDed);

  const brackets: Bracket[] = data.brackets[filingStatus];
  if (!brackets || brackets.length === 0) {
    throw new Error(
      `Tax brackets not found for filingStatus=${filingStatus}`
    );
  }

  let tax = 0;
  let prev = 0;

  for (const b of brackets) {
    const cap = b.upTo ?? Infinity;
    const band = clamp0(Math.min(taxableIncome, cap) - prev);
    tax += band * b.rate;
    prev = cap;

    if (taxableIncome <= cap) break;
  }

  return {
    tax: round2(tax),
    taxableIncome: round2(taxableIncome),
    standardDeduction: stdDed,
  };
}
