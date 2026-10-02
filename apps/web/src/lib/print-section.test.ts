import { describe, expect, it, vi } from 'vitest';
import { markPrintSection, printSection, PRINTING_CLASS } from './print-section';

/** Just enough of the DOM for the marker: attributes, parents, a root class list. */
class FakeEl {
  attrs = new Set<string>();
  classes = new Set<string>();
  classList = {
    add: (c: string) => void this.classes.add(c),
    remove: (c: string) => void this.classes.delete(c),
  };
  ownerDocument!: { documentElement: FakeEl; defaultView: unknown };
  constructor(public parentElement: FakeEl | null) {}
  setAttribute(n: string) {
    this.attrs.add(n);
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
}

function page() {
  const html = new FakeEl(null);
  const body = new FakeEl(html);
  const nav = new FakeEl(body);
  const main = new FakeEl(body);
  const z = new FakeEl(main);
  const other = new FakeEl(main);
  const listeners = new Map<string, () => void>();
  const win = {
    print: vi.fn(),
    addEventListener: (t: string, fn: () => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  for (const el of [html, body, nav, main, z, other]) {
    el.ownerDocument = { documentElement: html, defaultView: win };
  }
  return { html, body, nav, main, z, other, win, listeners };
}

describe('printSection', () => {
  it('marks only the target and its ancestors, then clears', () => {
    const { html, body, nav, main, z, other } = page();
    const clear = markPrintSection(z as unknown as HTMLElement);
    expect(html.classes.has(PRINTING_CLASS)).toBe(true);
    expect(z.attrs.has('data-print-target')).toBe(true);
    expect(main.attrs.has('data-print-path')).toBe(true);
    expect(body.attrs.has('data-print-path')).toBe(true);
    expect(other.attrs.size).toBe(0);
    expect(nav.attrs.size).toBe(0);
    clear();
    expect(html.classes.size).toBe(0);
    expect([z, main, body].every((el) => el.attrs.size === 0)).toBe(true);
  });

  it('prints with the marks on and clears them when the dialog closes', () => {
    const { z, win, listeners } = page();
    win.print.mockImplementation(() => expect(z.attrs.has('data-print-target')).toBe(true));
    printSection(z as unknown as HTMLElement);
    expect(win.print).toHaveBeenCalledOnce();
    listeners.get('afterprint')!();
    expect(z.attrs.size).toBe(0);
    expect(listeners.size).toBe(0);
  });
});
