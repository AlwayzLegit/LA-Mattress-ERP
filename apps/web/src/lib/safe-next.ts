/**
 * Where to go after /welcome: a same-origin path from `?next=`, else the
 * dashboard. The value is resolved against `origin` and kept only if it
 * stays there — "//evil.example", "/\\evil.example" and absolute URLs to
 * other hosts all fall back.
 */
export function safeNext(
  next: string | null,
  origin: string = typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
): string {
  if (!next) return '/dashboard';
  try {
    const u = new URL(next, origin);
    if (u.origin !== new URL(origin).origin) return '/dashboard';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/dashboard';
  }
}
