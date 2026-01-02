// src/lib/tax/stateBaseCalc.ts
//
// Central, reusable engine to compute:
//   federalAGI -> stateAGI (conformity adjustments)
//   stateAGI   -> taxableStateIncome (state deductions)
//
// ✅ Cloudflare Workers compatible: no fs/path usage.
// ✅ Uses a small, safe expression evaluator for the case/branching AST.

import compiledBase2026 from "../../data/stateBaseRules.full.computed.2026.json" assert { type: "json" };

export type FilingStatus = "single" | "mfj" | "mfs" | "hoh";

export type StateBaseRulesFile = {
  version: string;
  states: Record<string, StateBaseRules>;
  globalRequiredInputs?: string[];
  notes?: string;
};

export type StateBaseRules = {
  meta?: { hasIncomeTax?: boolean };
  startingPoint?: {
    type?: "federalAGI" | "federalTaxableIncome" | "stateDefined";
    ircConformity?: { mode?: "rolling" | "fixed_date"; date?: string };
  };
  adjustments?: {
    additions?: Rule[];
    subtractions?: Rule[];
  };
  deductions?: {
    standardDeduction?: {
      // MVP: the compiler wrote a `default` number for safe baseline.
      // Some future versions might also provide filing-status map.
      default?: number;
      byStatus?: Partial<Record<FilingStatus, number>>;
    };
    personalExemption?: {
      default?: number;
      byStatus?: Partial<Record<FilingStatus, number>>;
    };
    itemizedRules?: Rule[];
  };
  credits?: {
    refundable?: Rule[];
    nonRefundable?: Rule[];
  };
  requiredInputs?: string[];
  notes?: string;
};

export type Rule = {
  id: string;
  kind: "addition" | "subtraction" | "deduction" | "credit";
  affects: "stateAGI" | "taxableStateIncome" | "totalTax";
  description?: string;
  status?: "ok" | "needs_detail";
  enabled?: boolean;
  when?: Expr; // boolean-ish
  amount?: Expr; // numeric
  requires?: string[];
  reference?: unknown;
};

// Small AST used by the compiled rules.
export type Expr =
  | { op: "constant"; value: number }
  | { op: "value"; path: string }
  | { op: ">" | ">=" | "<" | "<=" | "==" | "!="; path: string; value: number }
  | { op: "mul"; args: Expr[] }
  | { op: "min" | "max"; args: Expr[] }
  | {
      op: "case";
      cases: Array<{ when: Expr; then: Expr }>;
      default: Expr;
    };

export type EvalContext = {
  year: number;
  state: string;
  filingStatus: FilingStatus;
  // Your app's input payload (you can pass your full input object here).
  input: Record<string, unknown>;
  // Values available during evaluation
  federalAGI: number;
  federalTaxableIncome?: number;
  stateAGI?: number;
};

export type ApplyResult = {
  value: number;
  applied: Array<{ id: string; amount: number; kind: Rule["kind"]; description?: string }>;
  warnings: string[];
  missingInputs: string[];
};

/* =========================
   Registry + loaders
========================= */

const REGISTRY: Record<number, StateBaseRulesFile> = {
  2026: compiledBase2026 as unknown as StateBaseRulesFile,
};

const CACHE: Record<string, StateBaseRules | null> = {};

export function loadStateBaseRules(year: number, stateRaw: string): StateBaseRules {
  const y = Number(year);
  const state = normalizeState(stateRaw);

  const file = REGISTRY[y];
  if (!file?.states) {
    throw new Error(`State base rules not available for year ${y}`);
  }

  const key = `${y}:${state}`;
  const cached = CACHE[key];
  if (cached) return cached;

  const rules = file.states[state] ?? null;
  if (!rules) {
    throw new Error(`State base rules missing for ${state} (${y})`);
  }

  CACHE[key] = rules;
  return rules;
}

/* =========================
   Public API
========================= */

