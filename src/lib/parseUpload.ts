import { emptyResult, type ParseResult } from './types';

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i;

export async function parseUpload(file: File, onStatus?: (message: string) => void): Promise<ParseResult> {
  if (file.size > 40 * 1024 * 1024) {
    return emptyResult('파일이 너무 큽니다. 40MB 이하로 올려 주세요.');
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.xls') && !name.endsWith('.xlsx')) {
    return emptyResult('구형 xls 파일은 읽지 못합니다. xlsx로 저장한 뒤 다시 올려 주세요.');
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    const { parseSpreadsheet } = await import('./parseSpreadsheet');
    return parseSpreadsheet(await file.arrayBuffer());
  }
  if (name.endsWith('.pdf')) {
    const { parsePdf } = await import('./parsePdf');
    return parsePdf(await file.arrayBuffer(), onStatus);
  }
  if (IMAGE.test(name) || file.type.startsWith('image/')) {
    const { parseImage } = await import('./parseImage');
    return parseImage(file, onStatus);
  }
  return emptyResult('xlsx, PDF, JPG, PNG 파일을 올려 주세요.');
}
