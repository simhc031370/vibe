import { isNameField, isNumericField, isTotalLabel, matchHeader, type Field } from './headers';
import { cleanNumber, formatEditable, parseNumber } from './numbers';
import { emptyLine, type LineItem } from './types';

export type WordBox = {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
};

type Column = { field: Field; header: string; x0: number; x1: number };

export type PositionedExtraction = {
  items: LineItem[];
  notices: string[];
  plainText: string;
  headerFound: boolean;
};

function clusterLines(words: WordBox[]): WordBox[][] {
  const sorted = words
    .filter((word) => word.text.trim())
    .sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines: WordBox[][] = [];
  for (const word of sorted) {
    const center = (word.y0 + word.y1) / 2;
    const height = Math.max(4, word.y1 - word.y0);
    const line = lines.find((candidate) => {
      const sample = candidate[0];
      const sampleCenter = (sample.y0 + sample.y1) / 2;
      const sampleHeight = Math.max(4, sample.y1 - sample.y0);
      return Math.abs(center - sampleCenter) < Math.max(height, sampleHeight) * 0.65;
    });
    if (line) line.push(word);
    else lines.push([word]);
  }
  for (const line of lines) line.sort((a, b) => a.x0 - b.x0);
  return lines.sort((a, b) => a[0].y0 - b[0].y0);
}

function headerColumns(line: WordBox[]): Column[] {
  const columns: Column[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const single = matchHeader(line[i].text);
    const paired =
      i + 1 < line.length ? matchHeader(`${line[i].text}${line[i + 1].text}`) : null;
    if (paired && paired !== 'seq' && !single) {
      columns.push({
        field: paired,
        header: `${line[i].text}${line[i + 1].text}`.trim(),
        x0: line[i].x0,
        x1: line[i + 1].x1,
      });
      i += 1;
      continue;
    }
    if (single && single !== 'seq') {
      columns.push({
        field: single,
        header: line[i].text.trim(),
        x0: line[i].x0,
        x1: line[i].x1,
      });
    }
  }
  const fields = new Set(columns.map((column) => column.field));
  const hasName = [...fields].some((field) => isNameField(field));
  const hasNumeric = [...fields].some((field) => isNumericField(field));
  if (!hasName || !hasNumeric || columns.length < 2) return [];
  return columns;
}

function columnFor(word: WordBox, columns: Column[]): Column | null {
  const center = (word.x0 + word.x1) / 2;
  if (center < columns[0].x0 - 12) return null;
  for (let i = 0; i < columns.length; i += 1) {
    const prevEdge = i === 0 ? -Infinity : (columns[i - 1].x1 + columns[i].x0) / 2;
    const nextEdge = i === columns.length - 1 ? Infinity : (columns[i].x1 + columns[i + 1].x0) / 2;
    if (center >= prevEdge && center < nextEdge) return columns[i];
  }
  return null;
}

function looseLine(line: WordBox[]): LineItem | null {
  const tokens = line
    .map((word) => word.text.trim())
    .filter(Boolean)
    .flatMap((text) => text.split(/\s+/));
  const numbers: number[] = [];
  while (tokens.length > 0) {
    const value = parseNumber(tokens[tokens.length - 1]);
    if (value == null || !/\d/.test(tokens[tokens.length - 1])) break;
    numbers.unshift(value);
    tokens.pop();
  }
  const content = tokens.join(' ').trim();
  if (!content || isTotalLabel(content) || numbers.length !== 3) return null;
  const [qty, unitPrice, amount] = numbers;
  const product = qty * unitPrice;
  if (Math.abs(product - amount) > Math.max(1, Math.abs(amount) * 0.02)) return null;
  const item = emptyLine();
  item.content = content;
  item.qty = formatEditable(qty);
  item.unitPrice = formatEditable(unitPrice);
  item.amount = formatEditable(cleanNumber(amount));
  return item;
}

export function extractPositioned(words: WordBox[]): PositionedExtraction {
  const lines = clusterLines(words);
  const plainText = lines.map((line) => line.map((word) => word.text.trim()).join(' ')).join('\n');
  let headerIndex = -1;
  let columns: Column[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const found = headerColumns(lines[i]);
    if (found.length > columns.length) {
      columns = found;
      headerIndex = i;
    }
  }

  if (headerIndex < 0) {
    const loose = lines.map(looseLine).filter((item): item is LineItem => item != null);
    if (loose.length === 0) {
      return {
        items: [],
        headerFound: false,
        plainText,
        notices: ['표로 확신할 수 있는 품목이 없습니다. 읽힌 글자를 보고 직접 입력해 주세요.'],
      };
    }
    return {
      items: loose,
      headerFound: false,
      plainText,
      notices: ['머리글을 찾지 못해, 수량×단가와 금액이 맞는 줄만 가져왔습니다. 숫자를 확인해 주세요.'],
    };
  }

  const items: LineItem[] = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const buckets = new Map<Column, string[]>();
    for (const word of line) {
      const column = columnFor(word, columns);
      if (!column) continue;
      const list = buckets.get(column) ?? [];
      list.push(word.text.trim());
      buckets.set(column, list);
    }
    const contentParts: string[] = [];
    let spec = '';
    let qty: number | null = null;
    let unit = '';
    let unitPrice: number | null = null;
    let amount: number | null = null;
    let s2b = '';
    let fee: number | null = null;
    const notes: string[] = [];
    const rowTexts: string[] = [];
    for (const column of columns) {
      const text = (buckets.get(column) ?? []).join(' ').trim();
      if (!text) continue;
      rowTexts.push(text);
      if (column.field === 'itemCategory' || column.field === 'itemName' || column.field === 'content') {
        contentParts.push(text);
      } else if (column.field === 'spec') spec = text;
      else if (column.field === 'qty') qty = parseNumber(text);
      else if (column.field === 'unit') unit = text;
      else if (column.field === 'unitPrice') unitPrice = parseNumber(text);
      else if (column.field === 'amount') amount = parseNumber(text);
      else if (column.field === 's2b') s2b = text;
      else if (column.field === 'fee') fee = parseNumber(text);
      else if (column.field === 'note') notes.push(`${column.header} ${text}`);
    }
    if (rowTexts.some((text) => isTotalLabel(text))) continue;
    if (amount == null && qty != null && unitPrice != null) amount = cleanNumber(qty * unitPrice);
    const content = contentParts
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' / ');
    if (!(content || spec) || (qty == null && unitPrice == null && amount == null && fee == null)) continue;
    const item = emptyLine();
    item.content = content;
    item.spec = spec;
    item.qty = formatEditable(qty);
    item.unit = unit;
    item.unitPrice = formatEditable(unitPrice);
    item.amount = formatEditable(amount);
    item.s2b = s2b;
    item.fee = formatEditable(fee);
    item.note = notes.join(' · ');
    items.push(item);
  }

  const noteHeaders = [...new Set(columns.filter((column) => column.field === 'note').map((column) => column.header))];
  const notices: string[] = [];
  if (items.some((item) => item.note) && noteHeaders.length > 0) {
    notices.push(
      `${noteHeaders.join(', ')} 칸은 품목내역 서식에 없습니다. 참고란에만 보이고 엑셀에는 들어가지 않습니다.`,
    );
  }
  if (items.length === 0) {
    notices.push('머리글은 찾았지만 가져올 품목이 없습니다. 읽힌 글자를 보고 직접 입력해 주세요.');
  }
  return { items, notices, plainText, headerFound: true };
}
