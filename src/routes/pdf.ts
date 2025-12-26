import { Hono } from "hono";
import type { Env } from "../env";
import { signPdfToken } from "../lib/pdfToken";

export const pdfRoute = new Hono<{ Bindings: Env }>();

pdfRoute.get("/pdf", async (c) => {
  try {
    const simulationId = c.req.query("simulationId");
    if (!simulationId) return c.json({ message: "Missing simulationId" }, 400);

    if (!c.env.CLOUDFLARE_ACCOUNT_ID) return c.json({ message: "Missing CLOUDFLARE_ACCOUNT_ID" }, 500);
    if (!c.env.CF_BROWSER_RENDERING_API_TOKEN)
      return c.json({ message: "Missing CF_BROWSER_RENDERING_API_TOKEN" }, 500);
    if (!c.env.PDF_TOKEN_SECRET) return c.json({ message: "Missing PDF_TOKEN_SECRET" }, 500);

    // ✅ 5 min
    const exp = Math.floor(Date.now() / 1000) + 60 * 5;

    const pdfToken = await signPdfToken(
      { simulationId: String(simulationId) },
      c.env.PDF_TOKEN_SECRET,
      exp
    );

    // ✅ Agora a URL que o headless abre é o próprio backend (remove Next da equação)
    const apiBase = (c.env.BACKEND_URL || "https://api.wisesum.app").trim().replace(/\/$/, "");
    const reportUrl =
      `${apiBase}/api/report-html?simulationId=${encodeURIComponent(String(simulationId))}` +
      `&pdfToken=${encodeURIComponent(pdfToken)}`;

    // sanity URL
    try {
      new URL(reportUrl);
    } catch {
      return c.json({ message: "Invalid reportUrl", reportUrl }, 500);
    }

    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${c.env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/pdf`;

    // ⚠️ NÃO logue reportUrl completo (vaza token). Logue só o path.
    console.log("Generating PDF via Browser Rendering:", `/api/report-html?simulationId=${simulationId}&pdfToken=***`);

    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.CF_BROWSER_RENDERING_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: reportUrl,
        gotoOptions: {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        },
        waitForSelector: {
          selector: "#pdf-ready",
          timeout: 60000,
        },
        actionTimeout: 60000,
      }),
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("Browser Rendering /pdf error:", r.status, text);
      return c.json(
        { message: "Browser Rendering /pdf failed", status: r.status, detail: text },
        502
      );
    }

    const pdfBytes = await r.arrayBuffer();

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="report-${simulationId}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    console.error("PDF route error:", e);
    return c.json({ message: e?.message ?? "PDF error" }, 500);
  }
});
