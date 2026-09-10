import { describe, expect, it } from 'vitest';
import { textPagesToPdf, textPdfLinesPerPage } from './text-pdf';

describe('textPagesToPdf', () => {
  it('writes a valid single-font PDF with one page per input page', () => {
    const pdf = textPagesToPdf([['Line (one)', 'Back\\slash'], ['Page two']], {
      title: 'AR.317',
    });
    const s = pdf.toString('latin1');
    expect(s.startsWith('%PDF-1.4\n')).toBe(true);
    expect(s.endsWith('%%EOF\n')).toBe(true);
    expect(s).toContain('/BaseFont /Courier');
    expect(s).toContain('/Count 2');
    expect(s).toContain('/Title (AR.317)');
    // Parens and backslashes are escaped inside text strings.
    expect(s).toContain('(Line \\(one\\)) Tj');
    expect(s).toContain('(Back\\\\slash) Tj');
    expect(s).toContain('(Page two) Tj');
    // Landscape letter by default.
    expect(s).toContain('/MediaBox [0 0 792 612]');
  });

  it('points every xref entry at its object', () => {
    const pdf = textPagesToPdf([['a'], ['b'], ['c']]);
    const s = pdf.toString('latin1');
    const xrefAt = Number(/startxref\n(\d+)\n/.exec(s)![1]);
    expect(s.slice(xrefAt, xrefAt + 4)).toBe('xref');
    const entries = [...s.slice(xrefAt).matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((offset, i) => {
      expect(s.slice(offset, offset + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`);
    });
  });

  it('writes WinAnsi characters as octal bytes, `?` for the rest, 52 lines per landscape page', () => {
    const s = textPagesToPdf([['café — ok', 'ZOË DUBOIS €5 ☃']]).toString('latin1');
    // é = 0xE9, em dash = 0x97 (cp1252), Ë = 0xCB, € = 0x80; the snowman has no glyph.
    expect(s).toContain('(caf\\351 \\227 ok) Tj');
    expect(s).toContain('(ZO\\313 DUBOIS \\2005 ?) Tj');
    expect(textPdfLinesPerPage()).toBe(52);
    expect(textPdfLinesPerPage({ landscape: false })).toBe(69);
  });
});
