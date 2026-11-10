import { useRef, useState } from 'react';
import { buildWorkbook } from './lib/buildWorkbook';
import { formatWon, parseNumber } from './lib/numbers';
import { parseUpload } from './lib/parseUpload';
import { emptyLine, type ExportRow, type LineItem } from './lib/types';

const COLUMNS = [
  { key: 'content', label: '* 내용', kind: 'text' },
  { key: 's2b', label: 'S2B물품번호', kind: 'text' },
  { key: 'spec', label: '규격▲', kind: 'text' },
  { key: 'qty', label: '수량', kind: 'number' },
  { key: 'unit', label: '단위', kind: 'text' },
  { key: 'unitPrice', label: '예상단가', kind: 'number' },
  { key: 'amount', label: '* 예상금액', kind: 'number' },
  { key: 'fee', label: '수수료', kind: 'number' },
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
    const numeric: Record<'qty' | 'unitPrice' | 'amount' | 'fee', number | null> = {
      qty: null,
      unitPrice: null,
      amount: null,
      fee: null,
    };
    for (const key of ['qty', 'unitPrice', 'amount', 'fee'] as const) {
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
      s2b: item.s2b.trim(),
      spec: item.spec.trim(),
      unit: item.unit.trim(),
      qty: numeric.qty,
      unitPrice: numeric.unitPrice,
      amount: numeric.amount,
      fee: numeric.fee,
    };
    const empty =
      !row.content &&
      !row.s2b &&
      !row.spec &&
      !row.unit &&
      row.qty == null &&
      row.unitPrice == null &&
      row.amount == null &&
      row.fee == null;
    if (!empty) rows.push(row);
  }
  if (rows.length === 0) return { rows: [], error: '내려받을 품목이 없습니다.' };
  return { rows, error: null };
}

function downloadName(fileName: string | null): string {
  const base = (fileName ?? '품목내역').replace(/\.[^.]+$/, '').trim() || '품목내역';
  return `${base}_품목내역.xlsx`;
}

export function App() {
  const inputRef = useRef<HTMLInputElement>(null);
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
      const template = await fetch('/template.xlsx');
      if (!template.ok) throw new Error('서식을 불러오지 못했습니다.');
      const bytes = await buildWorkbook(await template.arrayBuffer(), exported.rows);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy.buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName(fileName);
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '엑셀 파일을 만들지 못했습니다.');
    } finally {
      setStatus(null);
    }
  }

  const amountTotal = items.reduce((sum, item) => sum + (parseNumber(item.amount) ?? 0), 0);
  const hasAmount = items.some((item) => parseNumber(item.amount) != null);

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
          올린 파일에서 품목, 규격, 수량, 단가, 금액을 읽어 학교 품목내역 서식 그대로 엑셀 파일을 만듭니다.
          머리글과 열 순서는 바꾸지 않고, 서식에 없는 열은 더하지 않습니다.
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
          <section className="sheet" aria-labelledby="preview-title">
            <div className="sheet-head">
              <div>
                <h2 id="preview-title">읽어 온 품목</h2>
                <p>
                  {fileName} · {items.length}건
                  {hasAmount ? ` · 예상금액 합계 ${formatWon(amountTotal)}원` : ''}
                </p>
              </div>
              <button type="button" className="primary" onClick={() => void download()}>
                품목내역 엑셀 내려받기
              </button>
            </div>

            {notices.length > 0 && (
              <ul className="notices">
                {notices.map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            )}

            <div className="table-scroll">
              <table>
                <caption>품목내역 서식과 같은 열입니다. 참고 칸은 엑셀에 들어가지 않습니다.</caption>
                <thead>
                  <tr>
                    <th>순번</th>
                    {COLUMNS.map((column) => (
                      <th key={column.key}>{column.label}</th>
                    ))}
                    <th className="note-col">
                      참고
                      <span>엑셀 미포함</span>
                    </th>
                    <th className="row-action">
                      <span className="sr">행</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 && (
                    <tr>
                      <td colSpan={11} className="empty">
                        가져온 품목이 없습니다. 아래 버튼으로 직접 넣을 수 있습니다.
                      </td>
                    </tr>
                  )}
                  {items.map((item, index) => (
                    <tr key={item.id} className={amountsDiffer(item) ? 'mismatch' : undefined}>
                      <td className="seq">{index + 1}</td>
                      {COLUMNS.map((column) => (
                        <td key={column.key} className={column.kind === 'number' ? 'num' : undefined}>
                          <input
                            aria-label={`${index + 1}번 ${column.label}`}
                            inputMode={column.kind === 'number' ? 'decimal' : 'text'}
                            value={item[column.key]}
                            onChange={(event) => update(item.id, column.key, event.target.value)}
                          />
                          {column.key === 'amount' && amountsDiffer(item) && (
                            <em>수량×단가와 다릅니다</em>
                          )}
                        </td>
                      ))}
                      <td className="note-col">{item.note}</td>
                      <td className="row-action">
                        <button
                          type="button"
                          onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                {hasAmount && (
                  <tfoot>
                    <tr>
                      <td colSpan={7}>예상금액 합계</td>
                      <td className="num total">{formatWon(amountTotal)}</td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            <div className="sheet-actions">
              <button type="button" onClick={() => setItems((current) => [...current, emptyLine()])}>
                품목 추가
              </button>
              <p>칸을 고친 뒤 내려받으세요. S2B물품번호와 수수료는 서식에 있으나 칸 너비가 숨겨져 있습니다.</p>
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
