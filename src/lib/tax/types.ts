/**
 * Improved domain types with a summary field.
 * These interfaces extend the original result objects to include a `summary`
 * array with human-readable explanations of the calculation results.
 *
 * IMPORTANT:
 * - New fields added here are optional to preserve backward compatibility
 *   with older snapshots already stored in Supabase.
 */

export interface ChartData {
  labels: string[];
  values?: number[];
  valuesW2?: number[];
  values1099?: number[];
}

/**
 * Shared metadata that may appear in both free and premium results.
 * Optional to avoid breaking existing stored snapshots.
 */
export interface ResultMeta {
  /** Tax year used for the calculation (e.g., 2026). */
  taxYear?: number;

  /** Filing status used (if applicable). */
  filingStatus?: "single" | "mfj" | "mfs" | "hoh";

  /** State used for the calculation (e.g., CA, NY). */
  state?: string;

  /** Simulation ID (useful for PDF/UX). */
  simulationId?: string;

  /** Whether PDF is available for this result. */
  pdfAvailable?: boolean;
}

export interface FreeSummaryResult extends ResultMeta {
  type: "freeSummaryResult";
  winner: "W2" | "1099";
  annualDifference: number;
  monthlyDifference: number;
  breakEven1099Income: number;
  chart: ChartData;
  upgradePrompt: string;

  /**
   * Human-readable summary lines. Each entry is a sentence explaining the result.
   */
  summary: string[];
}

export interface PremiumDetailedResult extends ResultMeta {
  type: "premiumDetailedResult";
  winner: "W2" | "1099";
  annualDifference: number;
  monthlyDifference: number;
  breakEven1099Income: number;

  federalTaxW2: number;
  stateTaxW2: number;
  ficaTaxW2: number;

  federalTax1099: number;
  stateTax1099: number;
  selfEmploymentTax1099: number;

  deductionsApplied: Record<string, number>;

  effectiveTaxRateW2: number;
  effectiveTaxRate1099: number;

  assumptions: string[];
  recommendations: string[];

  chart: ChartData;

  /**
   * Human-readable summary lines. Each entry is a sentence explaining the result.
   */
  summary: string[];
}

export type CalculationResult = FreeSummaryResult | PremiumDetailedResult;
