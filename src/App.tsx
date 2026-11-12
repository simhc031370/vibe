import { useEffect, useRef, useState } from 'react';
import { buildWorkbook } from './lib/buildWorkbook';
import { formatWon, parseNumber } from './lib/numbers';
import { parseUpload } from './lib/parseUpload';
import { emptyLine, type ExportRow, type LineItem } from './lib/types';

const COLUMNS = [
  { key: 'content', label: '내용', kind: 'text' },
  { key: 'spec', label: '규격', kind: 'text' },
  { key: 'unit', label: '단위', kind: 'text' },
  { key: 'qty', label: '수량', kind: 'number' },
  { key: 'unitPrice', label: '예상단가', kind: 'number' },
] as const;

type ColumnKey = (typeof COLUMNS)[number]['key'];

function amountsDiffer(item: LineItem): boolean {
  const qty = parseNumber(item.qty);
  const price = parseNumber(item.unitPrice);
  const amount = parseNumber(item.amount);
  if (qty == null || price == null || amount == null) return false;
  return Math.abs(qty * price - amount) > 1;
}

function toExportRows(items: LineItem[]): { rows: ExportRow[]; error: string | null } {
  const rows: ExportRow[] = [];
  for (const [index, item] of items.entries()) {
    const numeric: Record<'qty' | 'unitPrice', number | null> = { qty: null, unitPrice: null };
    for (const key of ['qty', 'unitPrice'] as const) {
      const raw = item[key].trim();
      if (!raw) continue;
      const value = parseNumber(raw);
      if (value == null) {
        const label = COLUMNS.find((column) => column.key === key)?.label ?? key;
        return { rows: [], error: `${index + 1}번 줄의 ${label}은 숫자로 입력해 주세요.` };
      }
      numeric[key] = value;
    }
    const row: ExportRow = {
      content: item.content.trim(),
      spec: item.spec.trim(),
      unit: item.unit.trim(),
      qty: numeric.qty,
      unitPrice: numeric.unitPrice,
    };
    const empty = !row.content && !row.spec && !row.unit && row.qty == null && row.unitPrice == null;
    if (!empty) rows.push(row);
  }
  if (rows.length === 0) return { rows: [], error: '내려받을 품목이 없습니다.' };
  return { rows, error: null };
}

function downloadName(): string {
  return '품목내역(통합).xls';
}

