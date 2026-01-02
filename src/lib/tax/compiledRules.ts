import compiled2026 from "../../data/compiled_2026_all_states.json" assert { type: "json" };

/**
 * Compiled state tax rules by year.
 *
 * IMPORTANT:
 * - This file MUST NOT contain calculations or estimates.
 * - It only maps a tax year to its precompiled JSON rules.
 * - Callers must explicitly choose the tax year.
 */

// Shape mínimo esperado para regras estaduais compiladas.
// (mantido propositalmente genérico para evitar regressão)
export type CompiledStateRules = Record<string, unknown>;

export const COMPILED_RULES: Record<number, CompiledStateRules> = {
  2026: compiled2026 as CompiledStateRules,
};
