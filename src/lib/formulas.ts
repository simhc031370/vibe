import { cleanNumber } from './numbers';

export type FormulaGetter = (addr: string) => number | null;

export function evaluateFormula(formula: string, get: FormulaGetter): number | null {
  let src = formula.trim();
  if (src.startsWith('=')) src = src.slice(1);
  src = src.replace(/\$/g, '');
  if (!src || src.includes('!') || src.length > 500) return null;

  let i = 0;

  function peek(): string {
    return src[i] ?? '';
  }

  function skip(): void {
    while (src[i] === ' ') i += 1;
  }

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left == null) return null;
    while (true) {
      skip();
      const op = peek();
      if (op !== '+' && op !== '-') break;
      i += 1;
      const right = parseTerm();
      if (right == null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left == null) return null;
    while (true) {
      skip();
      const op = peek();
      if (op !== '*' && op !== '/') break;
      i += 1;
      const right = parseFactor();
      if (right == null) return null;
      if (op === '/' && right === 0) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }

  function parseFactor(): number | null {
    skip();
    const ch = peek();
    if (ch === '+') {
      i += 1;
      return parseFactor();
    }
    if (ch === '-') {
      i += 1;
      const value = parseFactor();
      return value == null ? null : -value;
    }
    if (ch === '(') {
      i += 1;
      const value = parseExpr();
      skip();
      if (peek() !== ')') return null;
      i += 1;
      return value;
    }

    const fn = /^([A-Za-z]+)(?=\()/.exec(src.slice(i));
    if (fn) {
      i += fn[1].length;
      return parseFunction(fn[1].toUpperCase());
    }

    const ref = /^([A-Za-z]{1,3})(\d+)/.exec(src.slice(i));
    if (ref) {
      i += ref[0].length;
      return get(ref[1].toUpperCase() + ref[2]);
    }

    const num = /^(\d+(?:\.\d+)?)/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    return null;
  }

  function parseFunction(name: string): number | null {
    skip();
    if (peek() !== '(') return null;
    i += 1;
    const args = parseArgs();
    if (!args) return null;
    if (name === 'SUM') return args.reduce((sum, value) => sum + value, 0);
    if (name === 'ROUND') {
      if (args.length < 1) return null;
      const digits = args[1] ?? 0;
      const factor = 10 ** digits;
      return Math.round(args[0] * factor) / factor;
    }
    return null;
  }

  function parseArgs(): number[] | null {
    const out: number[] = [];
    skip();
    if (peek() === ')') {
      i += 1;
      return out;
    }
    while (true) {
      skip();
      const range = /^([A-Za-z]{1,3})(\d+)\s*:\s*([A-Za-z]{1,3})(\d+)/.exec(src.slice(i));
      if (range) {
        i += range[0].length;
        const c1 = columnIndex(range[1]);
        const r1 = Number(range[2]);
        const c2 = columnIndex(range[3]);
        const r2 = Number(range[4]);
        const rMin = Math.min(r1, r2);
        const rMax = Math.max(r1, r2);
        const cMin = Math.min(c1, c2);
        const cMax = Math.max(c1, c2);
        if ((rMax - rMin + 1) * (cMax - cMin + 1) > 5000) return null;
        for (let r = rMin; r <= rMax; r += 1) {
          for (let c = cMin; c <= cMax; c += 1) {
            const value = get(columnName(c) + String(r));
            if (value != null) out.push(value);
          }
        }
      } else {
        const value = parseExpr();
        if (value == null) return null;
        out.push(value);
      }
      skip();
      if (peek() === ',') {
        i += 1;
        continue;
      }
      if (peek() === ')') {
        i += 1;
        return out;
      }
      return null;
    }
  }

  const result = parseExpr();
  skip();
  if (result == null || i !== src.length) return null;
  return cleanNumber(result);
}

export function columnIndex(letters: string): number {
  let n = 0;
  const upper = letters.toUpperCase();
  for (const ch of upper) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function columnName(index: number): string {
  let n = index;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
