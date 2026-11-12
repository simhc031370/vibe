import { describe, expect, it } from 'vitest';
import { evaluateFormula } from './formulas';

describe('evaluateFormula', () => {
  const cells: Record<string, number> = { E13: 1, F13: 60000, E15: 2, F15: 60000 };

  it('multiplies cell references', () => {
    expect(evaluateFormula('E13*F13', (addr) => cells[addr] ?? null)).toBe(60000);
    expect(evaluateFormula('E15*F15', (addr) => cells[addr] ?? null)).toBe(120000);
  });

  it('sums a range and skips empty cells', () => {
    const grid: Record<string, number> = { G13: 60000, G14: 88000 };
    expect(evaluateFormula('SUM(G13:G15)', (addr) => grid[addr] ?? null)).toBe(148000);
  });

  it('rejects formulas it cannot safely read', () => {
    expect(evaluateFormula('Sheet1!A1', () => 1)).toBeNull();
    expect(evaluateFormula('UNKNOWN(1)', () => 1)).toBeNull();
  });
});
