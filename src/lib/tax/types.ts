/**
 * Improved domain types with a summary field. These interfaces extend the original
 * result objects to include a `summary` array with human‑readable explanations
 * of the calculation results. The rest of the fields mirror the base types.
 */

export interface ChartData {
  labels: string[];
  values?: number[];
  valuesW2?: number[];
  values1099?: number[];
}

export interface FreeSummaryResult {
  type: 'freeSummaryResult';
  winner: 'W2' | '1099';
  annualDifference: number;
  monthlyDifference: number;
  breakEven1099Income: number;
  chart: ChartData;
  upgradePrompt: string;
  /**
   * Human‑readable summary lines. Each entry is a sentence explaining the result.
   */
  summary: string[];
}

export interface PremiumDetailedResult {
  type: 'premiumDetailedResult';
  winner: 'W2' | '1099';
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
  simulationId: string;
  pdfAvailable: boolean;
  chart: ChartData;
  /**
   * Human‑readable summary lines. Each entry is a sentence explaining the result.
   */
  summary: string[];
}

export type CalculationResult = FreeSummaryResult | PremiumDetailedResult;