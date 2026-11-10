import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildWorkbook } from './buildWorkbook';
import { extractFromGrid } from './extractItems';
import { parseSpreadsheet } from './parseSpreadsheet';
import { readSheets } from './xlsxRead';

const QUOTE = '/cursor/stores/bc-68610600-4d81-451f-8bb0-3b093d5190e7/internal/금구중_10월_기자재견적서.xlsx';
const TEMPLATE = path.resolve('public/template.xlsx');

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
  });
});

describe('buildWorkbook', () => {
  it('keeps the template sheet, headers, and column widths', async () => {
    const template = readFileSync(TEMPLATE);
    const templateBytes = template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength);
    const original = await JSZip.loadAsync(templateBytes);
    const originalSheet = await original.file('xl/worksheets/sheet1.xml')!.async('string');
    const built = await buildWorkbook(templateBytes as ArrayBuffer, [
      {
        content: 'A & B <C>',
        s2b: '00123',
        spec: 'm  y',
        qty: 2,
        unit: '개',
        unitPrice: 60000,
        amount: 120000,
        fee: null,
      },
    ]);
    const zipped = await JSZip.loadAsync(built);
    for (const name of Object.keys(original.files)) {
      if (original.files[name].dir || name === 'xl/worksheets/sheet1.xml') continue;
      const before = await original.file(name)!.async('uint8array');
      const after = await zipped.file(name)!.async('uint8array');
      expect(Buffer.from(before).equals(Buffer.from(after)), name).toBe(true);
    }
    const sheet = await zipped.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet.match(/<cols>[\s\S]*?<\/cols>/)?.[0]).toBe(originalSheet.match(/<cols>[\s\S]*?<\/cols>/)?.[0]);
    expect(sheet.match(/<row r="3">[\s\S]*?<\/row>/)?.[0]).toBe(originalSheet.match(/<row r="3">[\s\S]*?<\/row>/)?.[0]);
    expect(sheet).toContain('<dimension ref="A1:I4"/>');
    expect(sheet).toContain('A &amp; B &lt;C&gt;');
    expect(sheet).toContain('xml:space="preserve">m  y<');
    expect(sheet).toContain('00123');
    expect(sheet).not.toMatch(/<c r="J/);
    expect(sheet).toContain('<mergeCell ref="A1:I1"/>');

    const [grid] = await readSheets(built.buffer.slice(built.byteOffset, built.byteOffset + built.byteLength) as ArrayBuffer);
    const extracted = extractFromGrid(grid);
    expect(extracted.items[0]).toMatchObject({
      content: 'A & B <C>',
      s2b: '00123',
      spec: 'm  y',
      qty: '2',
      unit: '개',
      unitPrice: '60000',
      amount: '120000',
      fee: '',
    });
  });
});
