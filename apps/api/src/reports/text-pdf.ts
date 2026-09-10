/**
 * The smallest PDF that carries a fixed-width text report — one Courier
 * text object per page, no compression, no embedded font. It is the
 * exact shape STORIS's "Basic PDF" output takes (AR.317 arrives as
 * `/F0 9 Tf … (line)'` per line), so a Jetnine report saved this way
 * diffs cleanly against the STORIS file during the parallel run.
 *
 * Kept dependency-free on purpose: the API has no PDF library and a text
 * register does not need one.
 */

export interface TextPdfOptions {
  /** Points; STORIS prints AR.317 at 9pt. */
  fontSize?: number;
  /** Baseline-to-baseline distance in points (default fontSize × 1.15). */
  leading?: number;
  /** Letter landscape (792 × 612) by default — 132 Courier columns fit at 9pt. */
  landscape?: boolean;
  /** Left margin in points. */
  marginX?: number;
  /** Top margin in points. */
  marginTop?: number;
  title?: string;
}

/** Lines that fit on one page at the given geometry. */
export function textPdfLinesPerPage(opts: TextPdfOptions = {}): number {
  const fontSize = opts.fontSize ?? 9;
  const leading = opts.leading ?? Math.round(fontSize * 1.15 * 100) / 100;
  const height = opts.landscape === false ? 792 : 612;
  const marginTop = opts.marginTop ?? 36;
  return Math.max(1, Math.floor((height - marginTop * 2) / leading));
}

function escapePdfText(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code < 32 || code > 126) out += '?';
    else out += ch;
  }
  return out;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Render pages of pre-formatted text lines as a PDF document. */
export function textPagesToPdf(pages: string[][], opts: TextPdfOptions = {}): Buffer {
  const fontSize = opts.fontSize ?? 9;
  const leading = opts.leading ?? Math.round(fontSize * 1.15 * 100) / 100;
  const landscape = opts.landscape !== false;
  const width = landscape ? 792 : 612;
  const height = landscape ? 612 : 792;
  const marginX = opts.marginX ?? 39;
  const marginTop = opts.marginTop ?? 36;
  const firstBaseline = height - marginTop - 0.75;
  const pageList = pages.length > 0 ? pages : [[]];

  const objects: string[] = [];
  const add = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  const catalog = add(''); // 1, filled once the pages object exists
  const pagesObj = add(''); // 2
  const font = add(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  );
  const info = add(
    `<< /Producer (Jetnine) /Creator (Jetnine)${
      opts.title ? ` /Title (${escapePdfText(opts.title)})` : ''
    } /CreationDate (${pdfDate(new Date())}) >>`,
  );

  const pageIds: number[] = [];
  for (const lines of pageList) {
    const ops: string[] = ['BT', `/F1 ${fontSize} Tf`];
    lines.forEach((line, i) => {
      const y = (firstBaseline - i * leading).toFixed(2);
      ops.push(`1 0 0 1 ${marginX} ${y} Tm (${escapePdfText(line)}) Tj`);
    });
    ops.push('ET');
    const content = ops.join('\n');
    const contentId = add(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
    const pageId = add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
