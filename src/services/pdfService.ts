// src/services/pdfService.ts

type PdfFormat =
  | "letter"
  | "legal"
  | "tabloid"
  | "ledger"
  | "a0"
  | "a1"
  | "a2"
  | "a3"
  | "a4"
  | "a5"
  | "a6";

type PdfOptions = {
  format?: PdfFormat | string; // aceita string pra normalizar "Letter", "A4"
  printBackground?: boolean;
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
};

type EnvLike = {
  CLOUDFLARE_ACCOUNT_ID: string;
  CF_BROWSER_RENDERING_API_TOKEN: string;
};

const ALLOWED_FORMATS = new Set<PdfFormat>([
  "letter",
  "legal",
  "tabloid",
  "ledger",
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
]);

function normalizeFormat(format?: unknown): PdfFormat {
  const v = String(format ?? "a4").toLowerCase();
  return ALLOWED_FORMATS.has(v as PdfFormat) ? (v as PdfFormat) : "a4";
}

export async function generatePdfFromHtml(
  env: EnvLike,
  html: string,
  pdfOptions?: PdfOptions
) {
  if (!env.CLOUDFLARE_ACCOUNT_ID)
    throw new Error("Missing CLOUDFLARE_ACCOUNT_ID");

  if (!env.CF_BROWSER_RENDERING_API_TOKEN)
    throw new Error("Missing BROWSER_RENDERING_API_TOKEN");

  if (!html) throw new Error("Missing HTML");

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-rendering/pdf`;

  const mergedOptions = {
    printBackground: true,
    margin: {
      top: "12mm",
      right: "12mm",
      bottom: "12mm",
      left: "12mm",
    },
    ...(pdfOptions ?? {}),
  };

  const body = {
    html,
    pdfOptions: {
      ...mergedOptions,
      // ✅ SEMPRE normalizar no final
      format: normalizeFormat(mergedOptions.format),
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_BROWSER_RENDERING_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(
      `Browser Rendering /pdf failed (${res.status}): ${txt}`
    );
  }

  return await res.arrayBuffer();
}
