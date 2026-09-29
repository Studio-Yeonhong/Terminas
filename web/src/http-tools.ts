// HTTP 요청 도구의 계산 부분 (화면 없이 시험할 수 있게 따로): 변수 치환 · 쿼리 파라미터 · 보낼 요청 만들기 · curl 가져오기 ·
// 코드로 내보내기(curl·PowerShell·fetch·Python) · 쿠키 읽기 · JSON 색칠.
import type { HttpAuth, HttpBodyType, HttpEnvVar, HttpHeader } from './api';

export type RequestDraft = {
  label: string;
  collection: string;
  method: string;
  url: string;
  headers: HttpHeader[];
  offParams: HttpHeader[];
  bodyType: HttpBodyType;
  body: string;
  auth: HttpAuth;
  insecure: boolean;
  follow: boolean;
  timeout: number;
};

export const NO_AUTH: HttpAuth = { type: 'none', token: '', username: '', password: '', key: '', keyIn: 'header' };

// ---------- {{변수}} ----------
const VAR = /\{\{\s*([\w.-]+)\s*\}\}/g;
export function substitute(text: string, vars: HttpEnvVar[], missing?: Set<string>) {
  return text.replace(VAR, (m, name: string) => {
    const v = vars.find((x) => x.key === name);
    if (v) return v.value;
    missing?.add(name);
    return m;
  });
}
// 화면에 보여 줄 때: 가리기로 한 변수 값은 ●● 로
export function substituteMasked(text: string, vars: HttpEnvVar[], missing?: Set<string>) {
  return text.replace(VAR, (m, name: string) => {
    const v = vars.find((x) => x.key === name);
    if (v) return v.secret ? '●●●●' : v.value;
    missing?.add(name);
    return m;
  });
}
export const usesVars = (text: string) => /\{\{\s*[\w.-]+\s*\}\}/.test(text);
// 가리기로 한 변수를 쓰는지 (그런 헤더는 민감한 헤더로 본다)
const usesSecretVar = (text: string, vars: HttpEnvVar[]) => [...text.matchAll(VAR)].some((m) => vars.some((v) => v.key === m[1] && v.secret));

// ---------- 메서드 ----------
// 글자로 시작하는 HTTP 토큰만 (소문자는 대문자로). 붙여 넣은 curl·공유된 요청의 메서드가 코드로 내보낼 때 명령이 되지 않게 —
// 요청을 만들 때·curl 을 가져올 때·코드로 내보낼 때 모두 이 규칙을 거친다 (앱 본체 desktop/src/http.js 도 같은 규칙)
const METHOD = /^[A-Z][A-Z0-9_-]{0,19}$/;
export function normalizeMethod(method: string): string | null {
  const m = String(method ?? '').trim().toUpperCase();
  return METHOD.test(m) ? m : null;
}
function checkedMethod(method: string) {
  const m = normalizeMethod(method);
  if (!m) throw new Error('invalid HTTP method');
  return m;
}