function CellField({
  label,
  value,
  numeric,
  align,
  onChange,
}: {
  label: string;
  value: string;
  numeric: boolean;
  align: 'center' | 'end';
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const parsed = numeric ? parseNumber(value) : null;
  const shown = numeric && !focused && parsed != null ? formatWon(parsed) : value;
  return (
    <input
      aria-label={label}
      inputMode={numeric ? 'decimal' : 'text'}
      style={{ textAlign: align }}
      value={shown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [notices, setNotices] = useState<string[]>([]);
  const [previewText, setPreviewText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setNotices([]);
    setPreviewText('');
    setReady(false);
    setStatus('파일을 읽고 있습니다.');
    const result = await parseUpload(file, setStatus);
    setItems(result.items);
    setNotices(result.notices);
    setPreviewText(result.previewText);
    setError(result.error);
    setReady(result.error == null);
    setStatus(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  useEffect(() => {
    if (ready) sheetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [ready, fileName]);

  function update(id: string, key: ColumnKey, value: string) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, [key]: value } : item)));
  }

  async function download() {
    const exported = toExportRows(items);
    if (exported.error) {
      setError(exported.error);
      return;
    }
    setError(null);
    setStatus('품목내역 파일을 만들고 있습니다.');
    try {
      const response = await fetch(encodeURI('/품목내역(통합).xls'));
      if (!response.ok) throw new Error('품목내역 서식을 불러오지 못했습니다.');
      const bytes = buildWorkbook(await response.arrayBuffer(), exported.rows);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy.buffer], { type: 'application/vnd.ms-excel' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName();
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '엑셀 파일을 만들지 못했습니다.');
    } finally {
      setStatus(null);
    }
  }

  const products = items.flatMap((item) => {
    const qty = parseNumber(item.qty);
    const price = parseNumber(item.unitPrice);
    return qty != null && price != null ? [qty * price] : [];
  });
  const hasAmount = products.length > 0;
  const amountTotal = products.reduce((sum, value) => sum + value, 0);

  return (
    <div className="page">
      <header className="masthead">
        <div className="brand">
          <p className="mark">품목내역</p>
          <div>
            <p className="kicker">에듀파인 품의 첨부</p>
            <h1>영수증·견적서를 품목내역으로</h1>
          </div>
        </div>
        <p className="lede">
          파일을 올리면 이 화면에 품목내역이 채워집니다. 열은 내용, 규격, 단위, 수량, 예상단가이고, 같은 표를 엑셀로도 받습니다.
        </p>
      </header>

      <main>
        <label
          className={dragging ? 'drop dragging' : 'drop'}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void handleFile(event.dataTransfer.files[0]);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.pdf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,application/pdf,image/*"
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
          <span className="drop-title">견적서나 영수증 올리기</span>
          <span className="drop-copy">xlsx, PDF, JPG, PNG를 끌어다 놓거나 눌러서 고르세요.</span>
          <span className="drop-note">파일은 이 브라우저 안에서만 처리되고 서버로 보내지 않습니다.</span>
        </label>

        {status && (
          <p className="status" role="status">
            {status}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {ready && (
          <section className="sheet" aria-labelledby="preview-title" ref={sheetRef}>
            <div className="sheet-head">
              <div>
                <h2 id="preview-title">품목내역</h2>
                <p>
                  {fileName}에서 채운 품목내역(통합) · {items.length}건
                </p>
              </div>
              <button type="button" className="primary" onClick={() => void download()}>
                품목내역(통합).xls 내려받기
              </button>
            </div>

            {notices.length > 0 && (
              <ul className="notices">
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            )}

            <div className="ledger">
              <p className="ledger-tab">품목내역</p>
              <div className="table-scroll">
                <table>
                  <caption>품목내역(통합)과 같은 다섯 열입니다.</caption>
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => (
                        <th key={column.key} scope="col">
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 && (
                      <tr>
                        <td colSpan={5} className="empty">
                          가져온 품목이 없습니다. 아래에서 직접 넣을 수 있습니다.
                        </td>
                      </tr>
                    )}
                    {items.map((item, index) => (
                      <tr key={item.id} className={amountsDiffer(item) ? 'mismatch' : undefined}>
                        {COLUMNS.map((column) => (
                          <td key={column.key}>
                            <CellField
                              label={`${index + 1}번 ${column.label}`}
                              value={item[column.key]}
                              numeric={column.kind === 'number'}
                              align={column.key === 'unitPrice' ? 'end' : 'center'}
                              onChange={(value) => update(item.id, column.key, value)}
                            />
                            {column.key === 'unitPrice' && amountsDiffer(item) && (
                              <em>수량×단가와 공급금액이 다릅니다</em>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {hasAmount && (
              <p className="ledger-sum">수량×예상단가 합계 {formatWon(amountTotal)}원. 이 합계는 품목내역 열에 없습니다.</p>
            )}

            <div className="sheet-actions">
              <button type="button" onClick={() => setItems((current) => [...current, emptyLine()])}>
                품목 추가
              </button>
              <div className="row-tools">
                {items.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}
                  >
                    {index + 1}번 줄 빼기
                  </button>
                ))}
              </div>
              <p>표의 다섯 칸을 고치면 화면과 내려받는 파일이 함께 바뀝니다.</p>
            </div>

            {previewText && (
              <details>
                <summary>파일에서 읽은 글</summary>
                <pre>{previewText}</pre>
              </details>
            )}
          </section>
        )}
      </main>

      <footer>
        <p>엑셀 견적서는 표를 그대로 읽습니다. PDF와 사진은 글자가 분명할 때만 품목으로 올리고, 아니면 비워 둡니다.</p>
      </footer>
    </div>
  );
}
