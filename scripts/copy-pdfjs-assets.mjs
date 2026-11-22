// Copies pdf.js CMaps (needed for CJK fonts such as Korean) and standard font data into public/.
import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
for (const dir of ['cmaps', 'standard_fonts']) {
  mkdirSync('public/pdfjs', { recursive: true });
  cpSync(join(root, dir), join('public/pdfjs', dir), { recursive: true });
}