// ---------- 쿼리 파라미터 (주소가 기준 — 표를 고치면 주소를 다시 쓴다) ----------
// 주소는 {{변수}} 를 품을 수 있어 URL 로 읽지 않고 글자 그대로 나눈다. 표에는 주소에 적힌 그대로(인코딩 풀지 않고) 보인다.
export function splitUrl(url: string) {
  const hashAt = url.indexOf('#');
  const noHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const q = noHash.indexOf('?');
  return { base: q < 0 ? noHash : noHash.slice(0, q), query: q < 0 ? null : noHash.slice(q + 1), hash };
}
export function queryParams(url: string): HttpHeader[] {
  const { query } = splitUrl(url);
  if (!query) return [];
  return query
    .split('&')
    .filter((part) => part !== '')
    .map((part) => {
      const i = part.indexOf('=');
      return { name: i < 0 ? part : part.slice(0, i), value: i < 0 ? '' : part.slice(i + 1), on: true };
    });
}
// 표에 적은 값: 쿼리를 깨뜨리는 글자(& # 과 이름의 =)만 바꾼다 — 나머지(공백·한글 등)는 보낼 때 인코딩된다
const escName = (s: string) => s.replace(/%(?![0-9A-Fa-f]{2})/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23').replace(/=/g, '%3D');
const escValue = (s: string) => s.replace(/%(?![0-9A-Fa-f]{2})/g, '%25').replace(/&/g, '%26').replace(/#/g, '%23');
export function withParams(url: string, params: HttpHeader[]) {
  const { base, hash } = splitUrl(url);
  const on = params.filter((p) => p.on && (p.name !== '' || p.value !== ''));
  if (!on.length) return base + hash;
  return `${base}?${on.map((p) => (p.value === '' && !p.name.includes('=') ? escName(p.name) : `${escName(p.name)}=${escValue(p.value)}`)).join('&')}${hash}`;
}

// ---------- 폼 본문 (x-www-form-urlencoded) ----------
// 저장은 한 줄에 이름=값. 한 줄뿐이면 curl 처럼 & 로 이은 것으로도 읽는다(값에 & 가 있으면 표가 끝에 줄바꿈을 붙여 둔다)
export function formRows(text: string): HttpHeader[] {
  const lines = text.includes('\n') ? text.split(/\r?\n/) : text.split('&');
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('=');
      return { name: i < 0 ? l : l.slice(0, i), value: i < 0 ? '' : l.slice(i + 1), on: true };
    });
}
export function formText(rows: HttpHeader[]) {
  const lines = rows.filter((r) => r.name !== '' || r.value !== '').map((r) => `${r.name}=${r.value}`);
  return lines.length === 1 ? `${lines[0]}\n` : lines.join('\n');
}
function formBody(text: string) {
  return new URLSearchParams(formRows(text).map((r) => [r.name, r.value])).toString();
}

const hasHeader = (headers: [string, string][], name: string) => headers.some(([n]) => n.toLowerCase() === name.toLowerCase());
const utf8Base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const CONTENT_TYPE: Record<Exclude<HttpBodyType, 'none'>, string> = {
  json: 'application/json',
  text: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  form: 'application/x-www-form-urlencoded',
};

// 앱이 알아서 붙이는 헤더 (사람이 같은 이름을 넣으면 그쪽을 쓴다) — 서버가 User-Agent 없는 요청을 막는 일이 흔하다
export const defaultHeaders = (appVersion: string): [string, string][] => [
  ['User-Agent', `Terminas/${appVersion}`],
  ['Accept', '*/*'],
  ['Accept-Encoding', 'gzip, deflate, br'],
];

// 이름만 봐도 인증 정보인 헤더 (API 키·토큰·세션 등)
const SECRET_NAME = /(auth|key|token|secret|passw|session|credential|signature|cookie)/i;

