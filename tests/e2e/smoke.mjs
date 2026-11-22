// End-to-end smoke test: drives the real UI in headless Chrome and verifies the saved PDF.
// Usage: npm run test:e2e   (CHROME_PATH overrides the browser; SCREENSHOT_DIR saves screenshots)
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { PDFDocument, PDFName, PDFArray } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const CHROME = process.env.CHROME_PATH || ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const SHOTS = process.env.SCREENSHOT_DIR;
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

async function texts(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    out.push(c.items.map((it) => it.str ?? '').join(' '));
  }
  await doc.destroy();
  return out;
}

const server = await createServer({ server: { port: 5199, strictPort: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 }, locale: 'ko-KR' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
if (SHOTS) await mkdir(SHOTS, { recursive: true });
const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
const step = (s) => console.log(`- ${s}`);
const pending = () => page.locator('#pending-count').innerText();

async function catchDownload(trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download'), trigger()]);
  return { name: dl.suggestedFilename(), bytes: await readFile(await dl.path()) };
}

async function dragOn(pageIdx, x1, y1, x2, y2) {
  const box = await page.locator(`.page[data-page="${pageIdx}"] .overlay`).boundingBox();
  await page.mouse.move(box.x + x1, box.y + y1);
  await page.mouse.down();
  await page.mouse.move(box.x + (x1 + x2) / 2, box.y + (y1 + y2) / 2, { steps: 4 });
  await page.mouse.move(box.x + x2, box.y + y2, { steps: 4 });
  await page.mouse.up();
}

async function clickWithText(pageIdx, x, y, text) {
  const box = await page.locator(`.page[data-page="${pageIdx}"] .overlay`).boundingBox();
  await page.mouse.click(box.x + x, box.y + y);
  await page.locator('#modal-input').fill(text);
  await page.locator('#modal-ok').click();
}

try {
  await page.goto(url);
  step('welcome screen (Korean UI by default for ko locale)');
  assert.equal(await page.locator('#welcome-open').innerText(), 'PDF 열기');
  await shot('01-welcome');

  step('open sample document');
  await page.locator('#welcome-sample').click();
  await page.locator('.page[data-page="0"][data-rendered="1"]').waitFor();
  assert.equal(await page.locator('#page-total').innerText(), '3');
  await page.locator('.thumb img[src^="data:"]').first().waitFor();
  await shot('02-reader');

  step('zoom and navigate');
  const z0 = await page.locator('#btn-zoom-label').innerText();
  await page.locator('#btn-zoom-in').click();
  await page.waitForFunction((z) => document.querySelector('#btn-zoom-label').textContent !== z, z0);
  await page.locator('#btn-zoom-label').click();
  await page.locator('.page[data-page="0"][data-rendered="1"]').waitFor();
  await page.locator('#btn-next').click();
  assert.equal(await page.locator('#page-input').inputValue(), '2');

  step('search');
  await page.locator('#search-input').fill('important');
  await page.locator('.hit').first().waitFor();
  assert.equal(await page.locator('.hit').count(), 3);
  await shot('03-search');
  await page.locator('#search-input').fill('');

  step('annotate: highlight, box, pen, text, note, Korean stamp, whiteout');
  await page.locator('.mode[data-mode="comment"]').click();
  await page.locator('#viewer').evaluate((v) => v.scrollTo(0, 0));
  await page.locator('.tool[data-tool="highlight"]').click();
  await dragOn(0, 60, 150, 400, 175);
  await page.locator('.tool[data-tool="rect"]').click();
  await dragOn(0, 60, 600, 300, 700);
  await page.locator('.tool[data-tool="ink"]').click();
  await dragOn(0, 400, 600, 600, 700);
  await page.locator('.tool[data-tool="text"]').click();
  await clickWithText(0, 450, 140, 'Hello vPDF');
  await page.locator('.tool[data-tool="note"]').click();
  await clickWithText(0, 700, 20, '검토해 주세요');
  await page.locator('.tool[data-tool="stamp"]').click();
  await clickWithText(0, 500, 720, '승인');
  await page.locator('.tool[data-tool="whiteout"]').click();
  await dragOn(0, 650, 250, 800, 280);
  assert.equal(await pending(), '대기 중 7개');
  await shot('04-comment');

  step('eraser + undo/redo');
  await page.locator('.tool[data-tool="eraser"]').click();
  await page.locator('.annot-whiteout rect').click();
  assert.equal(await pending(), '대기 중 6개');
  await page.keyboard.press('Control+z');
  assert.equal(await pending(), '대기 중 7개');
  await page.keyboard.press('Control+y');
  assert.equal(await pending(), '대기 중 6개');

  step('apply annotations');
  await page.locator('#btn-apply-annots').click();
  await page.waitForFunction(() => document.querySelector('#pending-count').textContent === '' && document.querySelector('.page[data-rendered="1"]'));

  step('organize: rotate p1, delete p3, insert blank after p1');
  await page.locator('.mode[data-mode="organize"]').click();
  await page.locator('.org-card').first().waitFor();
  await page.locator('.org-card').nth(0).locator('.rot-right').click();
  await page.locator('.org-card').nth(2).locator('.remove').click();
  await page.locator('.org-card').nth(0).locator('.insert-blank').click();
  assert.equal(await page.locator('.org-card').count(), 3);
  await page.locator('.org-card').nth(2).dragTo(page.locator('.org-card').nth(1));
  await shot('05-organize');
  await page.locator('#org-apply').click();
  await page.waitForFunction(() => document.querySelector('#page-total').textContent === '3' && window.vpdf.state.history.length >= 2);

  step('tools: watermark (Korean, rasterized), page numbers, metadata');
  await page.locator('.mode[data-mode="tools"]').click();
  await page.locator('summary', { hasText: '워터마크' }).click();
  await page.locator('#wm-text').fill('대외비 CONFIDENTIAL');
  await page.locator('#tool-watermark').click();
  await page.locator('.toast', { hasText: '완료' }).first().waitFor();
  await page.locator('summary', { hasText: '페이지 번호' }).click();
  await page.locator('#tool-page-numbers').click();
  await page.locator('summary', { hasText: '문서 속성' }).click();
  await page.locator('#meta-title').fill('vPDF 테스트');
  await page.locator('#tool-metadata').click();
  await page.waitForFunction(() => window.vpdf.state.history.length >= 5);
  await shot('06-tools');

  step('exports: txt, png, extract, split');
  await page.locator('summary', { hasText: '변환' }).click();
  const txt = await catchDownload(() => page.locator('#tool-to-txt').click());
  assert.match(txt.name, /\.txt$/);
  assert.match(txt.bytes.toString('utf8'), /===== Page 1 =====/);
  await page.locator('#img-range').fill('1');
  const png = await catchDownload(() => page.locator('#tool-to-png').click());
  assert.equal(png.name, 'vpdf-sample-p1.png');
  assert.equal(png.bytes.subarray(1, 4).toString(), 'PNG');
  await page.locator('summary', { hasText: '분할 / 추출' }).click();
  await page.locator('#extract-range').fill('2-3');
  const ext = await catchDownload(() => page.locator('#tool-extract').click());
  assert.equal((await PDFDocument.load(ext.bytes)).getPageCount(), 2);
  await page.locator('#split-n').fill('3');
  const split = await catchDownload(() => page.locator('#tool-split').click());
  assert.equal((await PDFDocument.load(split.bytes)).getPageCount(), 3);

  step('save and verify the output PDF');
  const saved = await catchDownload(() => page.locator('#btn-save').click());
  assert.equal(saved.name, 'vpdf-sample.pdf');
  const doc = await PDFDocument.load(saved.bytes);
  assert.equal(doc.getPageCount(), 3);
  assert.equal(doc.getTitle(), 'vPDF 테스트');
  assert.equal(doc.getPage(0).getRotation().angle, 90);
  const notes = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  assert.equal(notes.size(), 1);
  const t = await texts(saved.bytes);
  assert.match(t[0], /Hello vPDF/);
  assert.match(t[0], /Chapter 1/);
  assert.match(t[1], /Chapter 2/, 'dragged page 2 into second slot');
  assert.match(t[2].trim(), /^3 \/ 3$/, 'last page is the inserted blank with only a page number');
  assert.match(t[0], /1 \/ 3/);

  step('merge another PDF');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#tool-merge').click()]);
  await chooser.setFiles({ name: 'extra.pdf', mimeType: 'application/pdf', buffer: ext.bytes });
  await page.waitForFunction(() => document.querySelector('#page-total').textContent === '5');

  step('images to PDF');
  page.once('dialog', (d) => d.accept());
  const [imgChooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#tool-from-images').click()]);
  await imgChooser.setFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: PNG_1PX },
    { name: 'b.png', mimeType: 'image/png', buffer: PNG_1PX },
  ]);
  await page.waitForFunction(() => document.querySelector('#file-name').textContent === 'images.pdf');
  assert.equal(await page.locator('#page-total').innerText(), '2');

  step('switch language');
  await page.locator('#btn-lang').click();
  assert.equal(await page.locator('.mode[data-mode="organize"] span').innerText(), 'Organize');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('E2E OK');
} catch (e) {
  await shot('failure');
  console.error(e);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
}
