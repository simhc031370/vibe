import { extractPositioned, type WordBox } from './positionedTable';
import { emptyResult, type ParseResult } from './types';

type TextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

function wordsFromPage(items: unknown[]): WordBox[] {
  const words: WordBox[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item)) continue;
    const text = item as TextItem;
    if (!text.str.trim()) continue;
    const baseline = text.transform[5] ?? 0;
    const height = text.height || Math.abs(text.transform[3] ?? 0) || 10;
    const x = text.transform[4] ?? 0;
    const y0 = -(baseline + height);
    words.push({
      text: text.str,
      x0: x,
      x1: x + (text.width || text.str.length * 6),
      y0,
      y1: y0 + height,
    });
  }
  return words;
}

async function recognizeCanvas(canvas: HTMLCanvasElement, onStatus?: (message: string) => void): Promise<ParseResult> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((value) => resolve(value), 'image/png'));
  if (!blob) return emptyResult(null);
  const { parseImage } = await import('./parseImage');
  return parseImage(new File([blob], 'page.png', { type: 'image/png' }), onStatus);
}

export async function parsePdf(data: ArrayBuffer, onStatus?: (message: string) => void): Promise<ParseResult> {
  onStatus?.('PDF에서 글자를 읽는 중입니다.');
  try {
    const pdfjs = await import('pdfjs-dist');
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const pdf = await pdfjs.getDocument({ data: data.slice(0) }).promise;
    const pageCount = Math.min(pdf.numPages, 5);
    const chunks: ParseResult[] = [];
    let textLength = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const words = wordsFromPage(content.items);
      textLength += words.reduce((sum, word) => sum + word.text.trim().length, 0);
      const extracted = extractPositioned(words);
      chunks.push({
        items: extracted.items,
        notices: extracted.notices,
        error: null,
        previewText: extracted.plainText,
      });
    }

    if (textLength < 15) {
      onStatus?.('PDF에 글자 레이어가 없어 화면을 읽고 있습니다.');
      const ocrPages: ParseResult[] = [];
      const ocrCount = Math.min(pdf.numPages, 3);
      for (let pageNumber = 1; pageNumber <= ocrCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) continue;
        await page.render({ canvasContext: context, viewport }).promise;
        ocrPages.push(await recognizeCanvas(canvas, onStatus));
      }
      await pdf.destroy();
      return mergeResults(ocrPages, 'PDF에서 품목을 읽지 못했습니다. 직접 입력해 주세요.');
    }

    await pdf.destroy();
    return mergeResults(chunks, 'PDF에서 품목을 읽지 못했습니다. 직접 입력해 주세요.');
  } catch {
    return {
      ...emptyResult(null),
      notices: ['PDF를 읽지 못했습니다. 표를 비워 두었습니다. 품목을 직접 입력해 주세요.'],
    };
  }
}

function mergeResults(parts: ParseResult[], emptyNotice: string): ParseResult {
  const items = parts.flatMap((part) => part.items);
  const notices = [...new Set(parts.flatMap((part) => part.notices))];
  const previewText = parts
    .map((part) => part.previewText)
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 8000);
  if (items.length === 0 && notices.length === 0) notices.push(emptyNotice);
  const error = parts.find((part) => part.error)?.error ?? null;
  return { items, notices, error, previewText };
}