// 화면의 요청 → 앱 본체로 보낼 것 (변수를 채우고 인증·Content-Type 헤더를 붙인다).
// headers = 사람이 넣은 것 + 인증·본문에서 나온 것, auto = 앱 기본 헤더(보낼 때만 붙이고, 코드로 내보낼 때는 뺀다)
// method = 규칙에 맞는 대문자 메서드, 맞지 않으면 '' (보내기·코드로 내보내기 전에 막는다)
// sensitive = 민감한 헤더 이름 (인증 탭이 만든 것 · 가린 변수를 쓰는 것 · 이름이 키·토큰 같은 것) — 앱 본체가 다른 사이트로
// 넘어가는 리다이렉트에서 떼어 내고, 이런 헤더가 있으면 https → http 리다이렉트는 따라가지 않는다
export function buildRequest(d: RequestDraft, vars: HttpEnvVar[], appVersion?: string) {
  const missing = new Set<string>();
  const sub = (s: string) => substitute(s, vars, missing);
  let url = sub(d.url.trim());
  const sensitive = new Set<string>();
  const mine = d.headers.filter((h) => h.on && h.name.trim());
  const headers: [string, string][] = mine.map((h) => [sub(h.name.trim()), sub(h.value)]);
  mine.forEach((h, i) => {
    if (usesSecretVar(h.name, vars) || usesSecretVar(h.value, vars) || SECRET_NAME.test(headers[i][0])) sensitive.add(headers[i][0]);
  });
  const a = d.auth;
  if (a.type === 'bearer' && a.token && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `Bearer ${sub(a.token)}`]);
  if (a.type === 'basic' && (a.username || a.password) && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `Basic ${utf8Base64(`${sub(a.username)}:${sub(a.password)}`)}`]);
  if (a.type === 'bearer' || a.type === 'basic') sensitive.add('Authorization');
  if (a.type === 'apikey' && a.key.trim()) {
    const name = sub(a.key.trim());
    const value = sub(a.token);
    if (a.keyIn === 'query') {
      const { base, query, hash } = splitUrl(url);
      url = `${base}?${query ? `${query}&` : ''}${encodeURIComponent(name)}=${encodeURIComponent(value)}${hash}`;
    } else {
      if (!hasHeader(headers, name)) headers.push([name, value]);
      sensitive.add(name);
    }
  }
  let body: string | null = null;
  if (d.bodyType !== 'none') {
    const raw = sub(d.body);
    body = d.bodyType === 'form' ? formBody(raw) : raw;
    if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', CONTENT_TYPE[d.bodyType]]);
  }
  const auto = appVersion ? defaultHeaders(appVersion).filter(([n]) => !hasHeader(headers, n)) : [];
  return { method: normalizeMethod(d.method) ?? '', url, headers, auto, body, timeout: d.timeout, follow: d.follow, insecure: d.insecure, missing: [...missing], sensitive: [...sensitive] };
}
export type BuiltRequest = ReturnType<typeof buildRequest>;

// 헤더 탭에 보여 줄 "앱이 붙이는 헤더": 인증·본문 탭에서 나온 것, 앱 기본값, 보낼 때 정해지는 것
export type AutoHeader = { name: string; value: string; from: 'auth' | 'body' | 'app' | 'send' };
export function autoHeaders(d: RequestDraft, vars: HttpEnvVar[], appVersion: string): AutoHeader[] {
  const built = buildRequest(d, vars, appVersion);
  const mine = new Set(d.headers.filter((h) => h.on && h.name.trim()).map((h) => substitute(h.name.trim(), vars).toLowerCase()));
  const out: AutoHeader[] = [];
  for (const [name, value] of built.headers) {
    if (mine.has(name.toLowerCase())) continue;
    const secret = name.toLowerCase() === 'authorization' || (d.auth.type === 'apikey' && name.toLowerCase() === d.auth.key.trim().toLowerCase());
    out.push({ name, value: secret ? `${value.split(' ')[0] === value ? '' : `${value.split(' ')[0]} `}●●●●` : value, from: name.toLowerCase() === 'content-type' ? 'body' : 'auth' });
  }
  for (const [name, value] of built.auto) out.push({ name, value, from: 'app' });
  let host = '';
  try {
    host = new URL(built.url).host;
  } catch {}
  if (!mine.has('host')) out.push({ name: 'Host', value: host, from: 'send' });
  if (built.body !== null && !mine.has('content-length')) out.push({ name: 'Content-Length', value: String(new TextEncoder().encode(built.body).length), from: 'send' });
  if (!mine.has('connection')) out.push({ name: 'Connection', value: 'close', from: 'send' });
  return out;
}

// 기록에 남길 대상: 메서드 + 주소(쿼리·# 은 빼고 — 토큰이 섞일 수 있다)
export function logTarget(method: string, url: string) {
  try {
    const u = new URL(url);
    return `${method} ${u.origin}${u.pathname}`;
  } catch {
    return method;
  }
}

