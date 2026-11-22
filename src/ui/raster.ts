import type { Rect } from '../core/pdf-ops';

const PX_PER_PT = 4;
const FONT_STACK = '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", "Helvetica Neue", Arial, sans-serif';

export async function canvasToBytes(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas export failed'))), type, quality),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function measure(lines: string[], font: string): number {
  const ctx = document.createElement('canvas').getContext('2d')!;
  ctx.font = font;
  return Math.max(1, ...lines.map((l) => ctx.measureText(l).width));
}

/**
 * Render (multi-line) text as a PNG positioned like a PDF text run whose first
 * baseline starts at (x, y) in PDF space. Returns the PNG and its PDF rect.
 */
export async function rasterizeText(
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
  stamp = false,
): Promise<{ png: Uint8Array; rect: Rect }> {
  const lines = stamp ? [text] : text.split('\n');
  const k = PX_PER_PT;
  const font = `${stamp ? 'bold ' : ''}${size * k}px ${FONT_STACK}`;
  const textW = measure(lines, font) / k;
  const pad = stamp ? size * 0.4 : 0;
  const ascent = size * 0.95;
  const heightPt = ((lines.length - 1) * 1.2 + 1.25) * size + 2 * pad;
  const widthPt = textW + 2 * pad;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(widthPt * k);
  canvas.height = Math.ceil(heightPt * k);
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => ctx.fillText(line, pad * k, (pad + ascent + i * 1.2 * size) * k));
  if (stamp) {
    ctx.lineWidth = Math.max(1.5, size / 10) * k;
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, canvas.width - ctx.lineWidth, canvas.height - ctx.lineWidth);
  }
  const top = y + ascent + pad;
  return { png: await canvasToBytes(canvas), rect: [x - pad, top - heightPt, x - pad + widthPt, top] };
}

/** Diagonal watermark text as a transparent PNG. */
export async function rasterizeWatermark(text: string, color: string, angle = 45): Promise<Uint8Array> {
  const size = 160;
  const font = `bold ${size}px ${FONT_STACK}`;
  const w = measure([text], font);
  const rad = (angle * Math.PI) / 180;
  const cw = Math.ceil(Math.abs(w * Math.cos(rad)) + Math.abs(size * Math.sin(rad))) + 20;
  const ch = Math.ceil(Math.abs(w * Math.sin(rad)) + Math.abs(size * Math.cos(rad))) + 20;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(-rad);
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  return canvasToBytes(canvas);
}

/** Decode any browser-supported image into PNG bytes plus its size. */
export async function imageFileToPng(file: Blob): Promise<{ png: Uint8Array; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0);
  return { png: await canvasToBytes(canvas), width: bmp.width, height: bmp.height };
}
