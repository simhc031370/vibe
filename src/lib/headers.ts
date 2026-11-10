export type Field =
  | 'itemCategory'
  | 'itemName'
  | 'content'
  | 'spec'
  | 'qty'
  | 'unit'
  | 'unitPrice'
  | 'amount'
  | 's2b'
  | 'fee'
  | 'note'
  | 'seq';

const HEADER_MAP: Record<string, Field> = {
  품목: 'itemCategory',
  품목분류: 'itemCategory',
  품목구분: 'itemCategory',
  품명: 'itemName',
  품목명: 'itemName',
  물품명: 'itemName',
  상품명: 'itemName',
  제품명: 'itemName',
  모델명: 'itemName',
  내용: 'content',
  적요: 'content',
  내역: 'content',
  규격: 'spec',
  규격명: 'spec',
  사양: 'spec',
  스펙: 'spec',
  수량: 'qty',
  단위: 'unit',
  단가: 'unitPrice',
  예상단가: 'unitPrice',
  공급단가: 'unitPrice',
  판매단가: 'unitPrice',
  공급금액: 'amount',
  금액: 'amount',
  예상금액: 'amount',
  공급가액: 'amount',
  공급가: 'amount',
  합계금액: 'amount',
  합계: 'amount',
  s2b물품번호: 's2b',
  물품번호: 's2b',
  s2b번호: 's2b',
  상품번호: 's2b',
  수수료: 'fee',
  납품실: 'note',
  납품장소: 'note',
  사용처: 'note',
  납품처: 'note',
  날짜: 'note',
  납품일: 'note',
  일자: 'note',
  비고: 'note',
  메모: 'note',
  참고: 'note',
  순번: 'seq',
  번호: 'seq',
  연번: 'seq',
  no: 'seq',
  'no.': 'seq',
};

export function normalizeHeader(raw: string): string {
  return raw
    .replace(/\s+/g, '')
    .replace(/[*＊▲▼△▽:：]/g, '')
    .replace(/[()（）[\]【】]/g, '')
    .toLowerCase();
}

export function matchHeader(raw: string): Field | null {
  const key = normalizeHeader(raw);
  if (!key || key.length > 20) return null;
  return HEADER_MAP[key] ?? null;
}

export function isTotalLabel(text: string): boolean {
  const n = text.replace(/\s+/g, '');
  if (!n) return false;
  return /^(합계|총계|소계|총합계|총합|공급가액|부가세|부가세액|총금액|총액|합계금액|공급대가)([(*:：.\-].*)?$/.test(
    n,
  );
}

export function isNameField(field: Field): boolean {
  return field === 'itemCategory' || field === 'itemName' || field === 'content' || field === 'spec';
}

export function isNumericField(field: Field): boolean {
  return field === 'qty' || field === 'unitPrice' || field === 'amount';
}
