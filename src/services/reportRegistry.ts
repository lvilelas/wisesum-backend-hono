// src/services/reportRegistry.ts
import type { Env } from "../env";
import { getSupabase } from "../lib/supabaseEdge";

export type ReportType = "1099w2" | "seTax";

type RegistryEntry = {
  table: string;
  idColumn: string;              // normalmente "id"
  snapshotColumn: string;         // "report_snapshot"
};

const REGISTRY: Record<ReportType, RegistryEntry> = {
  // seu atual
  "1099w2": {
    table: "simulations",
    idColumn: "id",
    snapshotColumn: "report_snapshot",
  },

  // sua nova tabela
  "seTax": {
    table: "se_tax_simulations",
    idColumn: "id",
    snapshotColumn: "report_snapshot",
  },
};

export function isReportType(x: string): x is ReportType {
  return x === "1099w2" || x === "seTax";
}

export async function loadReportSnapshot(env: Env, type: ReportType, simulationId: string) {
  const entry = REGISTRY[type];
  const supabase = getSupabase(env);

  const { data, error } = await supabase
    .from(entry.table)
    .select(`${entry.snapshotColumn}`)
    .eq(entry.idColumn, simulationId)
    .single();

  if (error || !data) return { ok: false as const, status: 404 as const, message: "Simulation not found" };
  const snap = (data as any)?.[entry.snapshotColumn];
  if (!snap) return { ok: false as const, status: 500 as const, message: "Missing report_snapshot" };

  return { ok: true as const, snapshot: snap };
}
