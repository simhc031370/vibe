import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as ops from './core/pdf-ops';
import { extractPageTexts, searchTexts, textsToTxt } from './core/text';
import { t, applyI18n, getLang, setLang } from './ui/i18n';
import { rasterizeText, rasterizeWatermark, imageFileToPng, canvasToBytes } from './ui/raster';
import { $, toast, busy, askText, download, readFile, formatBytes, errorMessage, svgEl } from './ui/dom';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = new URL('pdfjs/', new URL(import.meta.env.BASE_URL, location.href)).href;
const loadPdf = (bytes: Uint8Array) =>
  pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
  }).promise;

type Mode = 'read' | 'comment' | 'organize' | 'tools';
type Tool = 'none' | 'highlight' | 'rect' | 'ink' | 'text' | 'note' | 'stamp' | 'whiteout' | 'image' | 'eraser';
type Annot = ops.Annotation & { id: string };
type OrgItem = { key: number } & ops.PagePlanItem;

interface Snapshot {
  bytes: Uint8Array;
  annots: Annot[];
}
interface PageView {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  svg: SVGSVGElement;
  viewport: PageViewport;
  rendered: boolean;
}

const state = {
  bytes: null as Uint8Array | null,
  fileName: 'document.pdf',
  pdf: null as PDFDocumentProxy | null,
  mode: 'read' as Mode,
  scale: 1,
  fit: true,
  annots: [] as Annot[],
  tool: 'none' as Tool,
  history: [] as Snapshot[],
  future: [] as Snapshot[],
  texts: null as string[] | null,
  pages: [] as PageView[],
  currentPage: 0,
  plan: [] as OrgItem[],
  renderGen: 0,
  docGen: 0,
  pendingImage: null as { png: Uint8Array; width: number; height: number; url: string } | null,
};

let nextId = 1;
const uid = () => `a${nextId++}`;
const stem = () => state.fileName.replace(/\.pdf$/i, '');
const imageUrls = new Map<string, string>();

// ---------------------------------------------------------------- document lifecycle

async function openNew(bytes: Uint8Array, name: string) {
  const pdf = await loadPdf(bytes);
  state.history = [];
  state.future = [];
  state.annots = [];
  state.fileName = name;
  $('welcome').classList.add('hidden');
  document.body.classList.add('has-doc');
  await showDocument(bytes, pdf, false);
}

async function showDocument(bytes: Uint8Array, pdf?: PDFDocumentProxy, keepScroll = true) {
  pdf ??= await loadPdf(bytes);
  const old = state.pdf;
  state.pdf = pdf;
  state.bytes = bytes;
  state.texts = null;
  state.docGen++;
  thumbCache.clear();
  void old?.destroy();
  setMode(state.mode, true);
  await renderViewer(keepScroll);
  renderThumbs();
  buildPlan();
  if (state.mode === 'organize') renderOrganizer();
  void fillMetadata();
  if (($<HTMLInputElement>('search-input')).value.trim()) void runSearch();
  updateChrome();
}

function snapshot(): Snapshot {
  return { bytes: state.bytes!, annots: [...state.annots] };
}

function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 50) state.history.shift();
  state.future = [];
}

async function commit(bytes: Uint8Array) {
  pushHistory();
  state.annots = [];
  await showDocument(bytes);
}

async function restore(s: Snapshot) {
  const sameBytes = s.bytes === state.bytes;
  state.annots = s.annots;
  if (sameBytes) {
    redrawAllAnnots();
    updateChrome();
  } else {
    await showDocument(s.bytes);
  }
}

async function undo() {
  const s = state.history.pop();
  if (!s) return;
  state.future.push(snapshot());
  await restore(s);
}

async function redo() {
  const s = state.future.pop();
  if (!s) return;
  state.history.push(snapshot());
  await restore(s);
}

/** Convert UI annotations to core annotations, rasterizing text the standard fonts can't encode. */
async function toCoreAnnots(annots: Annot[]): Promise<ops.Annotation[]> {
  const out: ops.Annotation[] = [];
  for (const { id: _id, ...a } of annots) {
    if ((a.type === 'text' || a.type === 'stamp') && !ops.isWinAnsiEncodable(a.text)) {
      const { png, rect } = await rasterizeText(a.text, a.x, a.y, a.size, a.color, a.type === 'stamp');
      out.push({ type: 'image', page: a.page, rect, png });
    } else {
      out.push(a);
    }
  }
  return out;
}

/** Current bytes with pending annotations burned in. */
async function flattenedBytes(): Promise<Uint8Array> {
  if (!state.bytes) throw new Error('No document');
  if (state.annots.length === 0) return state.bytes;
  return ops.applyAnnotations(state.bytes, await toCoreAnnots(state.annots));
}

