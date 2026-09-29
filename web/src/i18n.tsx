// 화면 언어 — 사전 불러오기·언어 바꾸기·다시 그리기·tr(). 규칙과 t()/tk()/tMsg() 는 ./i18n-core.ts.
//   tr('<b>{name}</b> 을 지울까요?', { name })   굵게·요소가 섞인 문장 (한 문장을 조각내면 다른 언어에서 어순이 깨진다)
// 언어를 바꾸면 화면 전체를 다시 그린다(새로고침 없음 — 열린 접속이 끊기지 않는다).
import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { applyLang, getLang, isLang, lookup, subscribeLang, type Lang } from './i18n-core';
import { desktop } from './desktop';

export { LANGS, getLang, locale, t, tk, tMsg, type Lang } from './i18n-core';

const KEY = 'terminas.lang';
// _keys.json 은 번역할 목록(점검 스크립트가 만든다)이라 앱에 넣지 않는다
const loaders = import.meta.glob<{ default: Record<string, string> }>(['./locales/*.json', '!./locales/_keys.json']);

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLang(saved)) return saved;
  } catch {}
  for (const l of navigator.languages ?? [navigator.language]) {
    const base = String(l).toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return 'en';
}

async function load(next: Lang): Promise<Record<string, string>> {
  if (next === 'ko') return {};
  const loader = loaders[`./locales/${next}.json`];
  return loader ? (await loader()).default : {};
}

function announce(next: Lang) {
  document.documentElement.lang = next;
  // 앱: 메뉴·대화상자 언어도 맞춘다
  void desktop?.setLang?.(next)?.catch(() => {});
}

// 첫 화면을 그리기 전에 부른다
export async function initLang() {
  const next = initial();
  applyLang(next, await load(next).catch(() => ({})));
  announce(next);
}

export async function setLang(next: Lang) {
  if (!isLang(next)) return;
  const d = await load(next).catch(() => ({}));
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  applyLang(next, d);
  announce(next);
}

// 언어가 바뀌면 다시 그린다 (App 맨 위에서 한 번 쓰면 아래가 모두 다시 그려진다)
export function useLang() {
  return useSyncExternalStore(subscribeLang, getLang);
}

type RichVar = ReactNode | ((children: ReactNode) => ReactNode);

// 굵게·코드·다른 요소가 섞인 문장. 번역문 안의 <b>…</b>·<code>…</code>·<이름>…</이름> 과 {이름} 을 그린다
export function tr(ko: string, vars: Record<string, RichVar> = {}): ReactNode {
  return <Fragment>{rich(lookup(ko), vars)}</Fragment>;
}

function rich(text: string, vars: Record<string, RichVar>): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      const tag = m[1];
      const inner = rich(m[2], vars);
      const v = vars[tag];
      if (typeof v === 'function') out.push(<Fragment key={i++}>{v(inner)}</Fragment>);
      else if (tag === 'b') out.push(<b key={i++}>{inner}</b>);
      else if (tag === 'code') out.push(<code key={i++}>{inner}</code>);
      else out.push(<Fragment key={i++}>{inner}</Fragment>);
    } else {
      const v = vars[m[3]];
      out.push(<Fragment key={i++}>{typeof v === 'function' ? null : (v ?? m[0])}</Fragment>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
