// web/public/favicon.svg → desktop/build/icon.png (512px). electron-builder 가 여기서 .ico 를 만든다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = fs.readFileSync(path.join(here, '..', '..', 'web', 'public', 'favicon.svg'));
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng();
fs.mkdirSync(path.join(here, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(here, '..', 'build', 'icon.png'), png);
console.log(`icon.png ${png.length} bytes`);