/**
 * Computes stateAGI by applying state conformity adjustments.
 *
 * Safe-by-default behavior:
 * - Rules with enabled:false are skipped.
 * - Rules with status:needs_detail are skipped + warning.
 * - Unknown/unsupported ops return 0 + warning.
 */
export function applyStateConformity(
  federalAGI: number,
  stateRules: StateBaseRules,
  ctx: Omit<EvalContext, "federalAGI" | "stateAGI"> & { federalTaxableIncome?: number }
): ApplyResult {
  const warnings: string[] = [];
  const applied: ApplyResult["applied"] = [];
  const missingInputs: string[] = [];

  const baseType = stateRules.startingPoint?.type ?? "federalAGI";
  let base = Number(federalAGI || 0);

  if (baseType === "federalTaxableIncome") {
    if (ctx.federalTaxableIncome == null) {
      warnings.push("startingPoint.federalTaxableIncome_missing_using_federalAGI");
    } else {
      base = Number(ctx.federalTaxableIncome || 0);
    }
  } else if (baseType === "stateDefined") {
    // We cannot compute a true state-defined base with only federalAGI.
    warnings.push("startingPoint.stateDefined_fallback_to_federalAGI");
  }

  const evalCtx: EvalContext = {
    ...ctx,
    federalAGI: Number(federalAGI || 0),
    stateAGI: base,
  };

  const additions = stateRules.adjustments?.additions ?? [];
  const subtractions = stateRules.adjustments?.subtractions ?? [];

  let totalAdd = 0;
  let totalSub = 0;

  for (const rule of additions) {
    const r = evalRule(rule, evalCtx, warnings, missingInputs);
    if (!r.applied) continue;
    totalAdd += r.amount;
    applied.push({ id: rule.id, kind: rule.kind, amount: r.amount, description: rule.description });
  }

  // update stateAGI so subtractions that depend on it can see it.
  evalCtx.stateAGI = base + totalAdd;

  for (const rule of subtractions) {
    const r = evalRule(rule, evalCtx, warnings, missingInputs);
    if (!r.applied) continue;
    totalSub += r.amount;
    applied.push({ id: rule.id, kind: rule.kind, amount: -r.amount, description: rule.description });
  }

  const value = clamp0(base + totalAdd - totalSub);
  return { value, applied, warnings: uniq(warnings), missingInputs: uniq(missingInputs) };
}

/**
 * Computes taxableStateIncome from stateAGI by applying deductions.
 *
 * Notes:
 * - This uses safe defaults from the compiled rules (standardDeduction.default, personalExemption.default).
 * - If you later add itemized rules, pass useItemized + input fields and implement in this function.
 */
export function applyStateDeductions(
  stateAGI: number,
  stateRules: StateBaseRules,
  ctx: Omit<EvalContext, "stateAGI" | "federalAGI"> & { federalAGI: number; useItemized?: boolean }
): ApplyResult {
  const warnings: string[] = [];
  const applied: ApplyResult["applied"] = [];
  const missingInputs: string[] = [];

  const filingStatus = ctx.filingStatus;

  const std =
    stateRules.deductions?.standardDeduction?.byStatus?.[filingStatus] ??
    stateRules.deductions?.standardDeduction?.default ??
    0;

  const pe =
    stateRules.deductions?.personalExemption?.byStatus?.[filingStatus] ??
    stateRules.deductions?.personalExemption?.default ??
    0;

  let deductionTotal = Number(std || 0) + Number(pe || 0);
  if (std) applied.push({ id: "STD_DEDUCTION", kind: "deduction", amount: Number(std), description: "Standard deduction" });
  if (pe) applied.push({ id: "PERSONAL_EXEMPTION", kind: "deduction", amount: Number(pe), description: "Personal exemption" });

  // Optional itemized rules (MVP-safe): apply only if explicitly requested.
  if (ctx.useItemized) {
    const rules = stateRules.deductions?.itemizedRules ?? [];
    const evalCtx: EvalContext = { ...ctx, stateAGI: Number(stateAGI || 0), federalTaxableIncome: ctx.federalTaxableIncome, state: ctx.state, year: ctx.year };
    for (const rule of rules) {
      const r = evalRule(rule, evalCtx, warnings, missingInputs);
      if (!r.applied) continue;
      deductionTotal += r.amount;
      applied.push({ id: rule.id, kind: "deduction", amount: r.amount, description: rule.description });
    }
  }

  const value = clamp0(Number(stateAGI || 0) - deductionTotal);
  return { value, applied, warnings: uniq(warnings), missingInputs: uniq(missingInputs) };
}

