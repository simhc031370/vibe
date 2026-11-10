import { isNameField, isNumericField, isTotalLabel, matchHeader, type Field } from './headers';
import { cleanNumber, formatEditable, parseNumber } from './numbers';
import { emptyLine, type LineItem } from './types';
import type { RawCell, SheetGrid } from './xlsxRead';

type Match = { col: number; field: Field; header: string };

type Stats = {
  formulaAmounts: number;
  productAmounts: number;
  skippedEmpty: number;
  skippedTotal: number;
  keptWithNotes: number;
};

export type Extraction = {
  items: LineItem[];
  notices: string[];
  headerFound: boolean;
};

function textOf(cell: RawCell | undefined): string {
  return cell?.text?.trim() ?? '';
}

function numberOf(cell: RawCell | undefined): number | null {
  if (!cell) return null;
  if (cell.number != null) return cell.number;
  return parseNumber(cell.text);
}

function joinParts(parts: string[]): string {
  const unique: string[] = [];
  for (const part of parts.map((part) => part.trim()).filter(Boolean)) {
    const folded = part.replace(/\s/g, '');
    const existing = unique.findIndex((item) => {
      const other = item.replace(/\s/g, '');
      return other === folded || other.includes(folded) || folded.includes(other);
    });
    if (existing >= 0) {
      if (part.length > unique[existing].length) unique[existing] = part;
      continue;
    }
    unique.push(part);
  }
  return unique.join(' / ');
}

function noticesFromStats(stats: Stats, noteHeaders: string[]): string[] {
  const notices: string[] = [];
  if (stats.formulaAmounts > 0) {
    notices.push(
      `금액 칸에 계산식만 있고 결과가 저장되어 있지 않아, 식을 풀어 ${stats.formulaAmounts}건의 금액을 채웠습니다.`,
    );
  }
  if (stats.productAmounts > 0) {
    notices.push(`금액 칸이 비어 있어 수량×단가로 ${stats.productAmounts}건의 금액을 채웠습니다.`);
  }
  if (stats.skippedEmpty > 0) {
    notices.push(`품목명과 금액이 함께 있지 않은 줄 ${stats.skippedEmpty}건은 넣지 않았습니다.`);
  }
  if (stats.skippedTotal > 0) {
    notices.push(`합계 줄 ${stats.skippedTotal}건은 넣지 않았습니다.`);
  }
  if (noteHeaders.length > 0 && stats.keptWithNotes > 0) {
    notices.push(
      `${noteHeaders.join(', ')} 칸은 품목내역 서식에 없습니다. 참고란에만 보이고 엑셀에는 들어가지 않습니다.`,
    );
  }
  return notices;
}

function headerScore(matches: Match[]): number {
  const fields = new Set(matches.map((match) => match.field));
  const hasName = [...fields].some((field) => isNameField(field));
  const hasNumeric = [...fields].some((field) => isNumericField(field));
  if (!hasName || !hasNumeric || matches.length < 2) return 0;
  return matches.length;
}

export function extractFromGrid(grid: SheetGrid): Extraction {
  let best: { row: number; matches: Match[] } | null = null;
  for (let r = 1; r < grid.rows.length; r += 1) {
    const matches: Match[] = [];
    const row = grid.rows[r] ?? [];
    for (let c = 1; c < row.length; c += 1) {
      const text = row[c]?.text ?? '';
      const field = matchHeader(text);
      if (!field) continue;
      matches.push({ col: c, field, header: text.trim() });
    }
    const score = headerScore(matches);
    if (score === 0) continue;
    if (!best || score > headerScore(best.matches)) best = { row: r, matches };
  }

  if (!best) {
    return {
      items: [],
      headerFound: false,
      notices: ['품목, 수량, 단가 같은 머리글을 찾지 못했습니다. 아래에서 직접 입력할 수 있습니다.'],
    };
  }

  const contentCols: Match[] = [];
  const noteCols: Match[] = [];
  const scalar = new Map<Field, Match>();
  for (const match of best.matches) {
    if (match.field === 'seq') continue;
    if (match.field === 'itemCategory' || match.field === 'itemName' || match.field === 'content') {
      contentCols.push(match);
      continue;
    }
    if (match.field === 'note') {
      noteCols.push(match);
      continue;
    }
    if (scalar.has(match.field)) noteCols.push(match);
    else scalar.set(match.field, match);
  }

  const stats: Stats = {
    formulaAmounts: 0,
    productAmounts: 0,
    skippedEmpty: 0,
    skippedTotal: 0,
    keptWithNotes: 0,
  };
  const items: LineItem[] = [];

  for (let r = best.row + 1; r < grid.rows.length; r += 1) {
    const row = grid.rows[r] ?? [];
    const rowTexts = row.filter(Boolean).map((cell) => cell.text);
    if (rowTexts.some((text) => isTotalLabel(text))) {
      stats.skippedTotal += 1;
      continue;
    }

    const repeated = best.matches.filter((match) => matchHeader(textOf(row[match.col])) === match.field).length;
    if (repeated >= 2) continue;

    const contentParts = contentCols.map((match) => textOf(row[match.col]));
    const spec = textOf(row[scalar.get('spec')?.col ?? -1]);
    const qty = numberOf(row[scalar.get('qty')?.col ?? -1]);
    const unit = textOf(row[scalar.get('unit')?.col ?? -1]);
    const unitPrice = numberOf(row[scalar.get('unitPrice')?.col ?? -1]);
    const amountCell = row[scalar.get('amount')?.col ?? -1];
    let amount = numberOf(amountCell);
    const s2b = textOf(row[scalar.get('s2b')?.col ?? -1]);
    const fee = numberOf(row[scalar.get('fee')?.col ?? -1]);
    const notes = noteCols
      .map((match) => {
        const value = textOf(row[match.col]);
        return value ? `${match.header} ${value}` : '';
      })
      .filter(Boolean);

    const formulaAmount = Boolean(amountCell?.computed && amount != null);
    let productAmount = false;
    if (amount == null && qty != null && unitPrice != null) {
      amount = cleanNumber(qty * unitPrice);
      productAmount = amount != null;
    }

    const content = joinParts(contentParts);
    const hasNum = qty != null || unitPrice != null || amount != null || fee != null;
    const hasName = Boolean(content || spec || s2b || unit);
    if (!hasName || !hasNum) {
      stats.skippedEmpty += 1;
      continue;
    }

    if (formulaAmount) stats.formulaAmounts += 1;
    if (productAmount) stats.productAmounts += 1;
    const note = notes.join(' · ');
    if (note) stats.keptWithNotes += 1;
    const item = emptyLine();
    item.content = content;
    item.spec = spec;
    item.qty = formatEditable(qty);
    item.unit = unit;
    item.unitPrice = formatEditable(unitPrice);
    item.amount = formatEditable(amount);
    item.s2b = s2b;
    item.fee = formatEditable(fee);
    item.note = note;
    items.push(item);
  }

  const noteHeaders = [...new Set(noteCols.map((match) => match.header))];
  const notices = noticesFromStats(stats, noteHeaders);
  if (items.length === 0) {
    notices.push('머리글은 찾았지만 가져올 품목이 없습니다. 아래에서 직접 입력할 수 있습니다.');
  }
  return { items, notices, headerFound: true };
}
