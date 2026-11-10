import * as XLSX from 'xlsx';
import type { ExportRow } from './types';

export const ITEM_LIST_HEADERS = ['내용', '규격', '단위', '수량', '예상단가'] as const;

export const ITEM_LIST_SHEET = '품목내역';

function cell(value: string | number | null): string | number | null {
  if (value == null || value === '') return null;
  return value;
}

export function buildWorkbook(rows: ExportRow[]): Uint8Array {
  const grid: (string | number | null)[][] = [
    [...ITEM_LIST_HEADERS],
    ...rows.map((row) => [
      cell(row.content),
      cell(row.spec),
      cell(row.unit),
      cell(row.qty),
      cell(row.unitPrice),
    ]),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(grid);
  sheet['!cols'] = ITEM_LIST_HEADERS.map(() => ({ wch: 14.06 }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, ITEM_LIST_SHEET);
  const bytes = XLSX.write(workbook, { bookType: 'xls', type: 'array' }) as ArrayBuffer;
  return new Uint8Array(bytes);
}