/* =========================
   Rule evaluation
========================= */

function evalRule(
  rule: Rule,
  ctx: EvalContext,
  warnings: string[],
  missingInputs: string[]
): { applied: boolean; amount: number } {
  if (rule.enabled === false) return { applied: false, amount: 0 };
  if (rule.status === "needs_detail") {
    warnings.push(`rule_needs_detail:${rule.id}`);
    return { applied: false, amount: 0 };
  }

  // Track missing inputs up front (best-effort)
  for (const req of rule.requires ?? []) {
    if (getPath(req, ctx) == null) missingInputs.push(req);
  }

  const whenExpr = rule.when;
  const applies = whenExpr ? toBool(evalExpr(whenExpr, ctx, warnings, missingInputs)) : true;
  if (!applies) return { applied: false, amount: 0 };

  const amountExpr = rule.amount;
  if (!amountExpr) return { applied: false, amount: 0 };

  const amt = toNum(evalExpr(amountExpr, ctx, warnings, missingInputs));
  return { applied: true, amount: clamp0(amt) };
}

function evalExpr(expr: Expr, ctx: EvalContext, warnings: string[], missingInputs: string[]): unknown {
  switch (expr.op) {
    case "constant":
      return Number(expr.value || 0);
    case "value": {
      const v = getPath(expr.path, ctx);
      if (v == null) missingInputs.push(expr.path);
      return Number(v || 0);
    }
    case ">":
    case ">=":
    case "<":
    case "<=":
    case "==":
    case "!=": {
      const left = Number(getPath(expr.path, ctx) || 0);
      const right = Number(expr.value || 0);
      switch (expr.op) {
        case ">":
          return left > right;
        case ">=":
          return left >= right;
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case "==":
          return left === right;
        case "!=":
          return left !== right;
      }
    }
    case "mul": {
      const nums = expr.args.map((a) => toNum(evalExpr(a, ctx, warnings, missingInputs)));
      return nums.reduce((acc, n) => acc * n, 1);
    }
    case "min": {
      const nums = expr.args.map((a) => toNum(evalExpr(a, ctx, warnings, missingInputs)));
      return Math.min(...nums);
    }
    case "max": {
      const nums = expr.args.map((a) => toNum(evalExpr(a, ctx, warnings, missingInputs)));
      return Math.max(...nums);
    }
    case "case": {
      for (const c of expr.cases ?? []) {
        const ok = toBool(evalExpr(c.when, ctx, warnings, missingInputs));
        if (ok) return evalExpr(c.then, ctx, warnings, missingInputs);
      }
      return evalExpr(expr.default, ctx, warnings, missingInputs);
    }
    default:
      warnings.push(`unsupported_op:${(expr as any).op}`);
      return 0;
  }
}

/* =========================
   Path resolver
========================= */

function getPath(path: string, ctx: EvalContext): unknown {
  const p = String(path || "").trim();
  if (!p) return undefined;

  // Allow direct access to common computed values
  if (p === "federalAGI") return ctx.federalAGI;
  if (p === "federalTaxableIncome") return ctx.federalTaxableIncome;
  if (p === "stateAGI") return ctx.stateAGI;
  if (p === "filingStatus") return ctx.filingStatus;

  // Default: look inside input object
  return (ctx.input as any)?.[p];
}

/* =========================
   Helpers
========================= */

const normalizeState = (s: string) => String(s || "").toUpperCase().trim();
const clamp0 = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const toNum = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const toBool = (v: unknown) => Boolean(v);
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));
