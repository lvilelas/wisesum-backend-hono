import compiled2025 from "../../data/compiled_2025_all_states.json" assert { type: "json" };

// Tipagem leve (você pode substituir por StateTaxRules real se quiser)
export const COMPILED_RULES: Record<number, Record<string, any>> = {
  2025: compiled2025 as Record<string, any>,
};
