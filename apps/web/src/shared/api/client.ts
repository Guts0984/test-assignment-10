export type ApiErrorBody = {
  error: { code: string; message: string; details?: unknown; requestId?: string };
};

/** Everything the api can tell us about a failed call. `status` 0 = the network itself failed. */
export type ApiError = Error & {
  readonly name: 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
};

export function makeApiError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): ApiError {
  return Object.assign(new Error(message), { name: 'ApiError' as const, status, code, details });
}

export const API_BASE = '/api';

type Options = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** Same-origin JSON call. The httpOnly session cookie travels automatically. */
export async function apiFetch<T>(path: string, o: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: o.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...o.headers,
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: o.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw makeApiError(0, 'network_error', 'Network error');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  if (!res.ok) {
    const err = (json as ApiErrorBody | null)?.error;
    throw makeApiError(
      res.status,
      err?.code ?? 'http_error',
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  return json as T;
}

export const isApiError = (e: unknown): e is ApiError =>
  e instanceof Error &&
  e.name === 'ApiError' &&
  typeof (e as { status?: unknown }).status === 'number';
