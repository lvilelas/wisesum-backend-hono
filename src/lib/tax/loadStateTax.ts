// src/lib/tax/loadStateTax.ts
//
// Thin wrapper around `loadStateRules`.
//
// This file exists to provide a stable, higher-level import path for callers
// that conceptually want to "load state tax data", without depending directly
// on the internal stateTaxEngine implementation.
//
// IMPORTANT:
// - This function does NOT perform any tax calculation.
// - It only loads precompiled state tax rules from JSON.
// - No estimation or fallback logic is applied here.

import type { StateTaxRules } from "./stateTaxEngine";
import { loadStateRules } from "./stateTaxEngine";

export function loadStateTax(
  year: number,
  state: string
): StateTaxRules | null {
  return loadStateRules(year, state);
}
