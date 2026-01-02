// src/routes/pdf.ts
import { Hono } from "hono";
import { signPdfToken } from "../lib/pdfToken";
import { generatePdfFromHtml } from "../services/pdfService";

export const pdfRoute = new Hono();

/**
 * GET /api/pdf?simulationId=...&type=1099w2
 * (also accepts reportType=...)
 */
pdfRoute.get("/pdf", async (c) => {
  try {
    const url = new URL(c.req.url);
    console.log("PARAMS =", Array.from(url.searchParams.entries()));

    const simulationId = url.searchParams.get("simulationId");

    // support both ?type= and ?reportType=
    const rawType =
      url.searchParams.get("reportType") ?? url.searchParams.get("type");

    const reportType = normalizeReportType(rawType);

    if (!simulationId) {
      return c.json({ message: "Missing simulationId" }, 400);
    }

    if (!c.env.PDF_TOKEN_SECRET) {
      return c.json({ message: "Missing PDF_TOKEN_SECRET" }, 500);
    }

    // 1) sign short-lived token
    const expSeconds = Math.floor(Date.now() / 1000) + 60 * 10;

    const pdfToken = await signPdfToken(
      { simulationId: String(simulationId), reportType }, // ✅ normalized
      c.env.PDF_TOKEN_SECRET,
      expSeconds
    );

    // 2) fetch HTML from our own worker route
    const base = new URL(c.req.url);
    base.pathname = "/api/report-html";
    base.search = "";

    base.searchParams.set("simulationId", String(simulationId));
    base.searchParams.set("reportType", reportType);
    base.searchParams.set("pdfToken", pdfToken);

    const htmlRes = await fetch(base.toString());

    if (!htmlRes.ok) {
      const errText = await htmlRes.text().catch(() => "");
      return c.json(
        {
          message: `Failed to render report HTML (${htmlRes.status})`,
          detail: errText,
        },
        500
      );
    }

    const html = await htmlRes.text();

    // 3) generate PDF from HTML
    const pdfArrayBuffer = await generatePdfFromHtml(c.env, html);

    return new Response(pdfArrayBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="report-${simulationId}.pdf"`,
      },
    });
  } catch (e: any) {
    console.error("PDF route error:", e);
    return c.json({ message: e?.message || "PDF generation failed" }, 500);
  }
});

function normalizeReportType(raw: string | null): "1099w2" | "seTax" {
  // default if missing
  const v = String(raw ?? "1099w2").trim();
  if (v === "seTax") return "seTax";
  return "1099w2";
}
