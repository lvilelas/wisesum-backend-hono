// src/lib/tax/loadStateTax.ts
import type { StateTaxRules } from "./stateTaxEngine";
import { loadStateRules } from "./stateTaxEngine";

export function loadStateTax(year: number, state: string): StateTaxRules | null {
  return loadStateRules(year, state);
}
