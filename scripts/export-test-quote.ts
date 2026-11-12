import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { buildWorkbook } from '../src/lib/buildWorkbook';
import { parseNumber } from '../src/lib/numbers';
import { parseSpreadsheet } from '../src/lib/parseSpreadsheet';
import type { ExportRow } from '../src/lib/types';

const window = new Window();
globalThis.DOMParser = window.DOMParser;

const quotePath = process.argv[2];
const outPath = process.argv[3];
const templatePath = process.argv[4] ?? resolve('public/품목내역(통합).xls');
if (!quotePath || !outPath) throw new Error('usage: export-test-quote.ts <quote.xlsx> <out.xls> [template.xls]');

function asBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const parsed = await parseSpreadsheet(asBuffer(readFileSync(quotePath)));
if (parsed.error) throw new Error(parsed.error);
const rows: ExportRow[] = parsed.items.map((item) => ({
  content: item.content,
  spec: item.spec,
  unit: item.unit,
  qty: parseNumber(item.qty),
  unitPrice: parseNumber(item.unitPrice),
}));
const template = readFileSync(templatePath);
const built = buildWorkbook(template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength) as ArrayBuffer, rows);
writeFileSync(outPath, built);
console.log(JSON.stringify({ count: parsed.items.length, notices: parsed.notices, items: parsed.items }, null, 2));
