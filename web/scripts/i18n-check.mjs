// 번역 점검: node web/scripts/i18n-check.mjs [--files a.tsx,b.ts] [--keys] [--write-keys]
//   1) t()/tr()/tk() 밖에 남은 한국어 문자열 (파일:줄) — 번역 안 되는 곳
//   2) 사전(src/locales/*.json)에 없는 키, 더는 안 쓰는 키, {이름}·<태그> 가 원문과 다른 번역
//   --write-keys: 모든 키를 src/locales/_keys.json 에 (번역할 목록)
// 같은 줄에 i18n-ignore 가 있으면 그 줄의 한국어는 넘어간다 (정규식·일부러 한국어로 둔 것).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const src = path.join(webRoot, 'src');
const require = createRequire(path.join(webRoot, 'package.json'));
const { parseAst } = await import(pathToFileURL(require.resolve('rolldown/parseAst')).href);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt('--files')?.split(',').map((f) => path.resolve(f));
const HANGUL = /[가-힣]/;
const CALLS = new Set(['t', 'tr', 'tk']);

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'locales') walk(p);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p);
  }
};
walk(src);

const keys = new Map(); // key → 처음 쓴 곳
const leftovers = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const lineOf = (pos) => text.slice(0, pos).split('\n').length;
  let ast;
  try {
    ast = parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file);
  } catch (err) {
    console.error(`파싱 실패 ${file}: ${err.message}`);
    process.exitCode = 1;
    continue;
  }
  const rel = path.relative(webRoot, file).replaceAll('\\', '/');
  const consumed = new Set();
  const visit = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && CALLS.has(node.callee.name)) {
      const a = node.arguments?.[0];
      let key = null;
      if (a?.type === 'Literal' && typeof a.value === 'string') key = a.value;
      else if (a?.type === 'TemplateLiteral' && a.expressions.length === 0) key = a.quasis.map((q) => q.value.cooked).join('');
      if (key !== null) {
        consumed.add(a.start);
        if (!keys.has(key)) keys.set(key, `${rel}:${lineOf(a.start)}`);
      } else if (a && node.callee.name !== 'tk') {
        // t(변수) 는 tk() 로 표시한 키를 넘기는 경우만 괜찮다 — 여기서는 알 수 없으니 넘어간다
      }
    }
    // console.* 안의 한국어는 화면에 안 나온다
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && node.callee.object?.name === 'console') return;
    let hangul = null;
    if (node.type === 'Literal' && typeof node.value === 'string' && HANGUL.test(node.value)) hangul = node.value;
    else if (node.type === 'JSXText' && HANGUL.test(node.value)) hangul = node.value.trim();
    else if (node.type === 'TemplateLiteral' && node.quasis.some((q) => HANGUL.test(q.value.cooked ?? ''))) hangul = text.slice(node.start, node.end);
    if (hangul !== null && !consumed.has(node.start)) {
      const line = lineOf(node.start);
      if (!/i18n-ignore/.test(lines[line - 1] ?? '') && !(parent?.type === 'ImportDeclaration')) leftovers.push({ file: rel, line, text: hangul.replace(/\s+/g, ' ').slice(0, 90) });
    }
    for (const k of Object.keys(node)) {
      if (k === 'parent') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, node));
      else if (v && typeof v === 'object' && typeof v.type === 'string') visit(v, node);
    }
  };
  if (!only || only.includes(path.resolve(file))) visit(ast, null);
  else {
    // 다른 파일도 키는 모은다
    const collect = (node) => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && CALLS.has(node.callee.name)) {
        const a = node.arguments?.[0];
        if (a?.type === 'Literal' && typeof a.value === 'string' && !keys.has(a.value)) keys.set(a.value, rel);
      }
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === 'object' && typeof v.type === 'string') collect(v);
      }
    };
    collect(ast);
  }
}

console.log(`키 ${keys.size}개`);
if (leftovers.length) {
  console.log(`\n번역 함수 밖에 남은 한국어 ${leftovers.length}곳:`);
  for (const l of leftovers) console.log(`  ${l.file}:${l.line}  ${l.text}`);
  process.exitCode = 1;
} else console.log('번역 함수 밖에 남은 한국어 없음');

if (args.includes('--write-keys')) {
  fs.writeFileSync(path.join(src, 'locales', '_keys.json'), JSON.stringify([...keys.keys()].sort(), null, 1) + '\n');
  console.log('src/locales/_keys.json 에 썼습니다');
}

// 사전 점검
const marks = (s) => [...s.matchAll(/\{\w+\}|<\/?\w+>/g)].map((m) => m[0]).sort().join(' ');
for (const f of fs.readdirSync(path.join(src, 'locales')).filter((f) => /^[a-z]{2}\.json$/.test(f))) {
  const dict = JSON.parse(fs.readFileSync(path.join(src, 'locales', f), 'utf8'));
  const missing = [...keys.keys()].filter((k) => !(k in dict) || !String(dict[k]).trim());
  const stale = Object.keys(dict).filter((k) => !keys.has(k));
  const broken = Object.entries(dict).filter(([k, v]) => keys.has(k) && marks(k) !== marks(String(v)));
  console.log(`\n${f}: 번역 ${Object.keys(dict).length} · 없음 ${missing.length} · 안 쓰는 키 ${stale.length} · 자리표시 다름 ${broken.length}`);
  if (args.includes('--keys')) {
    for (const k of missing.slice(0, 50)) console.log(`  없음: ${k}`);
    for (const k of stale.slice(0, 20)) console.log(`  안 씀: ${k}`);
  }
  for (const [k, v] of broken.slice(0, 30)) console.log(`  자리표시 다름: ${k}  →  ${v}`);
  if (missing.length || broken.length) process.exitCode = 1;
}