// ---------- curl 가져오기 ----------
function shellWords(text: string) {
  // 줄 잇기(\ 줄바꿈, 윈도우 cmd 의 ^ 줄바꿈)는 공백으로
  const src = text.replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let started = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      cur += src.slice(i + 1, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
      started = true;
    } else if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) i++;
        cur += src[i++];
      }
      started = true;
    } else if (ch === '\\' && i + 1 < src.length) {
      cur += src[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

export function parseCurl(text: string): RequestDraft | null {
  const words = shellWords(text.trim());
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0])) return null;
  const d: RequestDraft = { label: '', collection: '', method: '', url: '', headers: [], offParams: [], bodyType: 'none', body: '', auth: { ...NO_AUTH }, insecure: false, follow: false, timeout: 30 };
  const data: string[] = [];
  let get = false;
  let json = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = () => words[++i] ?? '';
    const [flag, inline] = w.startsWith('--') && w.includes('=') ? [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] : [w, undefined];
    const val = () => inline ?? next();
    switch (flag) {
      case '-X':
      case '--request': {
        // 메서드 자리에 명령을 숨겨 둔 curl 은 읽지 않는다 (코드로 내보내면 그대로 실행될 수 있다)
        const m = normalizeMethod(val());
        if (!m) return null;
        d.method = m;
        break;
      }
      case '-H':
      case '--header': {
        const h = val();
        const c = h.indexOf(':');
        if (c > 0) d.headers.push({ name: h.slice(0, c).trim(), value: h.slice(c + 1).trim(), on: true });
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
      case '--data-urlencode':
        data.push(val());
        break;
      case '--json':
        data.push(val());
        json = true;
        break;
      case '-u':
      case '--user': {
        const u = val();
        const c = u.indexOf(':');
        d.auth = { ...NO_AUTH, type: 'basic', username: c < 0 ? u : u.slice(0, c), password: c < 0 ? '' : u.slice(c + 1) };
        break;
      }
      case '-k':
      case '--insecure':
        d.insecure = true;
        break;
      case '-L':
      case '--location':
        d.follow = true;
        break;
      case '-I':
      case '--head':
        d.method = 'HEAD';
        break;
      case '-G':
      case '--get':
        get = true;
        break;
      case '-A':
      case '--user-agent':
        d.headers.push({ name: 'User-Agent', value: val(), on: true });
        break;
      case '-e':
      case '--referer':
        d.headers.push({ name: 'Referer', value: val(), on: true });
        break;
      case '-b':
      case '--cookie':
        d.headers.push({ name: 'Cookie', value: val(), on: true });
        break;
      case '-m':
      case '--max-time':
        d.timeout = Math.min(300, Math.max(1, Math.round(Number(val()) || 30)));
        break;
      case '--url':
        d.url = val();
        break;
      case '-o':
      case '--output':
      case '-w':
      case '--write-out':
      case '--connect-timeout':
        val();
        break;
      default:
        if (!w.startsWith('-') && !d.url) d.url = w;
    }
  }
  if (!d.url) return null;
  if (!/^https?:\/\//i.test(d.url)) d.url = `http://${d.url}`;
  if (data.length) {
    if (get) {
      const u = new URL(d.url);
      for (const part of data.join('&').split('&')) {
        const i = part.indexOf('=');
        u.searchParams.append(i < 0 ? part : part.slice(0, i), i < 0 ? '' : part.slice(i + 1));
      }
      d.url = u.toString();
    } else {
      d.body = data.join('&');
      const ct = d.headers.find((h) => h.name.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
      const looksJson = /^\s*[{[]/.test(d.body);
      d.bodyType = json || ct.includes('json') || (!ct && looksJson) ? 'json' : ct.includes('x-www-form-urlencoded') || (!ct && /^[^=&\s]+=/.test(d.body)) ? 'form' : ct.includes('xml') ? 'xml' : 'text';
      if (d.bodyType === 'form') d.body = d.body.split('&').join('\n');
      if (json && !ct) d.headers.push({ name: 'Content-Type', value: 'application/json', on: true });
      if (json && !d.headers.some((h) => h.name.toLowerCase() === 'accept')) d.headers.push({ name: 'Accept', value: 'application/json', on: true });
      if (!d.method) d.method = 'POST';
    }
  }
  if (!d.method) d.method = 'GET';
  return d;
}

// ---------- 코드로 내보내기 (변수를 채운 실제 값으로, 앱 기본 헤더는 빼고) ----------
// 공유된 요청·붙여 넣은 curl 의 값이 내보낸 명령 밖으로 새어 나와 명령이 되지 않게 (보안 점검 M-9).
// 메서드가 규칙(normalizeMethod)에 맞지 않으면 내보내지 않는다 — 화면은 미리 막는다.

// sh·bash·zsh 의 작은따옴표(안에서는 아무것도 풀지 않는다): 값의 ' 는 끊고 "'" 로 넣는다.
// fish 는 작은따옴표 안에서도 \' 와 \\ 를 풀므로, ' 나 \ 앞의 \ 와 맨 끝의 \ 도 "\\" 로 뺀다.
// PowerShell 에 붙여 넣으면 ‘ ’ ‚ ‛ 도 작은따옴표를 끝내므로 "…" 로 뺀다 (PowerShell 에서는 인자가 갈라질 뿐 명령이 되지 않는다).
const q = (s: string) => `'${s.replace(/\\(?=\\|'|$)|['\u2018\u2019\u201a\u201b]/g, (c) => (c === "'" ? `'"'"'` : c === '\\' ? `'"\\\\"'` : `'"${c}"'`))}'`;
export function toCurl(built: BuiltRequest) {
  const method = checkedMethod(built.method);
  const parts = ['curl'];
  if (method !== 'GET' || built.body !== null) parts.push('-X', method);
  // - 로 시작하는 주소는 curl 이 옵션(-K 설정 파일 등)으로 읽는다 → 그럴 때는 --url 뒤에
  parts.push(...(built.url.startsWith('-') ? ['--url', q(built.url)] : [q(built.url)]));
  for (const [n, v] of built.headers) parts.push('-H', q(`${n}: ${v}`));
  if (built.body !== null) parts.push('--data-raw', q(built.body));
  if (built.insecure) parts.push('-k');
  if (built.follow) parts.push('-L');
  return parts.join(' ');
}

// PowerShell (Windows PowerShell 5.1 도 되게: Invoke-WebRequest). 작은따옴표 문자열은 ' 뿐 아니라 ‘ ’ ‚ ‛ 에서도 끝나므로
// 넷 다 두 번 적는다 ('' 처럼 두 번 적은 것은 글자 하나가 된다)
const ps = (s: string) => `'${s.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
// -Method 가 받는 메서드 (그 밖의 것은 PowerShell 6 이상의 -CustomMethod)
const PS_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'TRACE', 'OPTIONS', 'MERGE', 'PATCH']);
export function toPowerShell(built: BuiltRequest) {
  const method = checkedMethod(built.method);
  const lines: string[] = [];
  const headers = built.headers.filter(([n]) => n.toLowerCase() !== 'content-type');
  const contentType = built.headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1];
  if (headers.length) {
    lines.push('$headers = @{');
    for (const [n, v] of headers) lines.push(`  ${ps(n)} = ${ps(v)}`);
    lines.push('}');
  }
  if (!PS_METHODS.has(method)) lines.push('# -CustomMethod needs PowerShell 6 or later');
  const args = [PS_METHODS.has(method) ? `-Method ${method}` : `-CustomMethod ${ps(method)}`, `-Uri ${ps(built.url)}`];
  if (headers.length) args.push('-Headers $headers');
  if (contentType) args.push(`-ContentType ${ps(contentType)}`);
  if (built.body !== null) args.push(`-Body ${ps(built.body)}`);
  if (!built.follow) args.push('-MaximumRedirection 0');
  if (built.insecure) lines.push('# -SkipCertificateCheck needs PowerShell 7 or later');
  lines.push(`Invoke-WebRequest ${args.join(' ')}${built.insecure ? ' -SkipCertificateCheck' : ''} -UseBasicParsing`);
  return lines.join('\n');
}

// JSON 문자열은 JS·Python 문자열로도 그대로 읽힌다 (" \ 줄바꿈·제어 문자는 \ 로 적힌다)
const js = (s: string) => JSON.stringify(s);
export function toFetch(built: BuiltRequest) {
  const opts: string[] = [`  method: ${js(checkedMethod(built.method))},`];
  if (built.headers.length) {
    opts.push('  headers: {');
    for (const [n, v] of built.headers) opts.push(`    ${js(n)}: ${js(v)},`);
    opts.push('  },');
  }
  if (built.body !== null) opts.push(`  body: ${js(built.body)},`);
  if (!built.follow) opts.push(`  redirect: 'manual',`);
  return `const res = await fetch(${js(built.url)}, {\n${opts.join('\n')}\n});\nconsole.log(res.status, await res.text());`;
}

const py = (s: string) => JSON.stringify(s);
export function toPython(built: BuiltRequest) {
  const method = checkedMethod(built.method);
  const lines = ['import requests', ''];
  const args = [py(built.url)];
  if (built.headers.length) {
    lines.push('headers = {');
    for (const [n, v] of built.headers) lines.push(`    ${py(n)}: ${py(v)},`);
    lines.push('}');
    args.push('headers=headers');
  }
  if (built.body !== null) {
    lines.push(`data = ${py(built.body)}.encode("utf-8")`);
    args.push('data=data');
  }
  args.push(`timeout=${Math.min(300, Math.max(1, Math.round(Number(built.timeout)) || 30))}`);
  if (!built.follow) args.push('allow_redirects=False');
  if (built.insecure) args.push('verify=False');
  lines.push(`res = requests.request(${py(method)}, ${args.join(', ')})`);
  lines.push('print(res.status_code, res.text)');
  return lines.join('\n');
}

// ---------- 응답 쿠키 (Set-Cookie) ----------
export type Cookie = { name: string; value: string; attrs: string[] };
export function parseCookies(headers: [string, string][]): Cookie[] {
  return headers
    .filter(([n]) => n.toLowerCase() === 'set-cookie')
    .map(([, v]) => {
      const [pair, ...rest] = v.split(';');
      const i = pair.indexOf('=');
      return { name: (i < 0 ? pair : pair.slice(0, i)).trim(), value: i < 0 ? '' : pair.slice(i + 1).trim(), attrs: rest.map((a) => a.trim()).filter(Boolean) };
    });
}

// ---------- 응답 본문 ----------
export function decodeBody(base64: string) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function looksBinary(bytes: Uint8Array, contentType: string) {
  if (/json|xml|text|javascript|html|yaml|csv|x-www-form-urlencoded/i.test(contentType)) return false;
  const sample = bytes.subarray(0, 4096);
  let odd = 0;
  for (const b of sample) if (b === 0 || (b < 9 && b !== 0)) odd++;
  return odd > 0;
}

export type JsonToken = { kind: 'key' | 'string' | 'number' | 'bool' | 'null' | 'punct'; text: string };
// 정리한 JSON 글을 색칠할 조각으로 (키·문자열·숫자·true/false·null)
export function jsonTokens(pretty: string): JsonToken[] {
  const out: JsonToken[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pretty))) {
    if (m.index > last) out.push({ kind: 'punct', text: pretty.slice(last, m.index) });
    if (m[1]) {
      out.push({ kind: m[2] ? 'key' : 'string', text: m[1] });
      if (m[2]) out.push({ kind: 'punct', text: m[2] });
    } else if (m[3]) out.push({ kind: 'number', text: m[3] });
    else if (m[4]) out.push({ kind: 'bool', text: m[4] });
    else out.push({ kind: 'null', text: m[5] });
    last = re.lastIndex;
  }
  if (last < pretty.length) out.push({ kind: 'punct', text: pretty.slice(last) });
  return out;
}
