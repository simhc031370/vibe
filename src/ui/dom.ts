import { t } from './i18n';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  $('toasts').append(el);
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 5000 : 2800);
  setTimeout(() => el.remove(), kind === 'error' ? 5400 : 3200);
}

let busyCount = 0;
export async function busy<T>(fn: () => Promise<T>): Promise<T> {
  busyCount++;
  $('busy').classList.remove('hidden');
  try {
    return await fn();
  } finally {
    if (--busyCount === 0) $('busy').classList.add('hidden');
  }
}

export function askText(title: string, initial = ''): Promise<string | null> {
  const modal = $('modal');
  const form = $<HTMLFormElement>('modal-form');
  const input = $<HTMLTextAreaElement>('modal-input');
  $('modal-title').textContent = title;
  input.value = initial;
  modal.classList.remove('hidden');
  input.focus();
  input.select();
  return new Promise((resolve) => {
    const close = (v: string | null) => {
      modal.classList.add('hidden');
      form.removeEventListener('submit', onSubmit);
      $('modal-cancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onSubmit = (e: Event) => {
      e.preventDefault();
      const v = input.value.replace(/\s+$/, '');
      close(v ? v : null);
    };
    const onCancel = () => close(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    };
    form.addEventListener('submit', onSubmit);
    $('modal-cancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

export function download(data: Uint8Array | string, name: string, mime = 'application/pdf') {
  const part: BlobPart = typeof data === 'string' ? data : (data as Uint8Array<ArrayBuffer>);
  const url = URL.createObjectURL(new Blob([part], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function errorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Invalid PDF|No PDF header|Failed to parse/i.test(msg)) return t('errNotPdf');
  if (/at least one page/i.test(msg)) return t('errNoPages');
  return msg;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}
