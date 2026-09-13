/**
 * Phone normalisation for matching (redesign Phase 11, leads). Keeps the
 * digits only and drops a leading US country code so "(818) 555-0142",
 * "818.555.0142" and "+1 818 555 0142" all match. Returns '' when fewer
 * than 7 digits remain — too short to be a phone, never a match key.
 */
export function phoneDigits(raw: string | null | undefined): string {
  if (!raw) return '';
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length >= 7 ? d : '';
}

/** Two phones match when their normalised digits agree on the last 10. */
export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = phoneDigits(a);
  const y = phoneDigits(b);
  if (!x || !y) return false;
  return x.slice(-10) === y.slice(-10);
}

/** "(818) 555-0142" for a 10-digit number; anything else comes back as typed. */
export function formatPhone(raw: string | null | undefined): string {
  const d = phoneDigits(raw);
  if (d.length !== 10) return raw ?? '';
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
