import { SignJWT, jwtVerify } from "jose";

export type PdfTokenPayload = {
  simulationId: string;
  reportType?: string; // ✅ novo (opcional para não quebrar antigo)
};

function keyFromSecret(secret: string) {
  return new TextEncoder().encode(secret);
}

export async function signPdfToken(
  payload: PdfTokenPayload,
  secret: string,
  expSeconds: number
): Promise<string> {
  if (!secret) throw new Error("Missing PDF_TOKEN_SECRET");

  return new SignJWT({
    simulationId: String(payload.simulationId),
    ...(payload.reportType ? { reportType: String(payload.reportType) } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expSeconds)
    .sign(keyFromSecret(secret));
}

export async function verifyPdfToken(token: string, secret: string): Promise<PdfTokenPayload> {
  if (!secret) throw new Error("Missing PDF_TOKEN_SECRET");
  if (!token) throw new Error("Missing pdfToken");

  const { payload } = await jwtVerify(token, keyFromSecret(secret), {
    algorithms: ["HS256"],
  });

  const simulationId = payload?.simulationId;
  if (!simulationId || typeof simulationId !== "string") {
    throw new Error("Invalid pdfToken payload");
  }

  const reportType = typeof payload?.reportType === "string" ? payload.reportType : undefined;

  return { simulationId, reportType };
}
