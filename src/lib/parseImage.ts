import { extractPositioned, type WordBox } from './positionedTable';
import { emptyResult, type ParseResult } from './types';

type OcrWord = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

export async function parseImage(file: Blob, onStatus?: (message: string) => void): Promise<ParseResult> {
  onStatus?.('사진에서 글자를 읽는 중입니다. 처음에는 글자 데이터를 받아 옵니다.');
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('kor+eng', 1, {
      logger: (message) => {
        if (message.status === 'recognizing text') {
          onStatus?.(`사진에서 글자를 읽는 중… ${Math.round(message.progress * 100)}%`);
        }
      },
    });
    const result = await worker.recognize(file);
    await worker.terminate();
    const words: WordBox[] = ((result.data.words ?? []) as OcrWord[])
      .filter((word) => word.text.trim())
      .map((word) => ({
        text: word.text,
        x0: word.bbox.x0,
        x1: word.bbox.x1,
        y0: word.bbox.y0,
        y1: word.bbox.y1,
      }));
    const extracted = words.length > 0 ? extractPositioned(words) : extractPositioned([]);
    const previewText = (extracted.plainText || result.data.text || '').slice(0, 8000);
    const notices = extracted.items.length === 0
      ? ['사진에서 확신할 수 있는 품목이 없습니다. 읽힌 글자를 보고 직접 입력해 주세요.']
      : ['사진에서 읽은 숫자입니다. 내려받기 전에 표를 확인해 주세요.', ...extracted.notices];
    return { items: extracted.items, notices, error: null, previewText };
  } catch {
    return {
      ...emptyResult(null),
      notices: ['사진에서 글자를 읽지 못했습니다. 표를 비워 두었습니다. 품목을 직접 입력해 주세요.'],
    };
  }
}
