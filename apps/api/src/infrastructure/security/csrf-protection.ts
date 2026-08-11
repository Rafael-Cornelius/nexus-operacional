const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

function normalizedOrigin(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

export function allowsMutationRequest(input: {
  method: string;
  origin?: string;
  secFetchSite?: string;
  allowedOrigin: string;
}) {
  if (safeMethods.has(input.method.toUpperCase())) return true;

  const fetchSite = input.secFetchSite?.trim().toLowerCase();
  if (fetchSite === "cross-site" || fetchSite === "same-site" || fetchSite === "none") {
    return false;
  }

  if (input.origin) {
    const requestOrigin = normalizedOrigin(input.origin);
    const allowedOrigin = normalizedOrigin(input.allowedOrigin);
    return Boolean(requestOrigin && allowedOrigin && requestOrigin === allowedOrigin);
  }

  // Clientes não navegadores podem omitir ambos. Navegadores modernos enviam
  // Origin e/ou Sec-Fetch-Site em mutações; valor explícito desconhecido falha.
  return !fetchSite || fetchSite === "same-origin";
}
