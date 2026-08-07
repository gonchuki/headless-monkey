export interface AuthUser {
  login: string;
  role: "admin" | "editor";
}

export interface UserListItem {
  id: number;
  login: string;
  disabled: boolean;
}

export const TOKEN_STORAGE_KEY = "headless-monkey.token";
export const AUTH_UNAUTHORIZED_EVENT = "headless-monkey:unauthorized";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function isUnauthorizedError(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 401;
}

export function notifyUnauthorized(): void {
  clearStoredToken();
  window.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, { ...init, headers });

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? ((await response.json().catch(() => null)) as { error?: string } | null)
    : null;

  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? `Request failed with status ${response.status}`);
  }

  return body as T;
}
