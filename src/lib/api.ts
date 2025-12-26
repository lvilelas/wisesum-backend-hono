import type { GetToken } from "@clerk/types";

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

export function getBackendUrl() {
  return normalizeBaseUrl(
    process.env.NEXT_PUBLIC_BACKEND_URL || "https://api.wisesum.app"
  );
}

export function buildApiUrl(path: string) {
  const base = getBackendUrl();
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

type AuthedFetchOptions = RequestInit & {
  /** Se você criar template no Clerk, coloque aqui. Se não, deixe undefined. */
  template?: string;
  /** Força erro se token vier null (evita requests “anônimas” sem querer). */
  requireAuth?: boolean;
};

/**
 * fetch com Authorization Bearer (Clerk) + base URL centralizada.
 * Use sempre para rotas protegidas do backend.
 */
export async function authedFetch(
  getToken: GetToken,
  path: string,
  options: AuthedFetchOptions = {}
) {
  const { template, requireAuth = true, ...init } = options;

  const token = await getToken(template ? { template } : undefined);

  if (requireAuth && !token) {
    throw new Error("Missing auth token (user not signed in / not loaded)");
  }

  const url = buildApiUrl(path);

  const headers = new Headers(init.headers);

  // só define Content-Type automaticamente se tiver body e ainda não estiver definido
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (token) headers.set("Authorization", `Bearer ${token}`);

  return fetch(url, { ...init, headers });
}

export async function authedJson<T>(
  getToken: GetToken,
  path: string,
  options: AuthedFetchOptions = {}
): Promise<T> {
  const res = await authedFetch(getToken, path, options);

  if (!res.ok) {
    // tenta extrair uma msg útil
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }

  return (await res.json()) as T;
}
