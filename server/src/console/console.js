// Terminas 관리 콘솔 화면 (서버 PC 안에서만). 데이터는 모두 textContent 로 넣는다 — 사람 이름·이메일을 HTML 로 해석하지 않는다.
'use strict';

const KO = /^ko\b/i.test(navigator.language || '');
const T = KO
  ? {
      title: 'Terminas 관리 콘솔',
      onlyHere: '이 화면은 서버 PC 안에서만 열립니다. 볼트 안의 내용은 관리자도 볼 수 없습니다.',
      noPassword: '관리 비밀번호가 아직 없습니다. 서버 PC 의 터미널에서 정하세요:',
      password: '관리 비밀번호',
      otp: 'OTP 코드 (6자리)',
      login: '로그인',
      logout: '로그아웃',
      refresh: '새로고침',
      modes: { open: '누구나 가입', invite: '초대한 사람만', google: 'Google', password: '아이디·비밀번호' },
      stats: { users: '가입한 사람', new7: '7일 동안 새로 가입', active7: '7일 동안 로그인', active30: '30일 동안 로그인', disabled: '막힌 계정', teams: '팀', vaults: '볼트', items: '볼트 항목', sessions: '살아 있는 로그인' },
      tabs: { users: '사용자', teams: '팀', log: '서버 기록' },
      search: '이메일·이름 검색',
      filters: { all: '모두', admins: '서버 관리자', disabled: '막힌 계정', nokeys: '암호화 설정 전' },
      people: (n) => `${n}명`,
      cols: { person: '사람', joined: '가입', last: '마지막 로그인', teams: '팀', flags: '표시', actions: '작업', team: '팀', owners: '소유자', members: '팀원', vaults: '볼트', created: '만든 날', time: '시각', who: '누가', action: '동작', target: '대상', detail: '내용' },
      never: '없음',
      flags: { admin: '서버 관리자', disabled: '막힘', mfa: '2단계', nokeys: '암호화 설정 전', google: 'Google', password: '비밀번호' },
      act: { disable: '막기', enable: '풀기', grant: '관리자로', revoke: '관리자 해제', signout: '로그아웃', mfa: '2단계 초기화', del: '지우기' },
      confirm: {
        disable: (e) => `${e} 계정을 막을까요? 모든 기기에서 로그아웃됩니다.`,
        grant: (e) => `${e} 을(를) 서버 관리자로 지정할까요? (팀을 제한 없이 만들 수 있게 됩니다)`,
        revoke: (e) => `${e} 의 서버 관리자 권한을 뺄까요?`,
        signout: (e) => `${e} 을(를) 모든 기기에서 로그아웃시킬까요?`,
        mfa: (e) => `${e} 의 2단계 인증을 끌까요?`,
        del: (e, teams) => `${e} 계정을 지웁니다. 개인 볼트와 로그인${teams.length ? `, 혼자 있는 팀(${teams.join(', ')})` : ''}이 함께 지워지고 되돌릴 수 없습니다.\n확인을 위해 이메일을 그대로 적어 주세요.`,
      },
      mismatch: '이메일이 맞지 않아 지우지 않았습니다.',
      done: '했습니다',
      more: '더 보기',
      noTeams: '팀이 없습니다.',
      byConsole: '관리 콘솔',
      actions: {
        login: '로그인', logout: '로그아웃', login_rejected: '로그인 거절', team_create: '팀 만듦', team_delete: '팀 삭제', team_rename: '팀 이름 변경',
        invite_create: '초대', invite_delete: '초대 취소', invite_accept: '초대 수락', invite_code: '초대 코드 새로 만듦', member_add: '팀원 추가', member_role: '역할 변경', member_remove: '팀원 내보냄',
        mfa_enable: '2단계 인증 켬', mfa_disable: '2단계 인증 끔', mfa_verify: '2단계 인증 통과', mfa_fail: '2단계 인증 실패', mfa_reset: '2단계 인증 초기화', mfa_recovery_new: '복구 코드 새로 만듦',
        password_set: '로그인 비밀번호 정함', password_change: '로그인 비밀번호 바꿈', keys_setup: '암호화 설정', keys_password: '암호화 비밀번호 변경', keys_reset: '암호화 초기화', keys_recovered: '복구 키로 되살림', keys_new_recovery: '복구 키 새로 받음',
        admin_user_disable: '계정 막음', admin_user_enable: '계정 막기 풂', admin_grant: '서버 관리자 지정', admin_revoke: '서버 관리자 해제', admin_signout: '모든 기기에서 로그아웃시킴', admin_user_delete: '계정 지움',
        console_login: '콘솔 로그인', console_login_failed: '콘솔 로그인 실패', console_password: '콘솔 비밀번호 설정',
      },
    }
  : {
      title: 'Terminas Admin Console',
      onlyHere: 'This console only opens on the server machine. Admins cannot see vault contents either.',
      noPassword: 'No admin password yet. Set one in a terminal on the server machine:',
      password: 'Admin password',
      otp: 'OTP code (6 digits)',
      login: 'Sign in',
      logout: 'Sign out',
      refresh: 'Refresh',
      modes: { open: 'Open sign-up', invite: 'Invite only', google: 'Google', password: 'ID & password' },
      stats: { users: 'People', new7: 'New in 7 days', active7: 'Signed in, 7 days', active30: 'Signed in, 30 days', disabled: 'Disabled accounts', teams: 'Teams', vaults: 'Vaults', items: 'Vault items', sessions: 'Active sessions' },
      tabs: { users: 'Users', teams: 'Teams', log: 'Server log' },
      search: 'Search email or name',
      filters: { all: 'All', admins: 'Server admins', disabled: 'Disabled', nokeys: 'Encryption not set up' },
      people: (n) => `${n} ${n === 1 ? 'person' : 'people'}`,
      cols: { person: 'Person', joined: 'Joined', last: 'Last sign-in', teams: 'Teams', flags: 'Flags', actions: 'Actions', team: 'Team', owners: 'Owners', members: 'Members', vaults: 'Vaults', created: 'Created', time: 'Time', who: 'Who', action: 'Action', target: 'Target', detail: 'Detail' },
      never: 'never',
      flags: { admin: 'Server admin', disabled: 'Disabled', mfa: '2FA', nokeys: 'No encryption yet', google: 'Google', password: 'Password' },
      act: { disable: 'Disable', enable: 'Enable', grant: 'Make admin', revoke: 'Remove admin', signout: 'Sign out', mfa: 'Reset 2FA', del: 'Delete' },
      confirm: {
        disable: (e) => `Disable ${e}? They are signed out everywhere.`,
        grant: (e) => `Make ${e} a server admin? (They can create teams without limits.)`,
        revoke: (e) => `Remove server admin from ${e}?`,
        signout: (e) => `Sign ${e} out on every device?`,
        mfa: (e) => `Turn off two-factor authentication for ${e}?`,
        del: (e, teams) => `Delete ${e}? Their personal vault and sessions${teams.length ? `, and teams where they are alone (${teams.join(', ')})` : ''} are deleted. This cannot be undone.\nType the email to confirm.`,
      },
      mismatch: 'The email did not match. Nothing was deleted.',
      done: 'Done',
      more: 'Load more',
      noTeams: 'No teams.',
      byConsole: 'admin console',
      actions: {},
    };

