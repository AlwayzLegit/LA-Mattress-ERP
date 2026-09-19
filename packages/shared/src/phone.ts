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

/**
 * "818-555-0142" for a 10-digit US number (owner 2026-09-19: dashes, the
 * same shape everywhere a phone shows); anything else comes back as typed.
 */
export function formatPhone(raw: string | null | undefined): string {
  const d = phoneDigits(raw);
  if (d.length !== 10) return raw ?? '';
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * Live formatting for a phone field: dashes appear as the digits are
 * typed ("8188" → "818-8", "8188005" → "818-800-5"). A leading "1" on an
 * 11-digit number is dropped. Text that is not a plain US number (a "+"
 * country code, letters, an extension) is left exactly as typed so
 * international and "x123" entries still work.
 */
export function formatPhoneAsTyped(raw: string): string {
  if (!raw) return '';
  if (/[^\d\s().-]/.test(raw)) return raw;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length > 10) return raw;
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}
