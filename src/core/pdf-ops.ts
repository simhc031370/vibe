import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  StandardFonts,
  degrees,
  rgb,
  type PDFPage,
  type PDFFont,
  type RGB,
} from 'pdf-lib';

export type Bytes = Uint8Array;

/** A page in an organize plan: either a copy of a source page (0-based) or a blank page. */
export type PagePlanItem =
  | { kind: 'page'; source: number; rotate?: number }
  | { kind: 'blank'; width?: number; height?: number };

export interface DocMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
  creator?: string;
  producer?: string;
}

/** Rect in PDF user space: [x1, y1, x2, y2] (any corner order). */
export type Rect = [number, number, number, number];

export type Annotation =
  | { type: 'highlight'; page: number; rect: Rect; color: string; opacity?: number }
  | { type: 'rect'; page: number; rect: Rect; color: string; width?: number }
  | { type: 'whiteout'; page: number; rect: Rect }
  | { type: 'ink'; page: number; points: [number, number][]; color: string; width?: number }
  | { type: 'text'; page: number; x: number; y: number; text: string; size: number; color: string }
  | { type: 'stamp'; page: number; x: number; y: number; text: string; size: number; color: string }
  | { type: 'note'; page: number; x: number; y: number; text: string; color: string }
  | { type: 'image'; page: number; rect: Rect; png: Bytes };

