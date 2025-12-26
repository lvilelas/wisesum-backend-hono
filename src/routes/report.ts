import { Hono } from "hono";
import type { Env } from "../env";
import { getSupabase } from "../lib/supabaseEdge";
import { verifyPdfToken } from "../lib/pdfToken";
import {
  computeSimulation,
  buildPremiumResult,
  StateCode,
} from "../services/simulationService";

export const reportRoute = new Hono<{ Bindings: Env }>();

/**
 * GET /api/report?simulationId=123&pdfToken=...
 *
 * ✅ Novo comportamento:
 * 1) valida pdfToken
 * 2) busca report_snapshot no Supabase e retorna (sem recalcular)
 * 3) fallback: se não existir snapshot (simulação antiga), recalcula 1x,
 *    salva report_snapshot e retorna.
 */
reportRoute.get("/report", async (c) => {
  try {
    const simulationId = c.req.query("simulationId") || "";
    const pdfToken = c.req.query("pdfToken") || "";

    if (!simulationId || !pdfToken) {
      return c.json({ message: "simulationId and pdfToken are required" }, 400);
    }

    if (!c.env.PDF_TOKEN_SECRET) {
      return c.json({ message: "Missing PDF_TOKEN_SECRET" }, 500);
    }

    // ✅ valida token (sem logs de secret/token)
    const payload = await verifyPdfToken(pdfToken, c.env.PDF_TOKEN_SECRET).catch(
      () => null
    );

    if (!payload || String(payload.simulationId) !== String(simulationId)) {
      return c.json({ message: "Invalid pdfToken" }, 401);
    }

    const supabase = getSupabase(c.env);

    // ✅ pega snapshot se existir
    const { data, error } = await supabase
      .from("simulations")
      .select("id, state, w2_salary, income_1099, expenses, report_snapshot")
      .eq("id", simulationId)
      .single();

    if (error || !data) {
      return c.json({ message: "Simulation not found" }, 404);
    }

    if (data.report_snapshot) {
      return new Response(JSON.stringify(data.report_snapshot), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });
    }

    // ✅ fallback: simulação antiga sem snapshot -> recalcula 1x, salva, devolve
    const state = String(data.state || "").toUpperCase() as StateCode;

    const computed = await computeSimulation({
      w2Salary: Number(data.w2_salary || 0),
      income1099: Number(data.income_1099 || 0),
      expenses: Number(data.expenses || 0),
      state,
    });

    const premium = buildPremiumResult({
      computed,
      state,
      simulationId: String(data.id),
    });

    // salva snapshot best-effort
    await supabase
      .from("simulations")
      .update({
        report_snapshot: premium,
        report_version: 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", simulationId);

    return new Response(JSON.stringify(premium), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error(e);
    return c.json({ message: "Failed to load report data" }, 500);
  }
});
