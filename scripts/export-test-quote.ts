import { readFileSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { buildWorkbook } from '../src/lib/buildWorkbook';
import { parseNumber } from '../src/lib/numbers';
import { parseSpreadsheet } from '../src/lib/parseSpreadsheet';
import type { ExportRow } from '../src/lib/types';

const window = new Window();
globalThis.DOMParser = window.DOMParser;

const quotePath = process.argv[2];
const outPath = process.argv[3];
if (!quotePath || !outPath) throw new Error('usage: export-test-quote.ts <quote.xlsx> <out.xlsx>');

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
const built = buildWorkbook(rows);
writeFileSync(outPath, built);
console.log(JSON.stringify({ count: parsed.items.length, notices: parsed.notices, items: parsed.items }, null, 2));
