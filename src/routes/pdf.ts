// src/routes/pdf.ts (ou onde está sua rota)
import { Hono } from "hono";
import { signPdfToken } from "../lib/pdfToken";
import { generatePdfFromHtml } from "../services/pdfService";

export const pdfRoute = new Hono();

pdfRoute.get("/pdf", async (c) => {
  try {
    const url = new URL(c.req.url);
    console.log("PARAMS =", Array.from(url.searchParams.entries()));
    const reportType = url.searchParams.get("type");
    const simulationId = url.searchParams.get("simulationId");

    if (!simulationId) {
      return c.json({ message: "Missing simulationId" }, 400);
    }

    // 1) assina token curto
    const expSeconds = Math.floor(Date.now() / 1000) + 60 * 10;
    const pdfToken = await signPdfToken(
      { simulationId: String(simulationId), reportType }, // ✅ inclui reportType (ver item 3)
      c.env.PDF_TOKEN_SECRET,
      expSeconds
    );

    // 2) pega HTML internamente do seu próprio worker (não é URL pública)
    const base = new URL(c.req.url);
    base.pathname = "/api/report-html";
    base.search = "";

    base.searchParams.set("simulationId", String(simulationId));
    base.searchParams.set("reportType", reportType);
    base.searchParams.set("pdfToken", pdfToken);

    const htmlRes = await fetch(base.toString(), {
      headers: {
        // se seu /api/report-html precisar de headers adicionais, inclua aqui
        // (geralmente não precisa, porque autentica via pdfToken)
      },
    });

    if (!htmlRes.ok) {
      const errText = await htmlRes.text().catch(() => "");
      return c.json(
        { message: `Failed to render report HTML (${htmlRes.status})`, detail: errText },
        500
      );
    }

    const html = await htmlRes.text();

    // 3) gera PDF via HTML (Solução A)
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
