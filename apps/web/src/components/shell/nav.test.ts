import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it('keeps chat gated off in both navigation variants', async () => {
  vi.stubEnv('NEXT_PUBLIC_LIVE_CHAT_ENABLED', 'false');
  vi.resetModules();
  const { navFor } = await import('./nav');
  for (const role of ['Owner', 'Cashier'])
    expect(
      navFor(role, [])
        .flatMap((g) => g.items)
        .some((i) => i.href === '/chat'),
    ).toBe(false);
});
it('keeps enabled chat reachable for store staff in the redesigned shell', async () => {
  vi.stubEnv('NEXT_PUBLIC_LIVE_CHAT_ENABLED', 'true');
  vi.resetModules();
  const { navFor } = await import('./nav');
  for (const role of ['Owner', 'Cashier', 'Chat Agent', 'Chat Receptionist']) {
    expect(
      navFor(role, [])
        .flatMap((g) => g.items)
        .filter((i) => i.href === '/chat'),
    ).toHaveLength(1);
    expect(
      navFor(role, ['/chat'])
        .flatMap((g) => g.items)
        .some((i) => i.href === '/chat'),
    ).toBe(false);
  }
});
