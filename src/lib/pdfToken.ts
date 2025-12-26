import { SignJWT, jwtVerify } from "jose";

export type PdfTokenPayload = {
  simulationId: string;
};

function keyFromSecret(secret: string) {
  return new TextEncoder().encode(secret);
}

/**
 * Assina um token curto (HS256) para liberar a página/endpoint de PDF.
 * expSeconds: epoch seconds (ex: Math.floor(Date.now()/1000) + 60*5)
 */
export async function signPdfToken(
  payload: PdfTokenPayload,
  secret: string,
  expSeconds: number
): Promise<string> {
  if (!secret) throw new Error("Missing PDF_TOKEN_SECRET");

  return new SignJWT({ simulationId: String(payload.simulationId) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expSeconds) // jose aceita epoch seconds
    .sign(keyFromSecret(secret));
}

/**
 * Verifica token (HS256) e retorna payload.
 * Lança erro se inválido/expirado.
 */
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

  return { simulationId };
}
