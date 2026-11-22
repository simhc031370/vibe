import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFDict, StandardFonts } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  merge,
  organize,
  extractPages,
  deletePages,
  rotatePages,
  splitEvery,
  parsePageRange,
  addWatermark,
  addPageNumbers,
  imagesToPdf,
  getMetadata,
  setMetadata,
  optimize,
  applyAnnotations,
  isWinAnsiEncodable,
  hexToRgb,
} from '../../src/core/pdf-ops';
import { extractPageTexts, searchTexts, textsToTxt } from '../../src/core/text';

// 1x1 red PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function makePdf(labels: string[], size: [number, number] = [300, 400]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const l of labels) doc.addPage(size).drawText(l, { x: 20, y: 300, size: 18, font });
  return doc.save();
}

async function texts(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false }).promise;
  try {
    return await extractPageTexts(doc);
  } finally {
    await doc.destroy();
  }
}

const pageCount = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();

describe('parsePageRange', () => {
  it('parses singles, ranges, open ranges, and reverse ranges', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange('8-', 10)).toEqual([7, 8, 9]);
    expect(parsePageRange('-2', 10)).toEqual([0, 1]);
    expect(parsePageRange('3-1', 10)).toEqual([2, 1, 0]);
  });
  it('rejects invalid input', () => {
    expect(() => parsePageRange('', 3)).toThrow();
    expect(() => parsePageRange('0', 3)).toThrow();
    expect(() => parsePageRange('4', 3)).toThrow();
    expect(() => parsePageRange('a-b', 3)).toThrow();
  });
});

describe('page operations', () => {
  it('merges documents in order', async () => {
    const out = await merge([await makePdf(['A1', 'A2']), await makePdf(['B1'])]);
    expect(await texts(out)).toEqual(['A1', 'A2', 'B1']);
  });

  it('organizes: reorder, rotate, insert blank', async () => {
    const src = await makePdf(['P1', 'P2', 'P3']);
    const out = await organize(src, [
      { kind: 'page', source: 2, rotate: 90 },
      { kind: 'blank' },
      { kind: 'page', source: 0, rotate: -90 },
    ]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(2).getRotation().angle).toBe(270);
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 400 });
    expect(await texts(out)).toEqual(['P3', '', 'P1']);
  });

  it('extracts, deletes, rotates, and splits', async () => {
    const src = await makePdf(['1', '2', '3', '4', '5']);
    expect(await texts(await extractPages(src, [4, 0]))).toEqual(['5', '1']);
    expect(await texts(await deletePages(src, [1, 3]))).toEqual(['1', '3', '5']);
    const rot = await PDFDocument.load(await rotatePages(src, [1], 180));
    expect(rot.getPage(0).getRotation().angle).toBe(0);
    expect(rot.getPage(1).getRotation().angle).toBe(180);
    const parts = await splitEvery(src, 2);
    expect(await Promise.all(parts.map(pageCount))).toEqual([2, 2, 1]);
    expect(await texts(parts[2])).toEqual(['5']);
    await expect(splitEvery(src, 0)).rejects.toThrow();
    await expect(organize(src, [])).rejects.toThrow();
  });
});

describe('page decorations', () => {
  it('adds a text watermark and page numbers', async () => {
    const src = await makePdf(['x', 'y']);
    const wm = await addWatermark(src, { text: 'CONFIDENTIAL' });
    expect((await texts(wm)).every((t) => t.includes('CONFIDENTIAL'))).toBe(true);
    const num = await addPageNumbers(src, { format: 'Page {n} of {total}' });
    const t = await texts(num);
    expect(t[0]).toContain('Page 1 of 2');
    expect(t[1]).toContain('Page 2 of 2');
  });

  it('requires a PNG fallback for non-Latin watermark text', async () => {
    const src = await makePdf(['x']);
    await expect(addWatermark(src, { text: '기밀' })).rejects.toThrow(/PNG/);
    const out = await addWatermark(src, { png: PNG });
    expect(await pageCount(out)).toBe(1);
  });
});

