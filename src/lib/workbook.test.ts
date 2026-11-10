import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { buildWorkbook } from './buildWorkbook';
import { extractFromGrid } from './extractItems';
import { parseNumber } from './numbers';
import { parseSpreadsheet } from './parseSpreadsheet';
import { readSheets } from './xlsxRead';

const QUOTE = '/cursor/stores/bc-68610600-4d81-451f-8bb0-3b093d5190e7/internal/금구중_10월_기자재견적서.xlsx';

async function workbook(sheetXml: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="견적서" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
  );
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('extract spreadsheet line items', () => {
  it('reads formula amounts and skips blank and total rows', async () => {
    const data = await workbook(`<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="B1" t="inlineStr"><is><t>품목</t></is></c>
      <c r="C1" t="inlineStr"><is><t>품명</t></is></c>
      <c r="D1" t="inlineStr"><is><t>규격</t></is></c>
      <c r="E1" t="inlineStr"><is><t>수량</t></is></c>
      <c r="F1" t="inlineStr"><is><t>단가</t></is></c>
      <c r="G1" t="inlineStr"><is><t>공급금액</t></is></c>
      <c r="H1" t="inlineStr"><is><t>납품실</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="n"><v>1</v></c>
      <c r="B2" t="inlineStr"><is><t>케이블</t></is></c>
      <c r="C2" t="inlineStr"><is><t>HDMI &amp; 10m</t></is></c>
      <c r="D2" t="inlineStr"><is><t>m  y</t></is></c>
      <c r="E2" t="n"><v>2</v></c>
      <c r="F2" t="n"><v>40000</v></c>
      <c r="G2"><f>E2*F2</f><v/></c>
      <c r="H2" t="inlineStr"><is><t>진로활동실</t></is></c>
    </row>
    <row r="3"><c r="A3" t="n"><v>2</v></c></row>
    <row r="4">
      <c r="A4" t="inlineStr"><is><t>합        계</t></is></c>
      <c r="G4"><f>SUM(G2:G3)</f><v/></c>
    </row>
  </sheetData>
</worksheet>`);

    const [sheet] = await readSheets(data);
    const extracted = extractFromGrid(sheet);
    expect(extracted.items).toHaveLength(1);
    expect(extracted.items[0]).toMatchObject({
      content: '케이블 / HDMI & 10m',
      spec: 'm  y',
      qty: '2',
      unitPrice: '40000',
      amount: '80000',
      note: '납품실 진로활동실',
    });
    expect(extracted.notices.some((notice) => notice.includes('계산식'))).toBe(true);
    expect(extracted.notices.some((notice) => notice.includes('빈') || notice.includes('함께 있지 않은'))).toBe(true);
    expect(extracted.notices.some((notice) => notice.includes('합계'))).toBe(true);
  });

  it('reads the Geumgu quote when the fixture is available', async () => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(QUOTE);
    } catch {
      return;
    }
    const parsed = await parseSpreadsheet(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(parsed.error).toBeNull();
    expect(parsed.items.map((item) => ({
      content: item.content,
      spec: item.spec,
      qty: item.qty,
      unit: item.unit,
      unitPrice: item.unitPrice,
      amount: item.amount,
      s2b: item.s2b,
      fee: item.fee,
      note: item.note,
    }))).toEqual([
      {
        content: '컬러토너 / 브라더 HL 8260(재생)',
        spec: 'bk',
        qty: '1',
        unit: '',
        unitPrice: '60000',
        amount: '60000',
        s2b: '',
        fee: '',
        note: '납품실 Wee클래스 · 날짜 10-26',
      },
      {
        content: '토너 / 삼성 SL M3840(재생)',
        spec: '',
        qty: '1',
        unit: '',
        unitPrice: '88000',
        amount: '88000',
        s2b: '',
        fee: '',
        note: '납품실 행정실 · 날짜 10-26',
      },
      {
        content: '컬러토너 / 브라더 HL 8260(재생)',
        spec: 'm  y',
        qty: '2',
        unit: '',
        unitPrice: '60000',
        amount: '120000',
        s2b: '',
        fee: '',
        note: '납품실 Wee클래스 · 날짜 10-26',
      },
      {
        content: '인터넷허브 / IPTIME H908',
        spec: '',
        qty: '1',
        unit: '',
        unitPrice: '55000',
        amount: '55000',
        s2b: '',
        fee: '',
        note: '납품실 Wee클래스 · 날짜 10-26',
      },
      {
        content: '케이블 / HDMI(2.0) 10m',
        spec: '',
        qty: '1',
        unit: '',
        unitPrice: '40000',
        amount: '40000',
        s2b: '',
        fee: '',
        note: '납품실 진로활동실 · 날짜 10-28',
      },
    ]);
    const built = buildWorkbook(parsed.items.map((item) => ({
      content: item.content,
      spec: item.spec,
      unit: item.unit,
      qty: parseNumber(item.qty),
      unitPrice: parseNumber(item.unitPrice),
    })));
    const sheet = XLSX.read(built, { type: 'array' }).Sheets['품목내역'];
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, raw: true, defval: '' });
    expect(rows).toEqual([
      ['내용', '규격', '단위', '수량', '예상단가'],
      ['컬러토너 / 브라더 HL 8260(재생)', 'bk', '', 1, 60000],
      ['토너 / 삼성 SL M3840(재생)', '', '', 1, 88000],
      ['컬러토너 / 브라더 HL 8260(재생)', 'm  y', '', 2, 60000],
      ['인터넷허브 / IPTIME H908', '', '', 1, 55000],
      ['케이블 / HDMI(2.0) 10m', '', '', 1, 40000],
    ]);
  });
});

describe('buildWorkbook', () => {
  it('writes 품목내역(통합).xls with only the five template columns', () => {
    const built = buildWorkbook([
      { content: 'A & B <C>', spec: 'm  y', unit: '개', qty: 2, unitPrice: 60000 },
    ]);
    expect([...built.slice(0, 4)]).toEqual([0xd0, 0xcf, 0x11, 0xe0]);
    const workbook = XLSX.read(built, { type: 'array' });
    expect(workbook.SheetNames).toEqual(['품목내역']);
    const rows = XLSX.utils.sheet_to_json<(string | number)[]>(workbook.Sheets['품목내역'], {
      header: 1,
      raw: true,
      defval: '',
    });
    expect(rows).toEqual([
      ['내용', '규격', '단위', '수량', '예상단가'],
      ['A & B <C>', 'm  y', '개', 2, 60000],
    ]);
    expect(rows[0]).toHaveLength(5);
    expect(rows[1]).toHaveLength(5);
  });
});
