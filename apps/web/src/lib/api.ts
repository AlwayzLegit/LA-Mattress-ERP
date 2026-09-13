// Tiny fetch wrapper used by the admin pages. Always sends credentials so
// the session cookie + impersonate cookies travel with each request.
//
// `apiUrl` used to point at a separate origin (NEXT_PUBLIC_API_URL); after
// Phase 2.21 the API runs as a Vercel function on the same origin as the
// web app, so the value is empty string by default and every call goes
// out as a relative URL. Setting NEXT_PUBLIC_API_URL is still supported
// for local dev pointing at a separate API server.
import { isOutageStatus, noteFailure, noteSuccess } from './api-status';

export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '';

/**
 * Error with the parsed response body attached, so callers can react to
 * structured API errors — e.g. `code: 'OVERRIDE_REQUIRED'` from the
 * security-override guard opens the authorization dialog instead of a
 * toast.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, message: string, body: Record<string, unknown> | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  get code(): string | null {
    const c = this.body?.code;
    return typeof c === 'string' ? c : null;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      ...init,
    });
  } catch (err) {
    // A network failure (not an HTTP error): the server is unreachable or
    // the request was aborted. Only the former is an outage.
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      noteFailure(err instanceof Error ? err.message : 'network error');
    }
    throw err;
  }
  if (isOutageStatus(res.status)) noteFailure(`${res.status} ${res.statusText}`);
  else noteSuccess();
  if (!res.ok) {
    const text = await res.text();
    let message = `${res.status} ${res.statusText}`;
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      if (text) message = text;
    }
    throw new ApiError(res.status, message, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
