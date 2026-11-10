export type LineItem = {
  id: string;
  content: string;
  s2b: string;
  spec: string;
  qty: string;
  unit: string;
  unitPrice: string;
  amount: string;
  fee: string;
  /** Shown in the preview only. The template has no column for this. */
  note: string;
};

export type ExportRow = {
  content: string;
  s2b: string;
  spec: string;
  qty: number | null;
  unit: string;
  unitPrice: number | null;
  amount: number | null;
  fee: number | null;
};

export type ParseResult = {
  items: LineItem[];
  notices: string[];
  error: string | null;
  previewText: string;
};

export function emptyResult(error: string | null = null): ParseResult {
  return { items: [], notices: [], error, previewText: '' };
}

export function emptyLine(): LineItem {
  return {
    id: crypto.randomUUID(),
    content: '',
    s2b: '',
    spec: '',
    qty: '',
    unit: '',
    unitPrice: '',
    amount: '',
    fee: '',
    note: '',
  };
}