describe('conversion and metadata', () => {
  it('converts images to PDF', async () => {
    const out = await imagesToPdf([{ bytes: PNG, type: 'png' }, { bytes: PNG, type: 'png' }]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getSize()).toEqual({ width: 1, height: 1 });
    const a4 = await PDFDocument.load(await imagesToPdf([{ bytes: PNG, type: 'png' }], 'a4'));
    expect(Math.round(a4.getPage(0).getWidth())).toBe(595);
  });

  it('reads and writes metadata (including Unicode)', async () => {
    const out = await setMetadata(await makePdf(['m']), { title: '보고서 Report', author: 'Kim', keywords: ['a', 'b'] });
    const meta = await getMetadata(out);
    expect(meta.title).toBe('보고서 Report');
    expect(meta.author).toBe('Kim');
    expect(meta.keywords).toEqual(['a', 'b']);
    expect(meta.producer).toBe('vPDF');
  });

  it('optimizes without losing pages or text', async () => {
    const src = await makePdf(['o1', 'o2']);
    expect(await texts(await optimize(src))).toEqual(['o1', 'o2']);
  });

  it('extracts text and searches', async () => {
    const pages = await texts(await makePdf(['Hello World', 'hello again']));
    expect(searchTexts(pages, 'hello').map((h) => h.page)).toEqual([0, 1]);
    expect(searchTexts(pages, 'hello', { caseSensitive: true }).map((h) => h.page)).toEqual([1]);
    expect(searchTexts(pages, '  ')).toEqual([]);
    expect(textsToTxt(pages)).toContain('===== Page 2 =====\nhello again');
  });
});

describe('annotations', () => {
  it('burns in drawings/text and writes sticky notes as real annotations', async () => {
    const src = await makePdf(['base', 'second']);
    const out = await applyAnnotations(src, [
      { type: 'highlight', page: 0, rect: [10, 10, 100, 40], color: '#ffeb3b' },
      { type: 'rect', page: 0, rect: [100, 100, 20, 20], color: '#ff0000' },
      { type: 'whiteout', page: 1, rect: [0, 0, 50, 50] },
      { type: 'ink', page: 1, points: [[1, 1], [50, 50], [80, 20]], color: '#0000ff', width: 3 },
      { type: 'ink', page: 1, points: [[5, 5]], color: '#0000ff' },
      { type: 'text', page: 0, x: 20, y: 200, text: 'Added text\nline two', size: 12, color: '#000000' },
      { type: 'stamp', page: 1, x: 20, y: 200, text: 'APPROVED', size: 20, color: '#d32f2f' },
      { type: 'note', page: 0, x: 200, y: 380, text: '검토 필요 / please review', color: '#ffc107' },
      { type: 'image', page: 1, rect: [100, 100, 150, 150], png: PNG },
    ]);
    const t = await texts(out);
    expect(t[0]).toContain('Added text');
    expect(t[0]).toContain('line two');
    expect(t[1]).toContain('APPROVED');

    const doc = await PDFDocument.load(out);
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    const note = annots.lookup(0, PDFDict);
    expect(note.get(PDFName.of('Subtype'))).toEqual(PDFName.of('Text'));

    const js = await pdfjs.getDocument({ data: out.slice() }).promise;
    const pjAnnots = await (await js.getPage(1)).getAnnotations();
    expect(pjAnnots[0].contentsObj.str).toBe('검토 필요 / please review');
    await js.destroy();
  });

  it('returns input unchanged for no annotations and validates input', async () => {
    const src = await makePdf(['a']);
    expect(await applyAnnotations(src, [])).toBe(src);
    await expect(applyAnnotations(src, [{ type: 'whiteout', page: 5, rect: [0, 0, 1, 1] }])).rejects.toThrow(/page 6/);
    await expect(
      applyAnnotations(src, [{ type: 'text', page: 0, x: 0, y: 0, text: '한글', size: 10, color: '#000000' }]),
    ).rejects.toThrow(/image fallback/);
  });
});

describe('helpers', () => {
  it('detects WinAnsi-encodable text', () => {
    expect(isWinAnsiEncodable('Hello, café €5')).toBe(true);
    expect(isWinAnsiEncodable('안녕')).toBe(false);
    expect(isWinAnsiEncodable('日本')).toBe(false);
  });
  it('parses hex colors', () => {
    const c = hexToRgb('#ff8000');
    expect([c.red, c.green, Math.round(c.blue)]).toEqual([1, 128 / 255, 0]);
    expect(() => hexToRgb('red')).toThrow();
  });
});
