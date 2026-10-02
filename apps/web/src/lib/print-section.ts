/**
 * Print one section of a page, not the whole page (owner 2026-10-01:
 * "if I click print, it prints all the reports, 411 pages. Each report
 * should print individually as needed").
 *
 * Marks the section `data-print-target` and every ancestor
 * `data-print-path`, and sets `printing-section` on <html>; the print
 * stylesheet (globals.css) then hides everything that is neither — so
 * the other reports take no pages at all. The marks come off after the
 * print dialog closes.
 */
export const PRINTING_CLASS = 'printing-section';

export function markPrintSection(target: HTMLElement): () => void {
  const root = target.ownerDocument.documentElement;
  const path: Element[] = [];
  for (let el = target.parentElement; el && el !== root; el = el.parentElement) {
    el.setAttribute('data-print-path', '');
    path.push(el);
  }
  target.setAttribute('data-print-target', '');
  root.classList.add(PRINTING_CLASS);
  return () => {
    root.classList.remove(PRINTING_CLASS);
    target.removeAttribute('data-print-target');
    for (const el of path) el.removeAttribute('data-print-path');
  };
}

export function printSection(target: HTMLElement): void {
  const win = target.ownerDocument.defaultView ?? window;
  const clear = markPrintSection(target);
  const done = () => {
    win.removeEventListener('afterprint', done);
    clear();
  };
  win.addEventListener('afterprint', done);
  win.print();
}
