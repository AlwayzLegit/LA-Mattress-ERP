/** Join class names, dropping falsy parts. */
export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}
