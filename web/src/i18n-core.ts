// 화면 언어의 알맹이 — JSX·Vite 기능 없이 순수 TS (보안 시험 스크립트가 e2ee.ts·ssh/*.ts 를 Node 로 바로 불러서).
// .tsx 는 ./i18n 을, .ts 는 이 파일을 가져다 쓴다. 사전 불러오기·언어 바꾸기·tr() 은 ./i18n.tsx 에 있다.
//
// 한국어 원문이 곧 키다 — t('호스트') 는 사전(locales/<언어>.json)에 있으면 그 번역, 없으면 한국어 그대로.
//   t('문구')                   글자만
//   t('{n}개 선택됨', { n })     틀 + 값 (숫자·이름을 문구에 박으면 키가 달라져 번역이 조용히 빠진다 → {이름} 으로)
//   tk('호스트')                 모듈 맨 위 상수에 넣을 때: 키 표시만, 그릴 때 t(키)
//   tMsg(err.message)           서버·앱 본체가 보낸 한국어 메시지 번역 (정확히 같거나 {틀} 이 맞으면)
// 모듈 맨 위에서 t() 를 부르면 안 된다 (언어를 바꿔도 그대로 남는다).

export type Lang = 'ko' | 'en' | 'ja' | 'zh' | 'es' | 'de';
export const LANGS: { id: Lang; name: string; locale: string }[] = [
  { id: 'ko', name: '한국어', locale: 'ko-KR' }, // i18n-ignore (언어 이름은 그 언어로)
  { id: 'en', name: 'English', locale: 'en-US' },
  { id: 'ja', name: '日本語', locale: 'ja-JP' },
  { id: 'zh', name: '简体中文', locale: 'zh-CN' },
  { id: 'es', name: 'Español', locale: 'es-ES' },
  { id: 'de', name: 'Deutsch', locale: 'de-DE' },
];
export const isLang = (v: unknown): v is Lang => LANGS.some((l) => l.id === v);

let lang: Lang = 'ko';
let dict: Record<string, string> = {};
let templates: { re: RegExp; key: string; names: string[] }[] | null = null;
const listeners = new Set<() => void>();

export const getLang = () => lang;
export const locale = () => LANGS.find((l) => l.id === lang)!.locale;

// i18n.tsx 가 사전을 불러온 뒤 부른다
export function applyLang(next: Lang, nextDict: Record<string, string>) {
  lang = next;
  dict = nextDict;
  templates = null;
  for (const l of listeners) l();
}
export function subscribeLang(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

const missing = new Set<string>();
const devMode = (() => {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
})();

export function lookup(ko: string) {
  if (lang === 'ko') return ko;
  const hit = dict[ko];
  if (hit) return hit;
  if (devMode && !missing.has(ko)) {
    missing.add(ko);
    console.warn(`[i18n:${lang}] 번역 없음:`, ko);
  }
  return ko;
}

export const fill = (text: string, vars?: Record<string, unknown>) => (vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text);

export function t(ko: string, vars?: Record<string, string | number>): string {
  return fill(lookup(ko), vars);
}

// 키 표시만 (모듈 맨 위 상수용). 그릴 때 t() 로 번역한다
export const tk = (ko: string) => ko;

// 서버·앱 본체(메인 프로세스)가 보낸 한국어 메시지 번역. 정확히 같은 키가 없으면 {틀} 이 있는 키와 맞춰 본다.
export function tMsg(message: string): string {
  if (lang === 'ko' || !message) return message;
  const hit = dict[message];
  if (hit) return hit;
  templates ??= Object.keys(dict)
    .filter((k) => /\{\w+\}/.test(k))
    .map((key) => {
      const names: string[] = [];
      const pattern = key
        .split(/(\{\w+\})/)
        .map((part) => {
          const v = /^\{(\w+)\}$/.exec(part);
          if (v) {
            names.push(v[1]);
            return '([\\s\\S]+?)';
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('');
      return { re: new RegExp(`^${pattern}$`), key, names };
    });
  for (const { re, key, names } of templates) {
    const m = re.exec(message);
    if (m) return fill(dict[key], Object.fromEntries(names.map((n, i) => [n, tMsg(m[i + 1])])));
  }
  return message;
}
