import { extractFromGrid } from './extractItems';
import { emptyResult, type ParseResult } from './types';
import { readSheets } from './xlsxRead';

export async function parseSpreadsheet(data: ArrayBuffer): Promise<ParseResult> {
  try {
    const sheets = await readSheets(data);
    let best: ReturnType<typeof extractFromGrid> | null = null;
    for (const sheet of sheets) {
      const extraction = extractFromGrid(sheet);
      if (!best || extraction.items.length > best.items.length) best = extraction;
    }
    if (!best) return emptyResult('엑셀에서 시트를 찾지 못했습니다.');
    return { items: best.items, notices: best.notices, error: null, previewText: '' };
  } catch (error) {
    const message =
      error instanceof Error && /[\uac00-\ud7a3]/.test(error.message)
        ? error.message
        : '엑셀 파일을 열지 못했습니다. xlsx 파일인지 확인해 주세요.';
    return emptyResult(message);
  }
}
