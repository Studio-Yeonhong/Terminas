# Terminas

**Terminas 는 종단간 암호화를 갖춘 팀용 SSH 관리 도구다.** 팀이 호스트·SSH 키·자격증명·스니펫·포트 포워딩 규칙을 공유 볼트에 두고, 터미널·SFTP·포트 포워딩을 한곳에서 연다. Termius 와 비슷한 쓰임새지만 직접 운영할 수 있고 소스가 공개되어 있다.

볼트 내용은 서버로 가기 전에 사용자 기기에서 암호화된다. 그래서 Terminas 서버(와 서버를 운영하는 사람)는 암호문만 가진다. **Windows 데스크톱 앱**은 사용자 PC 에서 서버로 직접 접속한다. **웹**은 브라우저 안에서 SSH 를 하고, Terminas 서버는 이미 SSH 로 암호화된 바이트만 전달한다. 서버·웹 화면·데스크톱 앱이 모두 이 저장소 하나에 있다.

[English README](README.md)

## 구조

```
데스크톱 앱 (Electron, 화면은 앱 안에) ─────────── SSH 직접 ───────────▶ 내 서버들
웹 브라우저 (SSH 를 브라우저 안에서)  ──wss──▶  Terminas 서버 /api/relay ──TCP──▶ 내 서버들
                                                (SSH 로 이미 암호화된 바이트만 옮긴다)

Terminas 서버 (server/: Node.js · Fastify · SQLite)
   로그인·팀·권한과 볼트 암호문만 보관한다 —
   비밀번호·키·호스트 주소를 풀 수 없다
   + 관리 콘솔은 따로 된 포트(127.0.0.1:5282)에서, 서버 PC 안에서만 열린다
```

두 클라이언트 모두 로그인과 암호화된 볼트 동기화를 위해 HTTPS 로 Terminas 서버와 통신한다. 데스크톱 앱은 화면 코드를 서버에서 받지 않는다.

## 기능

| | 웹 | 데스크톱 앱 (Windows) |
|---|:---:|:---:|
| 팀·초대·볼트별 권한·볼트 키 공유 | ✓ | ✓ |
| 호스트·그룹·계정 프리셋·스니펫·포워딩 규칙·알려진 호스트·기록, 태그 자동 완성 | ✓ | ✓ |
| SSH 키 가져오기 | ✓ | ✓ |
| SSH 키 새로 만들기 | Ed25519 | Ed25519·ECDSA·RSA |
| SSH 터미널 탭, Ctrl+K 호스트 검색, 호스트 키 확인 | ✓ (브라우저 SSH + 중계) | ✓ (PC 에서 직접) |
| 서버 OS 로고 (접속할 때 알아낸다) | ✓ | ✓ |
| SFTP: 서버 ↔ 서버, 편집, 권한, 끌어다 놓아 올리기, 내려받기 | ✓ (폴더째 받기는 크롬·엣지) | ✓ (+ 내 컴퓨터 창) |
| Google 또는 아이디·비밀번호 로그인, 2단계 인증(TOTP) | ✓ | ✓ |
| 로컬 터미널 (PowerShell·cmd·Git Bash·WSL) | | ✓ |
| 포트 포워딩 (내 PC 포트 → 호스트 → 대상) | | ✓ |
| HTTP 요청 (Postman 처럼: 모음·요청 탭·쿼리 파라미터 표·Bearer/Basic/API 키 인증·환경 변수·보낸 기록·curl/PowerShell/fetch/Python 코드로 복사) | | ✓ |
| 오프라인 사용: 서버 없이 볼트 열기 (개인 볼트는 고치기까지, 팀 볼트는 마지막 동기화부터 7일 동안 보기만), 개인 동기화 켜기·끄기 | | ✓ |

데스크톱 앱은 서버에 직접 붙으므로 각 PC 가 그 서버에 닿아야 한다(내부망 서버라면 그 PC 에 VPN 등이 필요하다). 웹은 Terminas 서버가 닿는 곳이면 된다.

