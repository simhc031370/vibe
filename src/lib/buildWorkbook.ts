import { find, read, write } from 'cfb';
import type { ExportRow } from './types';

export const ITEM_LIST_HEADERS = ['내용', '규격', '단위', '수량', '예상단가'] as const;

export const ITEM_LIST_SHEET = '품목내역';

const SST_LIMIT = 8224;
const DATA_XF = [23, 24, 24, 24, 25] as const;

type Record = { code: number; payload: Uint8Array };

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function setU16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function setU32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function recordBytes(record: Record): Uint8Array {
  const out = new Uint8Array(4 + record.payload.length);
  setU16(out, 0, record.code);
  setU16(out, 2, record.payload.length);
  out.set(record.payload, 4);
  return out;
}

function parseRecords(data: Uint8Array): Record[] {
  const records: Record[] = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const code = u16(data, offset);
    const length = u16(data, offset + 2);
    const end = offset + 4 + length;
    if (end > data.length) throw new Error('품목내역 서식의 레코드가 잘렸습니다.');
    records.push({ code, payload: data.slice(offset + 4, end) });
    offset = end;
  }
  if (offset !== data.length) throw new Error('품목내역 서식의 레코드가 잘렸습니다.');
  return records;
}

function stringEnd(payload: Uint8Array, offset: number): number {
  const count = u16(payload, offset);
  const flags = payload[offset + 2];
  let cursor = offset + 3;
  let runs = 0;
  let extension = 0;
  if (flags & 0x08) {
    runs = u16(payload, cursor);
    cursor += 2;
  }
  if (flags & 0x04) {
    extension = u32(payload, cursor);
    cursor += 4;
  }
  cursor += flags & 0x01 ? count * 2 : count;
  cursor += runs * 4 + extension;
  return cursor;
}

function parseSst(payload: Uint8Array): { total: number; unique: number; strings: Uint8Array[] } {
  if (payload.length < 8) throw new Error('품목내역 서식의 문자열 표가 없습니다.');
  const total = u32(payload, 0);
  const unique = u32(payload, 4);
  const strings: Uint8Array[] = [];
  let offset = 8;
  for (let index = 0; index < unique; index += 1) {
    if (offset + 3 > payload.length) throw new Error('품목내역 서식의 문자열 표가 잘렸습니다.');
    const end = stringEnd(payload, offset);
    if (end > payload.length) throw new Error('품목내역 서식의 문자열 표가 잘렸습니다.');
    strings.push(payload.slice(offset, end));
    offset = end;
  }
  return { total, unique, strings };
}

function decodeString(raw: Uint8Array): string {
  const count = u16(raw, 0);
  const flags = raw[2];
  let offset = 3;
  if (flags & 0x08) offset += 2;
  if (flags & 0x04) offset += 4;
  let text = '';
  if (flags & 0x01) {
    for (let index = 0; index < count; index += 1) text += String.fromCharCode(u16(raw, offset + index * 2));
  } else {
    for (let index = 0; index < count; index += 1) text += String.fromCharCode(raw[offset + index]);
  }
  return text;
}

function encodeString(value: string): Uint8Array {
  let unicode = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 255) {
      unicode = true;
      break;
    }
  }
  const payload = new Uint8Array(3 + (unicode ? value.length * 2 : value.length));
  setU16(payload, 0, value.length);
  payload[2] = unicode ? 1 : 0;
  if (unicode) {
    for (let index = 0; index < value.length; index += 1) setU16(payload, 3 + index * 2, value.charCodeAt(index));
  } else {
    for (let index = 0; index < value.length; index += 1) payload[3 + index] = value.charCodeAt(index);
  }
  if (payload.length > SST_LIMIT) throw new Error('한 칸의 글이 너무 길어 품목내역 서식에 넣지 못했습니다.');
  return payload;
}

function packSst(total: number, unique: number, strings: Uint8Array[]): Record[] {
  const header = new Uint8Array(8);
  setU32(header, 0, total);
  setU32(header, 4, unique);
  const blocks: Uint8Array[][] = [[]];
  const push = (part: Uint8Array) => {
    const current = blocks[blocks.length - 1];
    const used = current.reduce((sum, piece) => sum + piece.length, 0);
    if (used > 0 && used + part.length > SST_LIMIT) blocks.push([part]);
    else current.push(part);
  };
  push(header);
  for (const value of strings) push(value);
  return blocks.map((parts, index) => ({ code: index === 0 ? 0x00fc : 0x003c, payload: concat(parts) }));
}

function blank(row: number, column: number, xf: number): Record {
  const payload = new Uint8Array(6);
  setU16(payload, 0, row);
  setU16(payload, 2, column);
  setU16(payload, 4, xf);
  return { code: 0x0201, payload };
}