export const A4: [number, number] = [595.28, 841.89];

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid color: ${hex}`);
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** True if the text can be drawn with a standard 14 font (WinAnsi encoding). */
export function isWinAnsiEncodable(text: string): boolean {
  // Latin-1 range plus the CP1252 extras that pdf-lib's WinAnsi encoder knows.
  const extras = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\r' || ch === '\t') continue;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) continue;
    if (extras.includes(ch)) continue;
    return false;
  }
  return true;
}

/**
 * Parse a 1-based page range expression like "1-3, 5, 8-" into 0-based indices.
 * Order and duplicates are preserved as written so it can also express reordering.
 */
export function parsePageRange(expr: string, pageCount: number): number[] {
  const out: number[] = [];
  const parts = expr.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Empty page range');
  for (const part of parts) {
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    let start: number;
    let end: number;
    if (m) {
      start = m[1] ? parseInt(m[1], 10) : 1;
      end = m[2] ? parseInt(m[2], 10) : pageCount;
    } else if (/^\d+$/.test(part)) {
      start = end = parseInt(part, 10);
    } else {
      throw new Error(`Invalid page range segment: "${part}"`);
    }
    if (start < 1 || end < 1 || start > pageCount || end > pageCount) {
      throw new Error(`Page range "${part}" is outside 1-${pageCount}`);
    }
    const step = start <= end ? 1 : -1;
    for (let p = start; step > 0 ? p <= end : p >= end; p += step) out.push(p - 1);
  }
  return out;
}

export async function load(bytes: Bytes): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

export async function getPageCount(bytes: Bytes): Promise<number> {
  return (await load(bytes)).getPageCount();
}

function normRotation(deg: number): number {
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

/** Combine several PDFs, in order, into one document. */
export async function merge(files: Bytes[]): Promise<Bytes> {
  if (files.length === 0) throw new Error('Nothing to merge');
  const out = await PDFDocument.create();
  for (const f of files) {
    const src = await load(f);
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return out.save();
}

/** Build a new document from a page plan (reorder / rotate / delete / insert blank). */
export async function organize(bytes: Bytes, plan: PagePlanItem[]): Promise<Bytes> {
  if (plan.length === 0) throw new Error('A document needs at least one page');
  const src = await load(bytes);
  const out = await PDFDocument.create();
  copyMetadata(src, out);
  const sources = plan.flatMap((p) => (p.kind === 'page' ? [p.source] : []));
  const copied = await out.copyPages(src, sources);
  let ci = 0;
  let lastSize: [number, number] = A4;
  for (const item of plan) {
    if (item.kind === 'page') {
      const page = copied[ci++];
      const base = page.getRotation().angle;
      page.setRotation(degrees(normRotation(base + (item.rotate ?? 0))));
      out.addPage(page);
      const { width, height } = page.getSize();
      lastSize = [width, height];
    } else {
      out.addPage([item.width ?? lastSize[0], item.height ?? lastSize[1]]);
    }
  }
  return out.save();
}

export async function extractPages(bytes: Bytes, indices: number[]): Promise<Bytes> {
  return organize(bytes, indices.map((source) => ({ kind: 'page', source })));
}

export async function deletePages(bytes: Bytes, indices: number[]): Promise<Bytes> {
  const n = await getPageCount(bytes);
  const drop = new Set(indices);
  const keep = [...Array(n).keys()].filter((i) => !drop.has(i));
  return extractPages(bytes, keep);
}

export async function rotatePages(bytes: Bytes, indices: number[], delta: number): Promise<Bytes> {
  const n = await getPageCount(bytes);
  const sel = new Set(indices);
  return organize(
    bytes,
    [...Array(n).keys()].map((source) => ({ kind: 'page', source, rotate: sel.has(source) ? delta : 0 })),
  );
}

/** Split into chunks of `every` pages. */
export async function splitEvery(bytes: Bytes, every: number): Promise<Bytes[]> {
  if (!Number.isInteger(every) || every < 1) throw new Error('Split size must be a positive integer');
  const n = await getPageCount(bytes);
  const out: Bytes[] = [];
  for (let s = 0; s < n; s += every) {
    out.push(await extractPages(bytes, [...Array(Math.min(every, n - s)).keys()].map((i) => s + i)));
  }
  return out;
}

export interface WatermarkOptions {
  text?: string;
  /** PNG image used instead of text (e.g. pre-rendered non-Latin text). */
  png?: Bytes;
  color?: string;
  opacity?: number;
  size?: number;
  angle?: number;
}

export async function addWatermark(bytes: Bytes, opts: WatermarkOptions): Promise<Bytes> {
  const doc = await load(bytes);
  const opacity = opts.opacity ?? 0.2;
  const angle = opts.angle ?? 45;
  if (opts.png) {
    const img = await doc.embedPng(opts.png);
    for (const page of doc.getPages()) {
      const { width, height } = page.getSize();
      const scale = Math.min((width * 0.7) / img.width, (height * 0.7) / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h, opacity });
    }
    return doc.save();
  }
  const text = opts.text?.trim();
  if (!text) throw new Error('Watermark text is empty');
  if (!isWinAnsiEncodable(text)) throw new Error('Watermark text needs a PNG fallback for non-Latin characters');
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const color = hexToRgb(opts.color ?? '#ff0000');
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const size = opts.size ?? Math.min(width, height) / Math.max(4, text.length * 0.6);
    const tw = font.widthOfTextAtSize(text, size);
    const rad = (angle * Math.PI) / 180;
    // Center the rotated text box on the page.
    const x = width / 2 - (Math.cos(rad) * tw) / 2 + (Math.sin(rad) * size) / 3;
    const y = height / 2 - (Math.sin(rad) * tw) / 2 - (Math.cos(rad) * size) / 3;
    page.drawText(text, { x, y, size, font, color, opacity, rotate: degrees(angle) });
  }
  return doc.save();
}

export interface PageNumberOptions {
  /** Template; {n} = page number, {total} = page count. */
  format?: string;
  position?: 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left';
  size?: number;
  startAt?: number;
  margin?: number;
}

export async function addPageNumbers(bytes: Bytes, opts: PageNumberOptions = {}): Promise<Bytes> {
  const doc = await load(bytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const format = opts.format ?? '{n} / {total}';
  const size = opts.size ?? 10;
  const margin = opts.margin ?? 24;
  const pos = opts.position ?? 'bottom-center';
  const pages = doc.getPages();
  const total = pages.length;
  pages.forEach((page, i) => {
    const label = format.replace(/\{n\}/g, String((opts.startAt ?? 1) + i)).replace(/\{total\}/g, String(total));
    const { width, height } = page.getSize();
    const tw = font.widthOfTextAtSize(label, size);
    const x = pos.endsWith('left') ? margin : pos.endsWith('right') ? width - margin - tw : (width - tw) / 2;
    const y = pos.startsWith('top') ? height - margin - size : margin;
    page.drawText(label, { x, y, size, font, color: rgb(0.2, 0.2, 0.2) });
  });
  return doc.save();
}

export interface ImageInput {
  bytes: Bytes;
  type: 'png' | 'jpg';
}

/** Create a PDF with one image per page. `fit: 'a4'` centers images on A4 pages. */
export async function imagesToPdf(images: ImageInput[], fit: 'image' | 'a4' = 'image'): Promise<Bytes> {
  if (images.length === 0) throw new Error('No images selected');
  const doc = await PDFDocument.create();
  for (const im of images) {
    const img = im.type === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    if (fit === 'image') {
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } else {
      const landscape = img.width > img.height;
      const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
      const m = 36;
      const s = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height, 1);
      const w = img.width * s;
      const h = img.height * s;
      doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
  }
  return doc.save();
}

export async function getMetadata(bytes: Bytes): Promise<DocMetadata> {
  const doc = await load(bytes);
  return {
    title: doc.getTitle(),
    author: doc.getAuthor(),
    subject: doc.getSubject(),
    keywords: doc.getKeywords()?.split(/[,;]\s*|\s+/).filter(Boolean),
    creator: doc.getCreator(),
    producer: doc.getProducer(),
  };
}

export async function setMetadata(bytes: Bytes, meta: DocMetadata): Promise<Bytes> {
  const doc = await load(bytes);
  if (meta.title !== undefined) doc.setTitle(meta.title);
  if (meta.author !== undefined) doc.setAuthor(meta.author);
  if (meta.subject !== undefined) doc.setSubject(meta.subject);
  if (meta.keywords !== undefined) doc.setKeywords(meta.keywords);
  if (meta.creator !== undefined) doc.setCreator(meta.creator);
  doc.setProducer(meta.producer ?? 'vPDF');
  doc.setModificationDate(new Date());
  return doc.save();
}

function copyMetadata(src: PDFDocument, out: PDFDocument) {
  const t = src.getTitle();
  const a = src.getAuthor();
  const s = src.getSubject();
  const k = src.getKeywords();
  if (t) out.setTitle(t);
  if (a) out.setAuthor(a);
  if (s) out.setSubject(s);
  if (k) out.setKeywords([k]);
}

/** Re-save with object streams; removes unused objects and usually shrinks the file. */
export async function optimize(bytes: Bytes): Promise<Bytes> {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  copyMetadata(src, out);
  const pages = await out.copyPages(src, src.getPageIndices());
  pages.forEach((p) => out.addPage(p));
  return out.save({ useObjectStreams: true });
}

function rectBox(r: Rect) {
  const x = Math.min(r[0], r[2]);
  const y = Math.min(r[1], r[3]);
  return { x, y, width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) };
}

function addTextNote(doc: PDFDocument, page: PDFPage, a: Extract<Annotation, { type: 'note' }>) {
  const c = hexToRgb(a.color);
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [a.x, a.y - 20, a.x + 20, a.y],
    Contents: PDFHexString.fromText(a.text),
    T: PDFString.of('vPDF'),
    Name: 'Comment',
    C: [c.red, c.green, c.blue],
    F: 4,
    M: PDFString.fromDate(new Date()),
  });
  const ref = doc.context.register(annot);
  const existing = page.node.Annots();
  if (existing) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

/**
 * Burn annotations into the page content (like "flatten"), except sticky notes,
 * which are written as real /Text annotations so other readers show them as comments.
 * Coordinates are in each page's PDF user space.
 */
export async function applyAnnotations(bytes: Bytes, annotations: Annotation[]): Promise<Bytes> {
  if (annotations.length === 0) return bytes;
  const doc = await load(bytes);
  const pages = doc.getPages();
  let helv: PDFFont | undefined;
  let helvBold: PDFFont | undefined;
  const font = async (bold: boolean) =>
    bold
      ? (helvBold ??= await doc.embedFont(StandardFonts.HelveticaBold))
      : (helv ??= await doc.embedFont(StandardFonts.Helvetica));

  for (const a of annotations) {
    const page = pages[a.page];
    if (!page) throw new Error(`Annotation refers to missing page ${a.page + 1}`);
    switch (a.type) {
      case 'highlight':
        page.drawRectangle({ ...rectBox(a.rect), color: hexToRgb(a.color), opacity: a.opacity ?? 0.35 });
        break;
      case 'rect':
        page.drawRectangle({ ...rectBox(a.rect), borderColor: hexToRgb(a.color), borderWidth: a.width ?? 2 });
        break;
      case 'whiteout':
        page.drawRectangle({ ...rectBox(a.rect), color: rgb(1, 1, 1) });
        break;
      case 'ink': {
        const pts = a.points;
        const color = hexToRgb(a.color);
        const thickness = a.width ?? 2;
        if (pts.length === 1) {
          page.drawCircle({ x: pts[0][0], y: pts[0][1], size: thickness / 2, color });
        }
        for (let i = 1; i < pts.length; i++) {
          page.drawLine({
            start: { x: pts[i - 1][0], y: pts[i - 1][1] },
            end: { x: pts[i][0], y: pts[i][1] },
            thickness,
            color,
            lineCap: 1,
          });
        }
        break;
      }
      case 'text': {
        if (!isWinAnsiEncodable(a.text)) throw new Error('Text needs an image fallback for non-Latin characters');
        const f = await font(false);
        a.text.split('\n').forEach((line, i) => {
          page.drawText(line, { x: a.x, y: a.y - i * a.size * 1.2, size: a.size, font: f, color: hexToRgb(a.color) });
        });
        break;
      }
      case 'stamp': {
        if (!isWinAnsiEncodable(a.text)) throw new Error('Stamp needs an image fallback for non-Latin characters');
        const f = await font(true);
        const color = hexToRgb(a.color);
        const tw = f.widthOfTextAtSize(a.text, a.size);
        const pad = a.size * 0.4;
        page.drawRectangle({
          x: a.x - pad,
          y: a.y - pad,
          width: tw + 2 * pad,
          height: a.size + pad,
          borderColor: color,
          borderWidth: Math.max(1.5, a.size / 10),
          opacity: 0,
          borderOpacity: 0.9,
        });
        page.drawText(a.text, { x: a.x, y: a.y, size: a.size, font: f, color, opacity: 0.9 });
        break;
      }
      case 'note':
        addTextNote(doc, page, a);
        break;
      case 'image': {
        const img = await doc.embedPng(a.png);
        page.drawImage(img, rectBox(a.rect));
        break;
      }
    }
  }
  return doc.save();
}
