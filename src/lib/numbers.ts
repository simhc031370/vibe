export function parseNumber(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/，/g, ',');
  s = s.replace(/원|₩|￦/g, '');
  s = s.replace(/\s+/g, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function cleanNumber(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) < 1e-6) return rounded;
  return Math.round(n * 100) / 100;
}

export function formatWon(n: number): string {
  return n.toLocaleString('ko-KR');
}

export function formatEditable(n: number | null): string {
  if (n == null) return '';
  if (Number.isInteger(n)) return String(n);
  return String(n);
}
