// src/routes/report-html.ts
import { Hono } from "hono";
import type { Env } from "../env";
import { verifyPdfToken } from "../lib/pdfToken";
import { isReportType, loadReportSnapshot } from "../services/reportRegistry";

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

function money2(n: any) {
  // para valores com centavos (fica mais "premium" no topo)
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "US$0.00";
  return (
    "US$" +
    v.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function pct(n: any) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return "0.0%";
  return (v * 100).toFixed(1) + "%";
}

function clampNumber(n: any) {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/** -------------------------
 * Templates
 * ------------------------*/
function html1099w2(result: any) {
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

function htmlSeTax(result: any) {
  const title = "Self-Employment Tax Report";
  const simId = esc(result?.simulationId ?? "");

  // números base
  const netProfit = clampNumber(result?.netProfit);
  const w2Wages = clampNumber(result?.w2Wages);
  const netEarnings = clampNumber(result?.netEarnings);

  const ssTaxable = clampNumber(result?.ssTaxable);
  const ssCapRemaining = clampNumber(result?.ssCapRemaining);
  const ssTax = clampNumber(result?.ssTax);

  const medicareTax = clampNumber(result?.medicareTax);
  const seTax = clampNumber(result?.seTax);

  const additionalMedicareTax = clampNumber(result?.additionalMedicareTax);
  const additionalMedicareThreshold = clampNumber(result?.additionalMedicareThreshold);

  const deductibleHalf = clampNumber(result?.deductibleHalf);
  const total = clampNumber(result?.total);

  // insights premium (tipo o frontend)
  const monthlySetAside = total / 12;
  const quarterlyPayment = total / 4;
  const taxImpactPct = netProfit > 0 ? total / netProfit : 0;

  const dueDates = ["Apr 15", "Jun 15", "Sep 15", "Jan 15"];

  // recommendations (geradas a partir dos dados)
  const recommendations: string[] = [];

  recommendations.push(
    `Set aside about ${money2(monthlySetAside)} per month in a separate “tax” account to avoid surprises.`
  );

  recommendations.push(
    `If your income is steady, consider quarterly estimated payments (~${money2(quarterlyPayment)} each): ${dueDates.join(
      " • "
    )}.`
  );

  recommendations.push(
    `Half of your SE tax is deductible (${money2(deductibleHalf)}), which can reduce your taxable income (income tax impact is separate from this estimate).`
  );

  if (w2Wages > 0) {
    recommendations.push(
      `Because you have W-2 wages, your remaining Social Security wage base matters. Wage base remaining: ${money2(
        ssCapRemaining
      )}.`
    );
  } else {
    recommendations.push(
      `No W-2 wages entered — you may pay the full Social Security portion on your net earnings until you reach the wage base cap.`
    );
  }

  if (additionalMedicareTax > 0) {
    recommendations.push(
      `You’re above the Additional Medicare threshold (${money2(
        additionalMedicareThreshold
      )}). If you expect income changes, revisit this estimate.`
    );
  } else {
    recommendations.push(
      `You’re below the Additional Medicare threshold (${money2(
        additionalMedicareThreshold
      )}). A large income jump could trigger additional Medicare tax.`
    );
  }

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

    .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    .stat { border:1px solid #e2e8f0; border-radius: 16px; padding: 14px; background:#f8fafc; }
    .stat .label { font-size: 12px; color:#64748b; }
    .stat .big { margin-top: 8px; font-size: 22px; font-weight: 800; color:#0f172a; }
    .stat .sub { margin-top: 4px; font-size: 12px; color:#64748b; }

    ul { margin: 0; padding-left: 18px; }
    li { margin: 6px 0; font-size: 13px; color:#334155; }

    .footer { font-size: 11px; color:#64748b; text-align:center; margin-top: 8px; }
    .divider { height:1px; background:#f1f5f9; margin: 10px 0; }
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
      <div><span class="badge premium">PREMIUM</span></div>
    </div>

    <div class="grid2">
      <div class="stat">
        <div class="label">Net earnings from SE (92.35%)</div>
        <div class="big">${money2(netEarnings)}</div>
        <div class="sub">Based on net profit: ${money2(netProfit)}</div>
      </div>
      <div class="stat">
        <div class="label">Total (incl. additional Medicare)</div>
        <div class="big">${money2(total)}</div>
        <div class="sub">Estimate</div>
      </div>
    </div>

    <div class="card">
      <h2>Inputs</h2>
      <div class="row"><div class="k">Tax year</div><div class="v">${esc(result?.taxYear ?? "")}</div></div>
      <div class="row"><div class="k">Filing status</div><div class="v">${esc(result?.filingStatus ?? "")}</div></div>
      <div class="row"><div class="k">Net profit (Schedule C)</div><div class="v">${money2(netProfit)}</div></div>
      <div class="row"><div class="k">W-2 wages</div><div class="v">${money2(w2Wages)}</div></div>
    </div>

    <div class="card">
      <h2>Breakdown</h2>
      <div class="row"><div class="k">Social Security taxable (capped)</div><div class="v">${money2(ssTaxable)}</div></div>
      <div class="row"><div class="k">Wage base remaining</div><div class="v">${money2(ssCapRemaining)}</div></div>
      <div class="divider"></div>
      <div class="row"><div class="k">Social Security tax</div><div class="v">${money2(ssTax)}</div></div>
      <div class="row"><div class="k">Medicare tax</div><div class="v">${money2(medicareTax)}</div></div>
      <div class="row"><div class="k">Self-employment tax (SS + Medicare)</div><div class="v">${money2(seTax)}</div></div>
      <div class="row"><div class="k">Deductible half of SE tax</div><div class="v">${money2(deductibleHalf)}</div></div>
      <div class="divider"></div>
      <div class="row"><div class="k">Additional Medicare tax (0.9%)</div><div class="v">${money2(additionalMedicareTax)}</div></div>
      <div class="row"><div class="k">Additional Medicare threshold</div><div class="v">${money2(additionalMedicareThreshold)}</div></div>
      <div class="row"><div class="k">Total (incl. additional Medicare)</div><div class="v">${money2(total)}</div></div>
    </div>

    <div class="card">
      <h2>Planning tools</h2>
      <div class="row"><div class="k">Monthly set-aside target</div><div class="v">${money2(monthlySetAside)}</div></div>
      <div class="row"><div class="k">Quarterly estimated payment (each)</div><div class="v">${money2(quarterlyPayment)}</div></div>
      <div class="row"><div class="k">Typical due dates</div><div class="v">${esc(dueDates.join(" • "))}</div></div>
      <div class="row"><div class="k">SE tax impact vs net profit</div><div class="v">${pct(taxImpactPct)}</div></div>
      <div class="muted" style="font-size:12px;margin-top:8px;">
        Note: This section helps planning for SE tax. Federal/state income tax is separate.
      </div>
    </div>

    <div class="card">
      <h2>Recommendations</h2>
      <ul>
        ${recommendations.map((r) => `<li>${esc(r)}</li>`).join("")}
      </ul>
    </div>

    <div class="footer">This tool does not provide legal or tax advice.</div>
    <div id="pdf-ready"></div>
  </div>
</body>
</html>`;
}

function renderHtmlByType(type: "1099w2" | "seTax", snapshot: any) {
  if (type === "seTax") return htmlSeTax(snapshot);
  return html1099w2(snapshot);
}

/** -------------------------
 * Route
 * ------------------------*/
reportHtmlRoute.get("/report-html", async (c) => {
  const simulationId = c.req.query("simulationId") || "";
  const pdfToken = c.req.query("pdfToken") || "";
  const typeRaw = c.req.query("reportType") || "1099w2";

  if (!simulationId || !pdfToken) return c.text("Missing simulationId/pdfToken", 400);
  if (!c.env.PDF_TOKEN_SECRET) return c.text("Missing PDF_TOKEN_SECRET", 500);
  if (!isReportType(typeRaw)) return c.text("Invalid type", 400);

  const payload = await verifyPdfToken(pdfToken, c.env.PDF_TOKEN_SECRET).catch(() => null);

  // valida simulationId + reportType
  if (
    !payload ||
    String(payload.simulationId) !== String(simulationId) ||
    String(payload.reportType) !== String(typeRaw)
  ) {
    return c.text("Invalid token", 401);
  }

  const loaded = await loadReportSnapshot(c.env, typeRaw, simulationId);
  if (!loaded.ok) return c.text(loaded.message, loaded.status);

  const html = renderHtmlByType(typeRaw, loaded.snapshot);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});
