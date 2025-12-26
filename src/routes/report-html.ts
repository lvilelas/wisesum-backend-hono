import { Hono } from "hono";
import type { Env } from "../env";
import { getSupabase } from "../lib/supabaseEdge";
import { verifyPdfToken } from "../lib/pdfToken";

export const reportHtmlRoute = new Hono<{ Bindings: Env }>();

function esc(s: any) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(n: any) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "US$0";
  return "US$" + Math.round(v).toLocaleString("en-US");
}

function pct(n: any) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "0.00%";
  return (v * 100).toFixed(2) + "%";
}

function htmlTemplate(result: any) {
  const summary: string[] = Array.isArray(result?.summary) ? result.summary : [];
  const assumptions: string[] = Array.isArray(result?.assumptions) ? result.assumptions : [];
  const recommendations: string[] = Array.isArray(result?.recommendations) ? result.recommendations : [];

  const title = "1099 vs W-2 Report";
  const simId = esc(result?.simulationId ?? "");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} #${simId}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    html, body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; color: #0f172a; }
    body { margin: 0; padding: 0; background: #fff; }
    .wrap { max-width: 900px; margin: 0 auto; }
    .muted { color: #64748b; }
    .badge { display:inline-block; padding: 4px 10px; border-radius: 999px; border:1px solid #e2e8f0; font-size: 12px; font-weight: 700; }
    .badge.premium { background:#ecfdf5; border-color:#bbf7d0; color:#065f46; }
    .badge.free { background:#f8fafc; border-color:#e2e8f0; color:#334155; }
    h1 { font-size: 22px; margin: 0; }
    h2 { font-size: 14px; margin: 0 0 10px; }
    .header { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; margin-bottom: 14px; }
    .card { border:1px solid #e2e8f0; border-radius: 16px; padding: 14px; margin-bottom: 12px; break-inside: avoid; page-break-inside: avoid; }
    .row { display:flex; justify-content:space-between; gap: 12px; padding: 8px 0; border-bottom:1px solid #f1f5f9; font-size: 13px; }
    .row:last-child { border-bottom: 0; }
    .k { color:#334155; }
    .v { font-weight: 700; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 6px 0; font-size: 13px; color:#334155; }
    .footer { font-size: 11px; color:#64748b; text-align:center; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="muted" style="font-size:12px;font-weight:700;letter-spacing:.04em;">WiseSum • Report</div>
        <h1>${esc(title)}</h1>
        <div class="muted" style="font-size:12px;margin-top:4px;">Simulation #${simId}</div>
      </div>
      <div>
        ${
          result?.type === "freeSummaryResult"
            ? `<span class="badge free">FREE</span>`
            : `<span class="badge premium">PREMIUM</span>`
        }
      </div>
    </div>

    <div class="card">
      <h2>Summary</h2>
      ${summary.map((s) => `<div style="font-size:13px;color:#334155;margin:6px 0;">${esc(s)}</div>`).join("")}
      ${
        result?.winner
          ? `<div style="font-size:13px;color:#334155;margin-top:10px;"><b>Winner:</b> ${esc(result.winner)}</div>`
          : ""
      }
    </div>

    <div class="card">
      <h2>W-2</h2>
      <div class="row"><div class="k">Federal tax</div><div class="v">${money(result?.federalTaxW2)}</div></div>
      <div class="row"><div class="k">State tax</div><div class="v">${money(result?.stateTaxW2)}</div></div>
      <div class="row"><div class="k">FICA</div><div class="v">${money(result?.ficaTaxW2)}</div></div>
      <div class="row"><div class="k">Effective rate</div><div class="v">${pct(result?.effectiveTaxRateW2)}</div></div>
    </div>

    <div class="card">
      <h2>1099</h2>
      <div class="row"><div class="k">Federal tax</div><div class="v">${money(result?.federalTax1099)}</div></div>
      <div class="row"><div class="k">State tax</div><div class="v">${money(result?.stateTax1099)}</div></div>
      <div class="row"><div class="k">Self-employment tax</div><div class="v">${money(result?.selfEmploymentTax1099)}</div></div>
      <div class="row"><div class="k">Effective rate</div><div class="v">${pct(result?.effectiveTaxRate1099)}</div></div>
    </div>

    ${
      assumptions.length
        ? `<div class="card"><h2>Assumptions</h2><ul>${assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`
        : ""
    }

    ${
      recommendations.length
        ? `<div class="card"><h2>Recommendations</h2><ul>${recommendations.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`
        : ""
    }

    <div class="footer">This tool does not provide legal or tax advice.</div>
    <div id="pdf-ready"></div>
  </div>
</body>
</html>`;
}

reportHtmlRoute.get("/report-html", async (c) => {
  const simulationId = c.req.query("simulationId") || "";
  const pdfToken = c.req.query("pdfToken") || "";

  if (!simulationId || !pdfToken) {
    return c.text("Missing simulationId/pdfToken", 400);
  }
  if (!c.env.PDF_TOKEN_SECRET) {
    return c.text("Missing PDF_TOKEN_SECRET", 500);
  }

  const payload = await verifyPdfToken(pdfToken, c.env.PDF_TOKEN_SECRET).catch(() => null);
  if (!payload || String(payload.simulationId) !== String(simulationId)) {
    return c.text("Invalid token", 401);
  }

  const supabase = getSupabase(c.env);
  const { data, error } = await supabase
    .from("simulations")
    .select("report_snapshot")
    .eq("id", simulationId)
    .single();

  if (error || !data) return c.text("Simulation not found", 404);
  if (!data.report_snapshot) return c.text("Missing report_snapshot", 500);

  const html = htmlTemplate(data.report_snapshot);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
