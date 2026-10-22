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

/** One redirect to the business picker per page load, however many calls fail. */
let redirectingToPicker = false;

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

interface RawResponse {
  status: number;
  statusText: string;
  ok: boolean;
  text: string;
}

async function fetchRaw(url: string, init: RequestInit): Promise<RawResponse> {
  const res = await fetch(url, init);
  return {
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    text: res.status === 204 ? '' : await res.text(),
  };
}

/**
 * Identical GETs in flight at the same moment share one request. The shell
 * mounts several providers that each ask for the member, the locations and
 * the register settings, and a page's own panels ask again — on the owner
 * dashboard three of twenty-one calls per load were duplicates, on the
 * register two of fifteen. Only concurrent requests are shared (nothing is
 * cached), so a refetch after a mutation still hits the server. Each caller
 * keeps its own AbortSignal: aborting one never cancels the others.
 */
const inflight = new Map<string, Promise<RawResponse>>();

function sharedGet(
  url: string,
  init: RequestInit,
  signal: AbortSignal | null | undefined,
): Promise<RawResponse> {
  const key = `${url}#${JSON.stringify(init.headers ?? {})}`;
  let shared = inflight.get(key);
  if (!shared) {
    shared = fetchRaw(url, { ...init, signal: undefined }).finally(() => inflight.delete(key));
    inflight.set(key, shared);
  }
  if (!signal) return shared;
  return new Promise<RawResponse>((resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    shared.then(
      (r) => {
        signal.removeEventListener('abort', abort);
        resolve(r);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${apiUrl}${path}`;
  const request: RequestInit = {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  };
  const method = (init?.method ?? 'GET').toUpperCase();
  let res: RawResponse;
  try {
    res =
      method === 'GET' && init?.body == null
        ? await sharedGet(url, request, init?.signal)
        : await fetchRaw(url, request);
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
    const text = res.text;
    let message = `${res.status} ${res.statusText}`;
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
      if (typeof body.message === 'string') message = body.message;
    } catch {
      if (text) message = text;
    }
    // Several businesses and none picked (the picker cookie expires after
    // 30 days while the session lives on): send them to the picker, then
    // back here, instead of leaving every panel on the raw error. Someone
    // in one business never gets here — the API picks it — and someone in
    // none yet (a fresh sign-up) is left where they are.
    if (
      res.status === 412 &&
      body?.code === 'BUSINESS_NOT_SELECTED' &&
      typeof window !== 'undefined' &&
      !redirectingToPicker &&
      !window.location.pathname.startsWith('/welcome')
    ) {
      redirectingToPicker = true;
      const back = window.location.pathname + window.location.search;
      window.location.assign(`/welcome?next=${encodeURIComponent(back)}`);
    }
    throw new ApiError(res.status, message, body);
  }
  if (res.status === 204) return undefined as T;
  return JSON.parse(res.text) as T;
}
