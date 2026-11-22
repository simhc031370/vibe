/** Minimal structural types so this module works with both the browser and Node builds of pdf.js. */
export interface PdfPageLike {
  getTextContent(): Promise<{ items: object[] }>;
}
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

export async function extractPageTexts(doc: PdfDocLike): Promise<string[]> {
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { items } = await page.getTextContent();
    let s = '';
    for (const it of items as { str?: unknown; hasEOL?: boolean }[]) {
      if (typeof it.str !== 'string') continue;
      s += it.str;
      if (it.hasEOL) s += '\n';
    }
    out.push(s.replace(/[ \t]+\n/g, '\n').trim());
  }
  return out;
}

export function textsToTxt(pages: string[]): string {
  return pages.map((t, i) => `===== Page ${i + 1} =====\n${t}`).join('\n\n') + '\n';
}

export interface SearchHit {
  page: number;
  index: number;
  snippet: string;
}

export function searchTexts(pages: string[], query: string, opts: { caseSensitive?: boolean; limit?: number } = {}): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const limit = opts.limit ?? 500;
  const needle = opts.caseSensitive ? q : q.toLocaleLowerCase();
  const hits: SearchHit[] = [];
  pages.forEach((raw, page) => {
    const text = raw.replace(/\s+/g, ' ');
    const hay = opts.caseSensitive ? text : text.toLocaleLowerCase();
    let from = 0;
    while (hits.length < limit) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const a = Math.max(0, idx - 30);
      const b = Math.min(text.length, idx + q.length + 30);
      hits.push({
        page,
        index: idx,
        snippet: (a > 0 ? '…' : '') + text.slice(a, b) + (b < text.length ? '…' : ''),
      });
      from = idx + needle.length;
    }
  });
  return hits;
}
