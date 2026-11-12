import JSZip from 'jszip';
import { evaluateFormula } from './formulas';
import { cleanNumber } from './numbers';

export type RawCell = {
  text: string;
  number: number | null;
  formula: string | null;
  computed: boolean;
};

export type SheetGrid = {
  name: string;
  rows: RawCell[][];
};

function childrenNamed(parent: ParentNode, name: string): Element[] {
  const kids = 'children' in parent ? parent.children : [];
  return Array.from(kids).filter((el) => el.localName === name);
}

function attr(el: Element, local: string): string {
  const direct = el.getAttribute(local);
  if (direct) return direct;
  for (const attribute of Array.from(el.attributes)) {
    if (attribute.localName === local) return attribute.value;
  }
  return '';
}

function inlineText(node: Element | null): string {
  if (!node) return '';
  let text = '';
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.localName === 'rPh' || child.localName === 'phoneticPr') continue;
      if (child.localName === 't') text += child.textContent ?? '';
      else walk(child);
    }
  };
  walk(node);
  return text;
}

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('엑셀 시트를 읽지 못했습니다.');
  }
  return doc;
}

function findDescendant(root: ParentNode, name: string): Element | null {
  const walk = (parent: ParentNode): Element | null => {
    const kids = 'children' in parent ? parent.children : [];
    for (const el of Array.from(kids)) {
      if (el.localName === name) return el;
      const found = walk(el);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const doc = parseXml(xml);
  const sst = findDescendant(doc, 'sst');
  if (!sst) return [];
  return childrenNamed(sst, 'si').map((si) => inlineText(si));
}

function cellFromElement(el: Element, shared: string[]): RawCell {
  const type = attr(el, 't');
  const formula = childrenNamed(el, 'f')[0]?.textContent?.trim() || null;
  const rawValue = childrenNamed(el, 'v')[0]?.textContent ?? '';

  if (type === 'inlineStr') {
    return { text: inlineText(childrenNamed(el, 'is')[0] ?? null), number: null, formula, computed: false };
  }
  if (type === 's') {
    const text = shared[Number(rawValue)] ?? '';
    return { text, number: null, formula, computed: false };
  }
  if (type === 'str') {
    return { text: rawValue, number: null, formula, computed: false };
  }
  if (type === 'b') {
    return { text: rawValue === '1' ? 'TRUE' : 'FALSE', number: null, formula, computed: false };
  }
  if (rawValue.trim() !== '' && /^-?\d+(\.\d+)?$/.test(rawValue.trim())) {
    return { text: rawValue.trim(), number: Number(rawValue), formula, computed: false };
  }
  return { text: rawValue, number: null, formula, computed: false };
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function columnName(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetGrid(name: string, xml: string, shared: string[]): SheetGrid {
  const doc = parseXml(xml);
  const sheetData = findDescendant(doc, 'sheetData');
  const rows: RawCell[][] = [];
  if (!sheetData) return { name, rows };

  for (const rowEl of childrenNamed(sheetData, 'row')) {
    const rowNumber = Number(attr(rowEl, 'r')) || rows.length;
    const row: RawCell[] = [];
    let fallbackCol = 1;
    for (const cellEl of childrenNamed(rowEl, 'c')) {
      const ref = attr(cellEl, 'r');
      const match = /^([A-Z]+)(\d+)$/i.exec(ref);
      const col = match ? columnIndex(match[1]) : fallbackCol;
      fallbackCol = col + 1;
      row[col] = cellFromElement(cellEl, shared);
      if (rowNumber > 0) rows[rowNumber] = row;
    }
    if (!rows[rowNumber]) rows[rowNumber] = row;
  }

  resolveFormulas(rows);
  return { name, rows };
}

function resolveFormulas(rows: RawCell[][]): void {
  const cache = new Map<string, number | null>();

  function resolve(addr: string, stack: string[]): number | null {
    if (cache.has(addr)) return cache.get(addr) ?? null;
    if (stack.includes(addr)) return null;
    const match = /^([A-Z]{1,3})(\d+)$/.exec(addr);
    if (!match) {
      cache.set(addr, null);
      return null;
    }
    const cell = rows[Number(match[2])]?.[columnIndex(match[1])];
    if (!cell) {
      cache.set(addr, null);
      return null;
    }
    if (!cell.formula || cell.number != null) {
      cache.set(addr, cell.number);
      return cell.number;
    }
    stack.push(addr);
    const value = cleanNumber(evaluateFormula(cell.formula, (next) => resolve(next, stack)));
    stack.pop();
    if (value != null) {
      cell.number = value;
      cell.computed = true;
      cell.text = String(value);
    }
    cache.set(addr, value);
    return value;
  }

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    for (let c = 1; c < row.length; c += 1) {
      if (row[c]?.formula) resolve(columnName(c) + String(r), []);
    }
  }
}

function resolveTarget(target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  return `xl/${target.replace(/^\.\//, '')}`;
}

export async function readSheets(data: ArrayBuffer): Promise<SheetGrid[]> {
  const zip = await JSZip.loadAsync(data);
  if (zip.file('EncryptionInfo') || !zip.file('xl/workbook.xml')) {
    throw new Error('이 엑셀은 열 수 없습니다. 암호가 걸려 있거나 xlsx 형식이 아닙니다.');
  }
  const workbookXml = await zip.file('xl/workbook.xml')!.async('string');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const sharedXml = zip.file('xl/sharedStrings.xml')
    ? await zip.file('xl/sharedStrings.xml')!.async('string')
    : null;
  const shared = sharedStrings(sharedXml);
  const rels = parseXml(relsXml);
  const relMap = new Map<string, string>();
  const relationships = findDescendant(rels, 'Relationships');
  for (const rel of relationships ? childrenNamed(relationships, 'Relationship') : []) {
    const type = attr(rel, 'Type');
    if (!type.endsWith('/worksheet')) continue;
    relMap.set(attr(rel, 'Id'), resolveTarget(attr(rel, 'Target')));
  }

  const workbook = parseXml(workbookXml);
  const sheets = findDescendant(workbook, 'sheets');
  const grids: SheetGrid[] = [];
  for (const sheet of sheets ? childrenNamed(sheets, 'sheet') : []) {
    const path = relMap.get(attr(sheet, 'id'));
    if (!path || !zip.file(path)) continue;
    const xml = await zip.file(path)!.async('string');
    grids.push(sheetGrid(attr(sheet, 'name') || 'Sheet', xml, shared));
  }
  if (grids.length === 0) throw new Error('엑셀에서 시트를 찾지 못했습니다.');
  return grids;
}