서버 관리(사람·팀·서버 기록)는 웹과 데스크톱 앱에 없다. 서버가 따로 된 포트로 여는 **관리 콘솔**에서 하고, 이 콘솔은 서버 PC 안에서만(또는 SSH 터널로) 열린다. [docs/self-hosting.ko.md](docs/self-hosting.ko.md#관리-콘솔) 참고.

서버 OS 로고는 [Simple Icons](https://simpleicons.org/)(CC0)를 쓴다. 각 로고는 해당 회사·프로젝트의 상표이고, 호스트의 OS 를 보여 주는 데에만 쓴다.

## 보안 모델 요약

- **종단간 암호화 볼트.** 사람마다 기기 밖으로 나가지 않는 *암호화 비밀번호*를 정한다. 이 비밀번호가 계정 키를(argon2id), 계정 키가 X25519 키 쌍을, 키 쌍이 나에게 공유된 볼트 키를 푼다. 볼트 항목은 모두 AES-256-GCM 으로 암호화된다. 서버는 암호문과, 권한을 지키는 데 필요한 메타데이터만 가진다.
- **로그인과 암호화는 별개다.** Google 또는 아이디·비밀번호 로그인(원하면 TOTP 까지)은 누구인지를 확인할 뿐이다. 로그인 비밀번호는 서버가 보는 값이라 암호화 비밀번호와 달라야 한다. 서버는 절대 볼트를 열 수 없어야 하기 때문이다.
- **좁은 중계를 거치는 웹 SSH.** SSH 는 브라우저가 직접 한다. 중계는 상대가 SSH 인사말을 보내기 전에는 아무것도 넘기지 않으므로 DB·웹 서비스·서버 자신으로 가는 통로로 쓸 수 없다.
- **단단하게 만든 데스크톱 앱.** 화면은 서버에서 받지 않고 무결성 검사를 받는 앱 묶음 안에 들어 있다. Electron 퓨즈와 디버그 옵션 차단으로 코드 주입을 막고, 업데이트는 프로젝트의 Ed25519 서명이 있어야만 설치한다.
- **오프라인 사본도 암호문 그대로.** 서버에 닿지 않을 때도 쓰려고 데스크톱 앱은 받은 볼트 암호문을 Windows 보호 저장소(DPAPI)로 한 번 더 감싸 둔다. 팀 볼트는 마지막 동기화부터 7일 동안 오프라인에서 볼 수 있고, 로그아웃·권한이 끝났을 때·7일이 지나면 사본을 지운다.
- **관리 콘솔은 서버 PC 안에서만.** 클라이언트에는 관리 화면이 없고 공개 서버에는 관리 API 가 없다. 계정 관리는 `127.0.0.1` 에 묶인 따로 된 포트에서 하고, 서버 명령줄에서 정하는 자체 비밀번호(원하면 TOTP 까지)로 들어간다.

알려진 한계를 포함한 전체 설계는 [docs/security-model.md](docs/security-model.md)(영어)에 있다.

## 앱 받기

1. [GitHub Releases](https://github.com/Studio-Yeonhong/Terminas/releases)에서 Windows 설치 파일(`Terminas-Setup-x.y.z.exe`)을 받는다. 지금은 **공개 베타**(1.0.0-beta)이고, 베타 버전으로 설치한 앱은 베타 업데이트를 계속 받는다.
2. 실행한다. 설치 파일에는 아직 Windows 코드 서명이 없어서 처음 실행할 때 SmartScreen 경고가 뜰 수 있다(**추가 정보 → 실행**). 업데이트의 진위는 프로젝트 자체 서명으로 따로 확인한다.
3. 앱은 스스로 업데이트한다. 켜고 잠시 뒤와 그 뒤 4시간마다 확인하고, 새 버전을 뒤에서 받아 두었다가 **x.y.z 로 업데이트** 버튼을 띄운다. 눌러서 확인하기 전에는 설치하지 않는다. 새 기능을 먼저 써 보려면 **설정 → 계정 → 베타 버전 받기** 를 켠다(베타는 불안정할 수 있다).

앱을 처음 켜면 어느 서버에 연결할지 묻는다. **공식 서버**(`https://terminas.yeonhong.studio`, 미리 골라져 있다) 또는 **직접 운영하는 서버**(도메인이나 IP 주소를 넣는다). 나중에 로그인 화면의 서버 이름 옆 **바꾸기**, **도움말 → 서버 주소 바꾸기…**, 또는 **설정 → 계정 → 연결된 서버** 에서 바꿀 수 있다. 어느 서버를 쓰든 업데이트는 늘 GitHub Releases 에서 받고, 프로젝트의 Ed25519 서명이 있어야만 설치한다.

## 직접 운영하기 빠른 시작 (Docker)

```bash
git clone https://github.com/Studio-Yeonhong/Terminas.git terminas && cd terminas
cp .env.example .env
# .env 수정: SHELL_PUBLIC_URL=https://terminas.example.com 과 로그인 방법 —
#   Google (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SHELL_BOOTSTRAP_ADMINS) 또는
#   아이디·비밀번호 (SHELL_PASSWORD_LOGIN=1, SHELL_ADMIN_ID, SHELL_ADMIN_PASSWORD)
# 기본은 초대한 사람만. SHELL_OPEN_SIGNUP=1 이면 누구나 Google 로 가입한다.
docker compose up -d
# 127.0.0.1:5280 앞에 HTTPS 리버스 프록시를 두고, /api/relay 의 WebSocket 업그레이드를 통과시킨다.
# 관리 콘솔: 비밀번호를 정한 뒤 서버 PC 에서 http://127.0.0.1:5282/admin 을 연다
# (다른 곳에서는 ssh -L 5282:127.0.0.1:5282 user@server). 5282 포트는 절대 밖에 열지 않는다.
docker compose exec terminas node server/scripts/console-password.ts
```

준비물, 모든 설정, 리버스 프록시 예시, 백업, 업그레이드, 문제 해결은 [docs/self-hosting.ko.md](docs/self-hosting.ko.md)에 있다.

## 개발 빠른 시작

```bash
npm install
cp .env.example .env     # TEST_SSHD_PASSWORD, SHELL_BOOTSTRAP_ADMINS=<내 이메일>, SHELL_DEV_LOGIN=1 채우기
npm run dev              # API :5381 + 웹 화면 :5380 + 가짜 SSH 서버 127.0.0.1:2222
```

http://localhost:5380 을 열고 `SHELL_BOOTSTRAP_ADMINS` 의 이메일로 **개발용 로그인**을 한다. 저장소 구조, 점검, 번역 규칙, 배포 절차는 [docs/development.md](docs/development.md)(영어)에 있다.

## 화면 언어

화면은 한국어·English·日本語·简体中文·Español·Deutsch 로 쓸 수 있다. 로그인 화면이나 설정 맨 위에서 고르고, 처음에는 브라우저·OS 언어를 따른다. 원문은 한국어다. 서버 로그와 명령줄 메시지는 지금은 한국어로 나온다.

## 아직 없는 것

- 웹에서 포트 포워딩(브라우저는 로컬 포트를 열 수 없다), 웹에서 RSA·ECDSA 키 새로 만들기(가져오기는 된다)
- 점프 호스트(호스트 체이닝), 세션 녹화, 분할 화면·명령 동시 입력, 시리얼 연결
- 원격(`-R`)·동적 SOCKS(`-D`) 포워딩 — 지금은 로컬(`-L`)만
- 볼트 키 교체(누가 나간 뒤 새 키로 볼트를 다시 암호화), 호스트를 다른 볼트로 옮기기
- HTTP 도구: 파일 올리기(multipart), 쿠키 보관, 프록시, 보내기 전·시험 스크립트, 앱을 다시 켜도 남는 보낸 기록, WebSocket·gRPC
- macOS·Linux 데스크톱 앱(지금은 Windows 만 빌드하고 시험한다)

## 문서와 프로젝트 파일

- [docs/self-hosting.ko.md](docs/self-hosting.ko.md) — Terminas 서버 직접 운영하기 ([영어](docs/self-hosting.md))
- [docs/security-model.md](docs/security-model.md) — 암호화 설계와 알려진 한계 (영어)
- [docs/development.md](docs/development.md) — 코드 작업, 점검, 배포 (영어)
- [SECURITY.md](SECURITY.md) — 취약점을 비공개로 알리는 방법 (영어)
- [CONTRIBUTING.md](CONTRIBUTING.md) — 기여하는 방법 (영어)
- [README.md](README.md) — 영어 README

## 라이선스

Copyright (C) 2026 Studio Yeonhong.

Terminas 는 **GNU Affero General Public License v3.0 only**(SPDX: `AGPL-3.0-only`)를 따르는 자유 소프트웨어다. 전문은 [LICENSE](LICENSE)에 있다.

쉽게 말하면 Terminas 를 쓰고, 뜯어보고, 고치고, 나눌 수 있고, 고친 판도 같은 라이선스를 따른다. 배포할 때는 소스 코드도 제공해야 한다. **고친 판을 네트워크 서비스로 돌리면** 그 서비스를 쓰는 사람에게 해당 소스 코드를 받을 수 있게 해야 한다. 모든 Terminas 서버는 로그인 화면과 **설정 → 계정** 에 **소스 코드 (AGPL-3.0)** 링크를 보여 준다. 이 링크는 `SHELL_SOURCE_URL` 로 가고, 기본값은 공식 저장소(https://github.com/Studio-Yeonhong/Terminas)다. 서버를 고쳤다면 고친 소스를 받을 수 있는 곳으로 바꾼다([docs/self-hosting.ko.md](docs/self-hosting.ko.md#가입과-공개-링크) 참고).