const app = document.getElementById('app');
document.title = T.title;
document.documentElement.lang = KO ? 'ko' : 'en';

// ---------- 작은 도구 ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
const fmt = (ts) => (ts ? new Date(ts).toLocaleString(KO ? 'ko-KR' : undefined, { dateStyle: 'medium', timeStyle: 'short' }) : T.never);
const day = (ts) => new Date(ts).toLocaleDateString(KO ? 'ko-KR' : undefined, { dateStyle: 'medium' });

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'x-console': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.message) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer = null;
function toast(message, error = false) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: `toast${error ? ' error' : ''}`, role: 'status', text: message });
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 4000);
}

// ---------- 로그인 ----------
async function start() {
  let state;
  try {
    state = await api('GET', '/admin/api/state');
  } catch (err) {
    app.replaceChildren(el('p', { class: 'error', text: err.message }));
    return;
  }
  if (state.loggedIn) return dashboard();
  const error = el('p', { class: 'error' });
  const pw = el('input', { type: 'password', placeholder: T.password, autocomplete: 'current-password', 'aria-label': T.password });
  const code = state.otp ? el('input', { inputmode: 'numeric', placeholder: T.otp, autocomplete: 'one-time-code', 'aria-label': T.otp }) : null;
  const form = el(
    'form',
    {
      class: 'card login',
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = '';
        try {
          await api('POST', '/admin/api/login', { password: pw.value, code: code ? code.value : '' });
          dashboard();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    el('h1', { text: T.title }),
    el('p', { class: 'muted small', text: T.onlyHere }),
    state.passwordSet ? [pw, code, el('button', { class: 'primary', type: 'submit', text: T.login })] : [el('p', { text: T.noPassword }), el('code', { text: 'npm run console:password -w server' })],
    error,
  );
  app.replaceChildren(form);
  if (state.passwordSet) pw.focus();
}

// ---------- 관리 화면 ----------
let tab = 'users';
async function dashboard() {
  const header = el('div', { class: 'head' }, el('h1', { text: T.title }));
  const modes = el('div', { class: 'head' });
  header.append(modes, el('span', { class: 'spacer' }), el('button', { onclick: () => render(), text: T.refresh }), el('button', { onclick: async () => (await api('POST', '/admin/api/logout'), start()), text: T.logout }));
  const statsBox = el('div', { class: 'stats' });
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const body = el('div', { class: 'card' });
  app.replaceChildren(header, statsBox, tabs, body, el('p', { class: 'muted small foot', text: T.onlyHere }));

  async function render() {
    try {
      const s = await api('GET', '/admin/api/stats');
      modes.replaceChildren(
        ...[
          el('span', { class: `badge ${s.server.openSignup ? 'accent' : ''}`, text: s.server.openSignup ? T.modes.open : T.modes.invite }),
          s.server.google && el('span', { class: 'badge', text: T.modes.google }),
          s.server.passwordLogin && el('span', { class: 'badge', text: T.modes.password }),
        ].filter(Boolean),
      );
      statsBox.replaceChildren(...Object.entries(T.stats).map(([k, label]) => el('div', { class: 'stat' }, el('b', { text: Number(s[k] ?? 0).toLocaleString() }), el('span', { class: 'muted small', text: label }))));
    } catch (err) {
      if (err.status === 401) return start();
      toast(err.message, true);
    }
    tabs.replaceChildren(
      ...Object.entries(T.tabs).map(([id, label]) =>
        el('button', { class: tab === id ? 'on' : '', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', onclick: () => ((tab = id), render()), text: label }),
      ),
    );
    if (tab === 'users') usersTab(body, render);
    else if (tab === 'teams') teamsTab(body);
    else logTab(body);
  }
  render();
}

// ---------- 사용자 ----------
let query = '';
let filter = 'all';
function usersTab(box, refresh) {
  const search = el('input', { type: 'search', placeholder: T.search, value: query, 'aria-label': T.search });
  const select = el('select', { 'aria-label': 'filter' }, ...Object.entries(T.filters).map(([v, label]) => el('option', { value: v, selected: v === filter, text: label })));
  const count = el('p', { class: 'muted small' });
  const tbody = el('tbody');
  const more = el('div', { class: 'more' });
  const table = el(
    'div',
    { class: 'table-wrap' },
    el('table', {}, el('thead', {}, el('tr', {}, ...['person', 'joined', 'last', 'teams', 'flags', 'actions'].map((c) => el('th', { text: T.cols[c] })))), tbody),
  );
  box.replaceChildren(el('div', { class: 'toolbar' }, search, select), count, table, more);

  let users = [];
  async function load(offset = 0) {
    try {
      const r = await api('GET', `/admin/api/users?${new URLSearchParams({ q: query, filter, offset: String(offset) })}`);
      users = offset ? users.concat(r.users) : r.users;
      count.textContent = T.people(r.total);
      tbody.replaceChildren(...users.map(row));
      more.replaceChildren(users.length < r.total ? el('button', { onclick: () => load(users.length), text: T.more }) : '');
    } catch (err) {
      if (err.status === 401) return start();
      toast(err.message, true);
    }
  }
  let timer = null;
  search.addEventListener('input', () => {
    query = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => load(), 250);
  });
  select.addEventListener('change', () => ((filter = select.value), load()));

  const act = async (message, fn) => {
    if (message && !confirm(message)) return;
    try {
      await fn();
      toast(T.done);
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  };

  function row(u) {
    const flags = [
      u.isAdmin && el('span', { class: 'badge accent', text: T.flags.admin }),
      u.disabled && el('span', { class: 'badge danger', text: T.flags.disabled }),
      u.mfa && el('span', { class: 'badge ok', text: T.flags.mfa }),
      !u.keys && el('span', { class: 'badge warn', text: T.flags.nokeys }),
      u.google && el('span', { class: 'badge', text: T.flags.google }),
      u.password && el('span', { class: 'badge', text: T.flags.password }),
    ];
    const base = `/admin/api/users/${encodeURIComponent(u.id)}`;
    const actions = [
      u.disabled
        ? el('button', { class: 'small', onclick: () => act(null, () => api('POST', `${base}/disable`, { disabled: false })), text: T.act.enable })
        : el('button', { class: 'small danger', onclick: () => act(T.confirm.disable(u.email), () => api('POST', `${base}/disable`, { disabled: true })), text: T.act.disable }),
      u.isAdmin
        ? el('button', { class: 'small', onclick: () => act(T.confirm.revoke(u.email), () => api('POST', `${base}/admin`, { admin: false })), text: T.act.revoke })
        : el('button', { class: 'small', onclick: () => act(T.confirm.grant(u.email), () => api('POST', `${base}/admin`, { admin: true })), text: T.act.grant }),
      el('button', { class: 'small', disabled: !u.sessions, onclick: () => act(T.confirm.signout(u.email), () => api('POST', `${base}/signout`)), text: T.act.signout }),
      u.mfa && el('button', { class: 'small', onclick: () => act(T.confirm.mfa(u.email), () => api('POST', `${base}/mfa-reset`)), text: T.act.mfa }),
      el('button', {
        class: 'small danger',
        onclick: async () => {
          const detail = await api('GET', base).catch(() => ({ teams: [] }));
          const solo = detail.teams.filter((x) => x.role === 'owner' && x.members === 1).map((x) => x.name);
          const typed = prompt(T.confirm.del(u.email, solo));
          if (typed === null) return;
          if (typed.trim() !== u.email) return toast(T.mismatch, true);
          await act(null, () => api('DELETE', base, { confirm: u.email }));
        },
        text: T.act.del,
      }),
    ];
    return el(
      'tr',
      { class: u.disabled ? 'disabled' : '' },
      el('td', {}, el('div', { text: u.name || u.email }), el('div', { class: 'muted small', text: u.email })),
      el('td', { class: 'nowrap muted', text: day(u.createdAt) }),
      el('td', { class: 'nowrap muted', text: fmt(u.lastLoginAt) }),
      el('td', { text: String(u.teams) }),
      el('td', {}, el('div', { class: 'badges' }, ...flags)),
      el('td', {}, el('div', { class: 'actions' }, ...actions)),
    );
  }
  load();
}

// ---------- 팀 ----------
async function teamsTab(box) {
  try {
    const teams = await api('GET', '/admin/api/teams');
    if (!teams.length) return box.replaceChildren(el('p', { class: 'muted', text: T.noTeams }));
    box.replaceChildren(
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          {},
          el('thead', {}, el('tr', {}, ...['team', 'owners', 'members', 'vaults', 'created'].map((c) => el('th', { text: T.cols[c] })))),
          el(
            'tbody',
            {},
            ...teams.map((x) =>
              el('tr', {}, el('td', { text: x.name }), el('td', { class: 'muted', text: x.owners || '—' }), el('td', { text: String(x.members) }), el('td', { text: String(x.vaults) }), el('td', { class: 'nowrap muted', text: day(x.createdAt) })),
            ),
          ),
        ),
      ),
    );
  } catch (err) {
    if (err.status === 401) return start();
    toast(err.message, true);
  }
}

// ---------- 서버 기록 ----------
async function logTab(box) {
  const tbody = el('tbody');
  const more = el('div', { class: 'more' });
  box.replaceChildren(
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ...['time', 'who', 'action', 'target', 'detail'].map((c) => el('th', { text: T.cols[c] })))), tbody)),
    more,
  );
  let rows = [];
  async function load(before) {
    try {
      const list = await api('GET', `/admin/api/audit${before ? `?before=${before}` : ''}`);
      rows = before ? rows.concat(list) : list;
      tbody.replaceChildren(
        ...rows.map((e) => {
          const d = e.detail || {};
          const detail = Object.entries(d)
            .filter(([k]) => k !== 'by')
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(', ');
          return el(
            'tr',
            {},
            el('td', { class: 'nowrap muted', text: fmt(e.ts) }),
            el('td', { text: e.userEmail || (d.by === 'console' || String(e.action).startsWith('console_') ? T.byConsole : '—'), title: e.ip || '' }),
            el('td', {}, el('span', { class: 'badge', text: T.actions[e.action] || e.action })),
            el('td', { text: e.target || '' }),
            el('td', { class: 'muted small', text: detail }),
          );
        }),
      );
      more.replaceChildren(list.length === 200 ? el('button', { onclick: () => load(rows[rows.length - 1].id), text: T.more }) : '');
    } catch (err) {
      if (err.status === 401) return start();
      toast(err.message, true);
    }
  }
  load();
}

start();
