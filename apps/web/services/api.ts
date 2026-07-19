export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
// Credenciais publicas e exclusivas do preview estatico. Elas nunca autenticam na API operacional.
export const DEMO_ADMIN_EMAIL = process.env.NEXT_PUBLIC_DEMO_ADMIN_EMAIL ?? "admin@demo.nexus.local";
export const DEMO_ADMIN_PASSWORD = process.env.NEXT_PUBLIC_DEMO_ADMIN_PASSWORD ?? "NexusDemo@2026";

const sessionStorageKey = "nexus-session-user";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
}

export interface SessionData {
  user: SessionUser;
}

export const DEMO_SESSION: SessionData = {
  user: {
    id: "demo-user",
    email: DEMO_ADMIN_EMAIL,
    name: "Rafael — Administrador",
    roles: ["ADMIN"]
  }
};

let currentSession: SessionData | null = null;

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function isApiConflict(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.status === 409;
}

async function parseError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  if (typeof body?.message === "string") return body.message;
  if (Array.isArray(body?.message)) return body.message.filter((item: unknown) => typeof item === "string").join(" ") || fallback;
  if (typeof body?.message?.message === "string") return body.message.message;
  return fallback;
}

export async function apiGet<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      credentials: "include"
    });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export async function apiPost<T>(path: string, payload: unknown, fallback: T): Promise<T> {
  try {
    const response = await fetch(`${API_URL}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return fallback;
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}

export async function apiPostClient<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new ApiClientError(await parseError(response, "Nao foi possivel concluir a operacao."), response.status);
  }

  return (await response.json()) as T;
}

export async function apiUploadClient<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    credentials: "include",
    body: formData
  });

  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new Error(await parseError(response, "Nao foi possivel enviar o arquivo."));
  }

  return (await response.json()) as T;
}

export async function apiGetClient<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "include"
  });

  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new Error(await parseError(response, "Nao foi possivel carregar os dados."));
  }

  return (await response.json()) as T;
}

export async function apiPatchClient<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new Error(await parseError(response, "Nao foi possivel atualizar o registro."));
  }

  return (await response.json()) as T;
}

export async function apiDeleteClient<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "DELETE",
    credentials: "include"
  });

  if (!response.ok) {
    if (response.status === 401) clearSession();
    throw new Error(await parseError(response, "Nao foi possivel remover o registro."));
  }

  return (await response.json()) as T;
}

export async function fetchCurrentSession() {
  if (DEMO_MODE) {
    const session = getSession();
    if (!session) throw new Error("Sessao de preview nao encontrada.");
    return session;
  }
  const session = await apiGetClient<SessionData>("/auth/me");
  saveSession(session);
  return session;
}

export async function logoutSession() {
  if (DEMO_MODE) {
    clearSession();
    return;
  }
  await apiPostClient<{ ok: boolean }>("/auth/logout", {});
  clearSession();
}

export function saveSession(session: SessionData) {
  currentSession = { user: session.user };
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(sessionStorageKey, JSON.stringify(session.user));
}

export function getSession(): SessionData | null {
  if (currentSession) return currentSession;
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(sessionStorageKey);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as SessionUser;
    currentSession = { user };
    return currentSession;
  } catch {
    window.sessionStorage.removeItem(sessionStorageKey);
    return null;
  }
}

export function clearSession() {
  currentSession = null;
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(sessionStorageKey);
}