function numberCell(row: number, column: number, xf: number, value: number): Record {
  const payload = new Uint8Array(14);
  setU16(payload, 0, row);
  setU16(payload, 2, column);
  setU16(payload, 4, xf);
  new DataView(payload.buffer).setFloat64(6, value, true);
  return { code: 0x0203, payload };
}

function label(row: number, column: number, xf: number, index: number): Record {
  const payload = new Uint8Array(10);
  setU16(payload, 0, row);
  setU16(payload, 2, column);
  setU16(payload, 4, xf);
  setU32(payload, 6, index);
  return { code: 0x00fd, payload };
}

function dataRow(row: number): Record {
  const payload = new Uint8Array(16);
  setU16(payload, 0, row);
  setU16(payload, 4, DATA_XF.length);
  setU16(payload, 6, 255);
  payload[13] = 0x01;
  payload[14] = 0x0f;
  return { code: 0x0208, payload };
}

function sheetBof(records: Record[]): number {
  let seen = 0;
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].code !== 0x0809) continue;
    seen += 1;
    if (seen === 2) return index;
  }
  throw new Error('품목내역 시트를 찾지 못했습니다.');
}

function fillWorkbook(data: Uint8Array, rows: ExportRow[]): Uint8Array {
  let records = parseRecords(data);
  const sstRecord = records.find((record) => record.code === 0x00fc);
  if (!sstRecord) throw new Error('품목내역 서식의 문자열 표가 없습니다.');
  const sst = parseSst(sstRecord.payload);
  const known = new Map<string, number>();
  sst.strings.forEach((raw, index) => known.set(decodeString(raw), index));
  const added: Uint8Array[] = [];
  const cells: Record[] = [];
  let references = 0;
  rows.forEach((row, index) => {
    const rw = index + 1;
    cells.push(dataRow(rw));
    const values: Array<string | number | null> = [row.content, row.spec, row.unit, row.qty, row.unitPrice];
    values.forEach((value, column) => {
      const xf = DATA_XF[column];
      if (typeof value === 'number' && Number.isFinite(value)) {
        cells.push(numberCell(rw, column, xf, value));
        return;
      }
      const text = typeof value === 'string' ? value : '';
      if (text === '') {
        cells.push(blank(rw, column, xf));
        return;
      }
      let stringIndex = known.get(text);
      if (stringIndex == null) {
        stringIndex = sst.strings.length + added.length;
        known.set(text, stringIndex);
        added.push(encodeString(text));
      }
      references += 1;
      cells.push(label(rw, column, xf, stringIndex));
    });
  });
  const packed = packSst(sst.total + references, sst.strings.length + added.length, [...sst.strings, ...added]);
  records = records.flatMap((record) => {
    if (record.code === 0x00fc) return packed;
    if (record.code === 0x00ff) return [];
    return [record];
  });
  const bof = sheetBof(records);
  records = records.filter((record, index) => !(index > bof && (record.code === 0x020b || record.code === 0x00d7)));
  const dimensions = records.find((record, index) => index > sheetBof(records) && record.code === 0x0200);
  if (!dimensions) throw new Error('품목내역 서식의 범위를 찾지 못했습니다.');
  setU32(dimensions.payload, 4, 1 + rows.length);
  const insertAt = records.findIndex(
    (record, index) => index > sheetBof(records) && (record.code === 0x00ec || record.code === 0x00eb || record.code === 0x000a),
  );
  if (insertAt < 0) throw new Error('품목내역 서식에 품목을 넣을 위치를 찾지 못했습니다.');
  records.splice(insertAt, 0, ...cells);
  let sheetOffset = 0;
  const bofIndex = sheetBof(records);
  for (let index = 0; index < bofIndex; index += 1) sheetOffset += 4 + records[index].payload.length;
  const boundsheet = records.find((record) => record.code === 0x0085);
  if (!boundsheet) throw new Error('품목내역 시트 정보를 찾지 못했습니다.');
  setU32(boundsheet.payload, 0, sheetOffset);
  return concat(records.map(recordBytes));
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('품목내역 파일을 만들지 못했습니다.');
}

export function buildWorkbook(template: ArrayBuffer, rows: ExportRow[]): Uint8Array {
  if (rows.length === 0) return new Uint8Array(template.slice(0));
  const container = read(new Uint8Array(template), { type: 'array' });
  const entry = find(container, '/Workbook');
  if (!entry) throw new Error('품목내역 서식에서 Workbook을 찾지 못했습니다.');
  const source = asBytes(entry.content);
  const filled = fillWorkbook(source, rows);
  entry.content = filled;
  entry.size = filled.length;
  return asBytes(write(container));
}
