import JSZip from 'jszip';
import type { ExportRow } from './types';

// Styles already stored in the template workbook (cellXfs 6–10).
const STYLE = {
  seq: 6,
  content: 7,
  text: 10,
  center: 8,
  money: 9,
} as const;

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlNumber(n: number): string {
  if (Object.is(n, -0)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

function numberCell(ref: string, style: number, value: number | null): string {
  if (value == null) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="n"><v>${xmlNumber(value)}</v></c>`;
}

function textCell(ref: string, style: number, value: string): string {
  if (!value) return `<c r="${ref}" s="${style}"/>`;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function renderRow(rowNumber: number, seq: number, row: ExportRow): string {
  const cells = [
    numberCell(`A${rowNumber}`, STYLE.seq, seq),
    textCell(`B${rowNumber}`, STYLE.content, row.content),
    textCell(`C${rowNumber}`, STYLE.text, row.s2b),
    textCell(`D${rowNumber}`, STYLE.text, row.spec),
    numberCell(`E${rowNumber}`, STYLE.center, row.qty),
    textCell(`F${rowNumber}`, STYLE.center, row.unit),
    numberCell(`G${rowNumber}`, STYLE.money, row.unitPrice),
    numberCell(`H${rowNumber}`, STYLE.money, row.amount),
    numberCell(`I${rowNumber}`, STYLE.money, row.fee),
  ];
  return `<row r="${rowNumber}">${cells.join('')}</row>`;
}

export async function buildWorkbook(template: ArrayBuffer, rows: ExportRow[]): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(template);
  const sheet = zip.file('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('품목내역 서식 시트를 찾지 못했습니다.');
  let xml = await sheet.async('string');
  const lastRow = Math.max(3, 3 + rows.length);
  if (!/<dimension ref="[^"]+"\s*\/>/.test(xml) || !xml.includes('</sheetData>')) {
    throw new Error('품목내역 서식을 읽지 못했습니다.');
  }
  xml = xml.replace(/<dimension ref="[^"]+"\s*\/>/, `<dimension ref="A1:I${lastRow}"/>`);
  const body = rows.map((row, index) => renderRow(4 + index, index + 1, row)).join('');
  xml = xml.replace('</sheetData>', `${body}</sheetData>`);
  zip.file('xl/worksheets/sheet1.xml', xml);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