/** Run a document-changing operation on the (flattened) document and record it in history. */
async function runOp(fn: (b: Uint8Array) => Promise<Uint8Array>, message = t('done')) {
  try {
    await busy(async () => {
      const out = await fn(await flattenedBytes());
      await commit(out);
    });
    if (message) toast(message);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Run an export that does not change the document. */
async function runExport(fn: (b: Uint8Array) => Promise<void>) {
  try {
    await busy(async () => fn(await flattenedBytes()));
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

async function save() {
  if (!state.bytes) return;
  try {
    await busy(async () => {
      if (state.annots.length) await commit(await flattenedBytes());
      download(state.bytes!, state.fileName);
    });
    toast(t('saved', { name: state.fileName }));
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

// ---------------------------------------------------------------- chrome

function updateChrome() {
  const has = !!state.pdf;
  $<HTMLButtonElement>('btn-save').disabled = !has;
  $<HTMLButtonElement>('btn-undo').disabled = state.history.length === 0;
  $<HTMLButtonElement>('btn-redo').disabled = state.future.length === 0;
  $('file-name').textContent = has ? state.fileName : '';
  $('page-total').textContent = String(state.pdf?.numPages ?? 0);
  $<HTMLInputElement>('page-input').value = String(state.currentPage + 1);
  $('btn-zoom-label').textContent = `${Math.round(state.scale * 100)}%`;
  const n = state.annots.length;
  $('pending-count').textContent = n ? t('pending', { n }) : '';
  $<HTMLButtonElement>('btn-apply-annots').disabled = n === 0;
  $('btn-lang').textContent = getLang() === 'ko' ? 'EN' : '한국어';
  document.querySelectorAll<HTMLElement>('.thumb').forEach((el, i) => el.classList.toggle('active', i === state.currentPage));
}

function setMode(mode: Mode, silent = false) {
  if (!state.pdf && !silent) return;
  state.mode = mode;
  document.querySelectorAll<HTMLElement>('.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const organize = mode === 'organize';
  $('viewer').classList.toggle('hidden', !state.pdf || organize);
  $('organizer').classList.toggle('hidden', !state.pdf || !organize);
  $('organize-bar').classList.toggle('hidden', !state.pdf || !organize);
  $('comment-bar').classList.toggle('hidden', !state.pdf || mode !== 'comment');
  $('panel-tools').classList.toggle('hidden', mode !== 'tools');
  const searching = !!$<HTMLInputElement>('search-input').value.trim();
  $('panel-search').classList.toggle('hidden', mode === 'tools' || !searching);
  $('panel-thumbs').classList.toggle('hidden', mode === 'tools' || searching);
  document.body.dataset.mode = mode;
  document.body.dataset.tool = mode === 'comment' ? state.tool : 'none';
  if (organize && !silent) renderOrganizer();
}

function setTool(tool: Tool) {
  state.tool = tool;
  document.querySelectorAll<HTMLElement>('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  document.body.dataset.tool = tool;
  const color = $<HTMLInputElement>('annot-color');
  const defaults: Partial<Record<Tool, string>> = { highlight: '#ffd400', rect: '#e53935', ink: '#1e40af', text: '#111111', note: '#ffb300', stamp: '#d32f2f' };
  if (defaults[tool]) color.value = defaults[tool]!;
  const size = $<HTMLInputElement>('annot-size');
  if (tool === 'ink' || tool === 'rect') size.value = '2';
  else if (tool === 'stamp') size.value = '24';
  else if (tool === 'text') size.value = '14';
  if (tool === 'image' && !state.pendingImage) $<HTMLInputElement>('file-annot-image').click();
}

// ---------------------------------------------------------------- viewer

let observer: IntersectionObserver | null = null;

async function renderViewer(keepScroll: boolean) {
  const pdf = state.pdf!;
  const gen = ++state.renderGen;
  const viewer = $('viewer');
  const ratio = keepScroll && viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
  observer?.disconnect();
  const first = await pdf.getPage(1);
  if (state.fit) {
    const w = (viewer.clientWidth || 900) - 64;
    state.scale = Math.min(3, Math.max(0.3, w / first.getViewport({ scale: 1 }).width));
  }
  const frag = document.createDocumentFragment();
  const pages: PageView[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = i === 1 ? first : await pdf.getPage(i);
    if (gen !== state.renderGen) return;
    const viewport = page.getViewport({ scale: state.scale });
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = String(i - 1);
    el.style.width = `${viewport.width}px`;
    el.style.height = `${viewport.height}px`;
    const canvas = document.createElement('canvas');
    const svg = svgEl('svg', { width: viewport.width, height: viewport.height, class: 'overlay' });
    svg.addEventListener('pointerdown', (e) => onPointerDown(e, i - 1));
    el.append(canvas, svg);
    frag.append(el);
    pages.push({ el, canvas, svg, viewport, rendered: false });
  }
  viewer.replaceChildren(frag);
  state.pages = pages;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const idx = Number((e.target as HTMLElement).dataset.page);
        void renderPage(idx, gen);
      }
    },
    { root: viewer, rootMargin: '600px 0px' },
  );
  pages.forEach((p) => observer!.observe(p.el));
  redrawAllAnnots();
  viewer.scrollTop = ratio * viewer.scrollHeight;
  updateChrome();
}

async function renderPage(idx: number, gen: number) {
  const pv = state.pages[idx];
  if (!pv || pv.rendered) return;
  pv.rendered = true;
  const page = await state.pdf!.getPage(idx + 1);
  if (gen !== state.renderGen) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { width, height } = pv.viewport;
  pv.canvas.width = Math.floor(width * dpr);
  pv.canvas.height = Math.floor(height * dpr);
  pv.canvas.style.width = `${width}px`;
  pv.canvas.style.height = `${height}px`;
  const ctx = pv.canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport: pv.viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
  if (gen === state.renderGen) pv.el.dataset.rendered = '1';
}

function zoom(factor: number | 'fit') {
  if (!state.pdf) return;
  if (factor === 'fit') state.fit = true;
  else {
    state.fit = false;
    state.scale = Math.min(5, Math.max(0.25, state.scale * factor));
  }
  void renderViewer(true);
}

function scrollToPage(idx: number) {
  const pv = state.pages[idx];
  if (!pv) return;
  if (state.mode === 'organize') setMode('read');
  $('viewer').scrollTo({ top: pv.el.offsetTop - 16 });
  state.currentPage = idx;
  updateChrome();
}

function trackCurrentPage() {
  const viewer = $('viewer');
  const probe = viewer.scrollTop + viewer.clientHeight / 3;
  let idx = 0;
  for (let i = 0; i < state.pages.length; i++) {
    if (state.pages[i].el.offsetTop <= probe) idx = i;
    else break;
  }
  if (idx !== state.currentPage) {
    state.currentPage = idx;
    updateChrome();
    document.querySelector('.thumb.active')?.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------- annotations overlay

const measureCtx = document.createElement('canvas').getContext('2d')!;
function textWidthPt(text: string, size: number, bold: boolean) {
  measureCtx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

function viewRect(vp: PageViewport, r: ops.Rect) {
  const [x1, y1] = vp.convertToViewportPoint(r[0], r[1]);
  const [x2, y2] = vp.convertToViewportPoint(r[2], r[3]);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

function annotNode(a: Annot, vp: PageViewport): SVGElement {
  const s = state.scale;
  const g = svgEl('g', { class: `annot annot-${a.type}`, 'data-id': a.id });
  switch (a.type) {
    case 'highlight':
      g.append(svgEl('rect', { ...viewRect(vp, a.rect), fill: a.color, 'fill-opacity': a.opacity ?? 0.35 }));
      break;
    case 'rect':
      g.append(svgEl('rect', { ...viewRect(vp, a.rect), fill: 'transparent', stroke: a.color, 'stroke-width': (a.width ?? 2) * s }));
      break;
    case 'whiteout':
      g.append(svgEl('rect', { ...viewRect(vp, a.rect), fill: '#fff', stroke: '#9e9e9e', 'stroke-dasharray': '4 3' }));
      break;
    case 'ink': {
      const pts = a.points.map(([x, y]) => vp.convertToViewportPoint(x, y).join(',')).join(' ');
      g.append(svgEl('polyline', { points: pts, fill: 'none', stroke: a.color, 'stroke-width': (a.width ?? 2) * s, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      break;
    }
    case 'text': {
      const [x, y] = vp.convertToViewportPoint(a.x, a.y);
      const txt = svgEl('text', { x, y, fill: a.color, 'font-size': a.size * s, 'font-family': 'Helvetica, Arial, sans-serif' });
      a.text.split('\n').forEach((line, i) => {
        const span = svgEl('tspan', { x, dy: i === 0 ? 0 : a.size * 1.2 * s });
        span.textContent = line || ' ';
        txt.append(span);
      });
      g.append(txt);
      break;
    }
    case 'stamp': {
      const [x, y] = vp.convertToViewportPoint(a.x, a.y);
      const pad = a.size * 0.4 * s;
      const w = textWidthPt(a.text, a.size, true) * s;
      g.append(
        svgEl('rect', { x: x - pad, y: y - a.size * s, width: w + 2 * pad, height: a.size * s + pad, fill: 'transparent', stroke: a.color, 'stroke-width': Math.max(1.5, a.size / 10) * s, rx: 2 }),
      );
      const txt = svgEl('text', { x, y, fill: a.color, 'font-size': a.size * s, 'font-weight': 'bold', 'font-family': 'Helvetica, Arial, sans-serif' });
      txt.textContent = a.text;
      g.append(txt);
      break;
    }
    case 'note': {
      const [x, y] = vp.convertToViewportPoint(a.x, a.y);
      const size = 20 * s;
      g.append(svgEl('rect', { x, y, width: size, height: size, rx: 3 * s, fill: a.color, stroke: '#00000055' }));
      g.append(svgEl('path', { d: `M${x + 5 * s} ${y + 7 * s}h${10 * s}M${x + 5 * s} ${y + 10 * s}h${10 * s}M${x + 5 * s} ${y + 13 * s}h${6 * s}`, stroke: '#333', 'stroke-width': 1.2 * s }));
      const title = svgEl('title');
      title.textContent = a.text;
      g.append(title);
      break;
    }
    case 'image': {
      let url = imageUrls.get(a.id);
      if (!url) {
        url = URL.createObjectURL(new Blob([a.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
        imageUrls.set(a.id, url);
      }
      g.append(svgEl('image', { ...viewRect(vp, a.rect), href: url, preserveAspectRatio: 'none' }));
      break;
    }
  }
  return g;
}

function redrawAnnots(page: number) {
  const pv = state.pages[page];
  if (!pv) return;
  pv.svg.querySelectorAll('.annot').forEach((n) => n.remove());
  for (const a of state.annots) if (a.page === page) pv.svg.append(annotNode(a, pv.viewport));
}

function redrawAllAnnots() {
  state.pages.forEach((_, i) => redrawAnnots(i));
}

function addAnnot(a: ops.Annotation) {
  pushHistory();
  state.annots = [...state.annots, { ...a, id: uid() } as Annot];
  redrawAnnots(a.page);
  updateChrome();
}

function removeAnnot(id: string) {
  const a = state.annots.find((x) => x.id === id);
  if (!a) return;
  pushHistory();
  state.annots = state.annots.filter((x) => x.id !== id);
  redrawAnnots(a.page);
  updateChrome();
}

async function onPointerDown(e: PointerEvent, page: number) {
  if (state.mode !== 'comment' || state.tool === 'none' || e.button !== 0) return;
  const pv = state.pages[page];
  const vp = pv.viewport;
  const box = pv.svg.getBoundingClientRect();
  const local = (ev: PointerEvent): [number, number] => [ev.clientX - box.left, ev.clientY - box.top];
  const toPdf = (p: [number, number]) => vp.convertToPdfPoint(p[0], p[1]) as [number, number];
  const color = $<HTMLInputElement>('annot-color').value;
  const size = Math.max(1, Number($<HTMLInputElement>('annot-size').value) || 12);
  const start = local(e);
  e.preventDefault();

  if (state.tool === 'eraser') {
    const target = (e.target as Element).closest<SVGElement>('.annot');
    if (target?.dataset.id) removeAnnot(target.dataset.id);
    return;
  }

  if (state.tool === 'text' || state.tool === 'note' || state.tool === 'stamp') {
    const tool = state.tool;
    const prompt = tool === 'text' ? t('askText') : tool === 'note' ? t('askNote') : t('askStamp');
    const text = await askText(prompt, tool === 'stamp' ? t('stampDefault') : '');
    if (!text) return;
    const s = state.scale;
    if (tool === 'note') {
      const [x, y] = toPdf(start);
      addAnnot({ type: 'note', page, x, y, text, color });
    } else {
      const [x, y] = toPdf([start[0] + (tool === 'stamp' ? size * 0.4 * s : 0), start[1] + size * s * (tool === 'stamp' ? 1 : 0.95)]);
      addAnnot({ type: tool, page, x, y, text, size, color });
    }
    return;
  }

  pv.svg.setPointerCapture(e.pointerId);
  let preview: SVGElement;
  const points: [number, number][] = [start];
  if (state.tool === 'ink') {
    preview = svgEl('polyline', { fill: 'none', stroke: color, 'stroke-width': size * state.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', points: start.join(',') });
  } else {
    preview = svgEl('rect', { class: 'preview', x: start[0], y: start[1], width: 0, height: 0 });
  }
  pv.svg.append(preview);
  let last = start;
  const move = (ev: PointerEvent) => {
    last = local(ev);
    if (state.tool === 'ink') {
      points.push(last);
      preview.setAttribute('points', points.map((p) => p.join(',')).join(' '));
    } else {
      preview.setAttribute('x', String(Math.min(start[0], last[0])));
      preview.setAttribute('y', String(Math.min(start[1], last[1])));
      preview.setAttribute('width', String(Math.abs(last[0] - start[0])));
      preview.setAttribute('height', String(Math.abs(last[1] - start[1])));
    }
  };
  const up = () => {
    pv.svg.removeEventListener('pointermove', move);
    pv.svg.removeEventListener('pointerup', up);
    pv.svg.removeEventListener('pointercancel', up);
    preview.remove();
    const tool = state.tool;
    const small = Math.abs(last[0] - start[0]) < 4 && Math.abs(last[1] - start[1]) < 4;
    if (tool === 'ink') {
      addAnnot({ type: 'ink', page, points: points.map(toPdf), color, width: size });
      return;
    }
    if (tool === 'image') {
      const img = state.pendingImage;
      if (!img) return;
      let end = last;
      if (small) {
        const w = Math.min(200 * state.scale, img.width);
        end = [start[0] + w, start[1] + (w * img.height) / img.width];
      }
      addAnnot({ type: 'image', page, rect: [...toPdf(start), ...toPdf(end)], png: img.png });
      return;
    }
    if (small) return;
    const rect: ops.Rect = [...toPdf(start), ...toPdf(last)];
    if (tool === 'highlight') addAnnot({ type: 'highlight', page, rect, color });
    else if (tool === 'rect') addAnnot({ type: 'rect', page, rect, color, width: size });
    else if (tool === 'whiteout') addAnnot({ type: 'whiteout', page, rect });
  };
  pv.svg.addEventListener('pointermove', move);
  pv.svg.addEventListener('pointerup', up);
  pv.svg.addEventListener('pointercancel', up);
}

// ---------------------------------------------------------------- thumbnails

const thumbCache = new Map<number, Promise<string>>();

function thumb(idx: number): Promise<string> {
  let p = thumbCache.get(idx);
  if (!p) {
    const gen = state.docGen;
    p = (async () => {
      const page = await state.pdf!.getPage(idx + 1);
      const vp = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 220 / Math.max(vp.width, vp.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      if (gen !== state.docGen) return '';
      return canvas.toDataURL('image/png');
    })();
    thumbCache.set(idx, p);
  }
  return p;
}

function renderThumbs() {
  const box = $('thumbs');
  box.replaceChildren();
  const n = state.pdf?.numPages ?? 0;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        io.unobserve(el);
        void thumb(Number(el.dataset.page)).then((url) => url && (el.querySelector('img')!.src = url));
      }
    },
    { root: box, rootMargin: '300px 0px' },
  );
  for (let i = 0; i < n; i++) {
    const el = document.createElement('button');
    el.className = 'thumb';
    el.dataset.page = String(i);
    el.innerHTML = `<img alt="" /><span>${i + 1}</span>`;
    el.addEventListener('click', () => scrollToPage(i));
    box.append(el);
    io.observe(el);
  }
}

// ---------------------------------------------------------------- organizer

let orgKey = 1;
function buildPlan() {
  const n = state.pdf?.numPages ?? 0;
  state.plan = [...Array(n).keys()].map((source) => ({ key: orgKey++, kind: 'page', source, rotate: 0 }));
}

function renderOrganizer() {
  const box = $('organizer');
  box.replaceChildren();
  let dragFrom = -1;
  state.plan.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'org-card';
    card.draggable = true;
    card.dataset.index = String(i);
    const preview = document.createElement('div');
    preview.className = 'org-preview';
    if (item.kind === 'page') {
      const img = document.createElement('img');
      img.alt = '';
      img.style.transform = `rotate(${item.rotate ?? 0}deg)`;
      void thumb(item.source).then((url) => url && (img.src = url));
      preview.append(img);
    } else {
      preview.innerHTML = `<div class="blank">${t('blankPage')}</div>`;
    }
    const label = document.createElement('div');
    label.className = 'org-label';
    label.textContent = item.kind === 'page' ? `${i + 1} (p.${item.source + 1})` : `${i + 1}`;
    const actions = document.createElement('div');
    actions.className = 'org-actions';
    const act = (cls: string, title: string, text: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = `btn icon ${cls}`;
      b.title = title;
      b.textContent = text;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
        renderOrganizer();
      });
      actions.append(b);
    };
    if (item.kind === 'page') {
      act('rot-left', t('rotateLeft'), '↺', () => (item.rotate = ((item.rotate ?? 0) + 270) % 360));
      act('rot-right', t('rotateRight'), '↻', () => (item.rotate = ((item.rotate ?? 0) + 90) % 360));
    }
    act('insert-blank', t('insertBlank'), '+', () => state.plan.splice(i + 1, 0, { key: orgKey++, kind: 'blank' }));
    act('remove', t('remove'), '×', () => state.plan.splice(i, 1));
    card.append(preview, label, actions);
    card.addEventListener('dragstart', (e) => {
      dragFrom = i;
      card.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', String(i));
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = dragFrom >= 0 ? dragFrom : Number(e.dataTransfer!.getData('text/plain'));
      if (from === i || Number.isNaN(from)) return;
      const [moved] = state.plan.splice(from, 1);
      state.plan.splice(i, 0, moved);
      renderOrganizer();
    });
    box.append(card);
  });
}

// ---------------------------------------------------------------- tools

async function filesToBytes(list: FileList | File[]): Promise<Uint8Array[]> {
  return Promise.all([...list].map(readFile));
}

async function imagesFromFiles(files: File[]): Promise<ops.ImageInput[]> {
  const out: ops.ImageInput[] = [];
  for (const f of files) {
    if (f.type === 'image/jpeg') out.push({ bytes: await readFile(f), type: 'jpg' });
    else if (f.type === 'image/png') out.push({ bytes: await readFile(f), type: 'png' });
    else out.push({ bytes: (await imageFileToPng(f)).png, type: 'png' });
  }
  return out;
}

async function openImagesAsPdf(files: File[]) {
  if (!files.length) return;
  try {
    await busy(async () => openNew(await ops.imagesToPdf(await imagesFromFiles(files), 'a4'), 'images.pdf'));
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

async function openFiles(files: File[]) {
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (pdfs.length === 0 && images.length) return openImagesAsPdf(images);
  if (pdfs.length === 0) return;
  if (!confirmDiscard()) return;
  try {
    await busy(async () => {
      const bytes = await filesToBytes(pdfs);
      if (bytes.length === 1) await openNew(bytes[0], pdfs[0].name);
      else await openNew(await ops.merge(bytes), 'merged.pdf');
    });
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

function confirmDiscard(): boolean {
  if (!state.pdf || (state.history.length === 0 && state.annots.length === 0)) return true;
  return window.confirm(t('discardChanges'));
}

function rangeOrAll(expr: string): number[] {
  const n = state.pdf!.numPages;
  return expr.trim() ? ops.parsePageRange(expr, n) : [...Array(n).keys()];
}

async function exportImages(type: 'png' | 'jpg') {
  const expr = $<HTMLInputElement>('img-range').value;
  await runExport(async (bytes) => {
    const indices = rangeOrAll(expr);
    const doc = await loadPdf(bytes);
    try {
      for (const i of indices) {
        const page = await doc.getPage(i + 1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const out = await canvasToBytes(canvas, type === 'png' ? 'image/png' : 'image/jpeg', 0.92);
        download(out, `${stem()}-p${i + 1}.${type}`, type === 'png' ? 'image/png' : 'image/jpeg');
      }
    } finally {
      await doc.destroy();
    }
    toast(t('exported', { n: indices.length }));
  });
}

async function getTexts(): Promise<string[]> {
  state.texts ??= await extractPageTexts(state.pdf!);
  return state.texts;
}

async function fillMetadata() {
  if (!state.bytes) return;
  try {
    const m = await ops.getMetadata(state.bytes);
    $<HTMLInputElement>('meta-title').value = m.title ?? '';
    $<HTMLInputElement>('meta-author').value = m.author ?? '';
    $<HTMLInputElement>('meta-subject').value = m.subject ?? '';
    $<HTMLInputElement>('meta-keywords').value = (m.keywords ?? []).join(', ');
  } catch {
    /* metadata is optional */
  }
}

// ---------------------------------------------------------------- search

let searchTimer = 0;
async function runSearch() {
  const q = $<HTMLInputElement>('search-input').value;
  setMode(state.mode, true);
  if (!state.pdf || !q.trim()) return;
  const hits = searchTexts(await getTexts(), q);
  const box = $('search-results');
  box.replaceChildren();
  $('search-count').textContent = String(hits.length);
  if (!hits.length) {
    box.innerHTML = `<p class="hint">${t('noResults')}</p>`;
    return;
  }
  for (const h of hits) {
    const el = document.createElement('button');
    el.className = 'hit';
    const page = document.createElement('b');
    page.textContent = `p.${h.page + 1}`;
    const snip = document.createElement('span');
    const lower = h.snippet.toLocaleLowerCase();
    const at = lower.indexOf(q.trim().toLocaleLowerCase());
    if (at >= 0) {
      const mark = document.createElement('mark');
      mark.textContent = h.snippet.slice(at, at + q.trim().length);
      snip.append(h.snippet.slice(0, at), mark, h.snippet.slice(at + q.trim().length));
    } else snip.textContent = h.snippet;
    el.append(page, snip);
    el.addEventListener('click', () => {
      scrollToPage(h.page);
      const pv = state.pages[h.page];
      pv?.el.classList.remove('flash');
      void pv?.el.offsetWidth;
      pv?.el.classList.add('flash');
    });
    box.append(el);
  }
}

// ---------------------------------------------------------------- sample

async function makeSample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('vPDF sample');
  doc.setAuthor('vPDF');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const lorem =
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante venenatis dapibus. Donec ullamcorper nulla non metus auctor fringilla. Vestibulum id ligula porta felis euismod semper.';
  const colors = [rgb(0.49, 0.3, 1), rgb(0.12, 0.6, 0.5), rgb(0.95, 0.45, 0.2)];
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage(ops.A4);
    const { width, height } = page.getSize();
    page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: colors[p] });
    page.drawText(`Chapter ${p + 1}`, { x: 50, y: height - 58, size: 28, font: bold, color: rgb(1, 1, 1) });
    let y = height - 140;
    for (let para = 0; para < 6; para++) {
      const words = `${para === 1 ? 'Important: vPDF can search this sentence. ' : ''}${lorem}`.split(' ');
      let line = '';
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(next, 12) > width - 100) {
          page.drawText(line, { x: 50, y, size: 12, font, color: rgb(0.15, 0.15, 0.15) });
          y -= 18;
          line = w;
        } else line = next;
      }
      page.drawText(line, { x: 50, y, size: 12, font, color: rgb(0.15, 0.15, 0.15) });
      y -= 32;
    }
    page.drawRectangle({ x: 50, y: 80, width: width - 100, height: 120, borderColor: colors[p], borderWidth: 1.5 });
    page.drawText(`Figure ${p + 1}`, { x: 60, y: 180, size: 11, font: bold, color: colors[p] });
  }
  return doc.save();
}

// ---------------------------------------------------------------- wiring

function wire() {
  const fileInput = $<HTMLInputElement>('file-pdf');
  const mergeInput = $<HTMLInputElement>('file-merge');
  const imagesInput = $<HTMLInputElement>('file-images');
  const annotImageInput = $<HTMLInputElement>('file-annot-image');
  let mergeAsNew = false;

  const openDialog = () => fileInput.click();
  $('btn-open').addEventListener('click', openDialog);
  $('welcome-open').addEventListener('click', openDialog);
  fileInput.addEventListener('change', () => {
    void openFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });
  $('welcome-sample').addEventListener('click', async () => {
    await busy(async () => openNew(await makeSample(), 'vpdf-sample.pdf'));
  });
  $('welcome-images').addEventListener('click', () => imagesInput.click());
  $('tool-from-images').addEventListener('click', () => imagesInput.click());
  imagesInput.addEventListener('change', () => {
    const files = [...(imagesInput.files ?? [])];
    imagesInput.value = '';
    if (confirmDiscard()) void openImagesAsPdf(files);
  });
  $('welcome-merge').addEventListener('click', () => {
    mergeAsNew = true;
    mergeInput.click();
  });
  $('tool-merge').addEventListener('click', () => {
    mergeAsNew = false;
    mergeInput.click();
  });
  mergeInput.addEventListener('change', async () => {
    const files = [...(mergeInput.files ?? [])];
    mergeInput.value = '';
    if (!files.length) return;
    if (mergeAsNew || !state.pdf) return openFiles(files);
    const extra = await filesToBytes(files);
    await runOp((b) => ops.merge([b, ...extra]), t('merged', { n: files.length + 1 }));
  });

  $('btn-save').addEventListener('click', () => void save());
  $('btn-undo').addEventListener('click', () => void undo());
  $('btn-redo').addEventListener('click', () => void redo());
  $('btn-zoom-in').addEventListener('click', () => zoom(1.2));
  $('btn-zoom-out').addEventListener('click', () => zoom(1 / 1.2));
  $('btn-zoom-label').addEventListener('click', () => zoom('fit'));
  $('btn-prev').addEventListener('click', () => scrollToPage(Math.max(0, state.currentPage - 1)));
  $('btn-next').addEventListener('click', () => scrollToPage(Math.min((state.pdf?.numPages ?? 1) - 1, state.currentPage + 1)));
  $<HTMLInputElement>('page-input').addEventListener('change', (e) => {
    const n = parseInt((e.target as HTMLInputElement).value, 10);
    if (n >= 1 && n <= (state.pdf?.numPages ?? 0)) scrollToPage(n - 1);
    else updateChrome();
  });
  $('viewer').addEventListener('scroll', trackCurrentPage, { passive: true });
  $('btn-lang').addEventListener('click', () => {
    setLang(getLang() === 'ko' ? 'en' : 'ko');
    updateChrome();
    if (state.mode === 'organize') renderOrganizer();
  });

  document.querySelectorAll<HTMLElement>('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));
  document.querySelectorAll<HTMLElement>('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
  annotImageInput.addEventListener('change', async () => {
    const f = annotImageInput.files?.[0];
    annotImageInput.value = '';
    if (!f) {
      if (!state.pendingImage) setTool('none');
      return;
    }
    const img = await imageFileToPng(f);
    if (state.pendingImage) URL.revokeObjectURL(state.pendingImage.url);
    state.pendingImage = { ...img, url: URL.createObjectURL(f) };
  });
  $('btn-apply-annots').addEventListener('click', () => void runOp(async (b) => b, t('annotsApplied')));

  $('org-reset').addEventListener('click', () => {
    buildPlan();
    renderOrganizer();
  });
  $('org-apply').addEventListener('click', () => {
    const plan = state.plan.map(({ key: _key, ...item }) => item as ops.PagePlanItem);
    void runOp((b) => ops.organize(b, plan));
  });

  $('tool-split').addEventListener('click', () =>
    runExport(async (b) => {
      const parts = await ops.splitEvery(b, parseInt($<HTMLInputElement>('split-n').value, 10));
      parts.forEach((p, i) => download(p, `${stem()}-part${i + 1}.pdf`));
      toast(t('splitDone', { n: parts.length }));
    }),
  );
  $('tool-extract').addEventListener('click', () =>
    runExport(async (b) => {
      const idx = ops.parsePageRange($<HTMLInputElement>('extract-range').value, state.pdf!.numPages);
      download(await ops.extractPages(b, idx), `${stem()}-extract.pdf`);
      toast(t('exported', { n: 1 }));
    }),
  );
  $('tool-delete-range').addEventListener('click', () => {
    const expr = $<HTMLInputElement>('extract-range').value;
    void runOp((b) => ops.deletePages(b, ops.parsePageRange(expr, state.pdf!.numPages)));
  });
  $('tool-watermark').addEventListener('click', async () => {
    const text = $<HTMLInputElement>('wm-text').value.trim();
    const color = $<HTMLInputElement>('wm-color').value;
    const opacity = Number($<HTMLInputElement>('wm-opacity').value);
    void runOp(async (b) =>
      ops.isWinAnsiEncodable(text)
        ? ops.addWatermark(b, { text, color, opacity })
        : ops.addWatermark(b, { png: await rasterizeWatermark(text, color), opacity }),
    );
  });
  $('tool-page-numbers').addEventListener('click', () => {
    const format = $<HTMLInputElement>('pn-format').value || '{n}';
    const position = $<HTMLSelectElement>('pn-position').value as ops.PageNumberOptions['position'];
    void runOp((b) => ops.addPageNumbers(b, { format, position }));
  });
  $('tool-to-png').addEventListener('click', () => void exportImages('png'));
  $('tool-to-jpg').addEventListener('click', () => void exportImages('jpg'));
  $('tool-to-txt').addEventListener('click', () =>
    runExport(async () => {
      download(textsToTxt(await getTexts()), `${stem()}.txt`, 'text/plain;charset=utf-8');
      toast(t('exported', { n: 1 }));
    }),
  );
  $('tool-metadata').addEventListener('click', () => {
    const v = (id: string) => $<HTMLInputElement>(id).value;
    void runOp((b) =>
      ops.setMetadata(b, {
        title: v('meta-title'),
        author: v('meta-author'),
        subject: v('meta-subject'),
        keywords: v('meta-keywords').split(',').map((s) => s.trim()).filter(Boolean),
      }),
    );
  });
  $('tool-optimize').addEventListener('click', async () => {
    const before = (await flattenedBytes()).length;
    let after = 0;
    await runOp(async (b) => {
      const out = await ops.optimize(b);
      after = out.length;
      return out;
    }, '');
    if (after) toast(t('optimized', { before: formatBytes(before), after: formatBytes(after) }));
  });

  $('search-input').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 200);
  });

  // Drag & drop files anywhere.
  let dragDepth = 0;
  const overlay = $('drop-overlay');
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) overlay.classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add('hidden');
    void openFiles([...(e.dataTransfer?.files ?? [])]);
  });

  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).closest('input, textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openDialog();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void save();
    } else if (mod && e.key.toLowerCase() === 'f' && state.pdf) {
      e.preventDefault();
      $('search-input').focus();
    } else if (typing) {
      return;
    } else if (mod && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      void redo();
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void undo();
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoom(1.2);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      zoom(1 / 1.2);
    } else if (e.key === 'Escape') {
      setTool('none');
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    if (!state.pdf || !state.fit) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => void renderViewer(true), 150);
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.annots.length || state.history.length) e.preventDefault();
  });
}

applyI18n();
setLang(getLang());
wire();
updateChrome();
setMode('read', true);

declare global {
  interface Window {
    vpdf: { state: typeof state; openNew: typeof openNew };
  }
}
window.vpdf = { state, openNew };
