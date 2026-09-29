# Terminas 직접 운영하기

Terminas 서버를 직접 운영하는 방법을 다룬다. Docker 나 Node.js 로 설치하기, 모든 설정, 로그인 방법, 누구나 가입, 팀과 초대, 관리 콘솔, 한도, 2단계 인증, 백업, 업그레이드, 데스크톱 앱 연결까지.

[English](self-hosting.md)

## 차례

- [무엇을 돌리는가](#무엇을-돌리는가)
- [준비물](#준비물)
- [Docker 로 설치](#docker-로-설치)
- [리버스 프록시](#리버스-프록시)
- [Docker 없이 설치](#docker-없이-설치)
- [설정 목록](#설정-목록)
- [로그인 방법 고르기](#로그인-방법-고르기)
- [누구나 가입](#누구나-가입)
- [첫 서버 관리자](#첫-서버-관리자)
- [팀과 초대](#팀과-초대)
- [관리 콘솔](#관리-콘솔)
- [한도](#한도)
- [2단계 인증](#2단계-인증)
- [로그인 비밀번호 초기화](#로그인-비밀번호-초기화)
- [백업](#백업)
- [업그레이드](#업그레이드)
- [데스크톱 앱 연결](#데스크톱-앱-연결)
- [보안 참고](#보안-참고)
- [문제 해결](#문제-해결)

## 무엇을 돌리는가

Terminas 서버는 Node.js 프로세스 하나다. 이 프로세스가

- 웹 화면(`web/dist`)과 API(`/api/...`)를 내보내고,
- 로그인·팀·권한과 **암호화된** 볼트 데이터를 SQLite DB(`shell.db`)에 두고,
- 웹 SSH 를 WebSocket(`/api/relay`)으로 중계하고,
- 필요하면 `<data>/updates` 의 데스크톱 앱 업데이트 파일을 `/updates/` 로 내보내고(데스크톱 앱을 직접 빌드해 배포할 때만 쓴다),
- 사람·팀·서버 기록을 다루는 **관리 콘솔**을 따로 된 포트(`127.0.0.1:5282`)로 연다. 서버 PC 안에서만 닿는다([관리 콘솔](#관리-콘솔) 참고).

서버는 볼트 내용을 평문으로 볼 수 없다. 서버가 무엇을 알고 무엇을 모르는지는 [security-model.md](security-model.md)(영어)에 있다.

## 준비물

- **Docker**(Compose 포함) **또는** **Node.js 24 이상**(서버가 내장 `node:sqlite` 모듈을 쓰고 TypeScript 를 바로 실행한다).
- **HTTPS 가 되는 도메인.** 브라우저는 웹 화면이 쓰는 Web Crypto API 를 HTTPS(또는 `localhost`)에서만 허락한다. 로그인 정보도 평문으로 오가면 안 된다.
- TLS 를 처리하고 `/api/relay` 의 **WebSocket 업그레이드**를 통과시키는 **리버스 프록시**(Caddy, nginx, Traefik, 터널 서비스 등).
- 네트워크: **웹에서** 여는 SSH 서버에는 Terminas 서버가 닿아야 한다. 데스크톱 앱은 각 사용자 PC 에서 직접 접속한다.

## Docker 로 설치

```bash
git clone https://github.com/Studio-Yeonhong/Terminas.git terminas
cd terminas
cp .env.example .env
```

`.env` 를 고친다:

```dotenv
SHELL_PUBLIC_URL=https://terminas.example.com

# 로그인 방법을 하나 이상 고른다 ("로그인 방법 고르기" 참고)
# Google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
SHELL_BOOTSTRAP_ADMINS=you@example.com
# 그리고/또는 아이디 + 비밀번호
SHELL_PASSWORD_LOGIN=1
SHELL_ADMIN_ID=admin
SHELL_ADMIN_PASSWORD=a-long-one-time-password
```

띄운다:

```bash
docker compose up -d
docker compose logs -f terminas
```

`docker-compose.yml` 과 `Dockerfile` 이 정하는 것:

| 항목 | 값 |
|---|---|
| 이미지 | 이 저장소에서 직접 빌드한다(`docker compose up -d` 가 처음에 빌드한다). 서버와 빌드된 웹 화면이 들어 있고, 데스크톱 앱은 따로 빌드한다. |
| 포트 | 컨테이너 안에서 **5280** 을 듣는다. Compose 는 이것을 **`127.0.0.1:5280`** 에만 연다. 같은 기계의 리버스 프록시만 닿을 수 있다. |
| 관리 콘솔 포트 | [관리 콘솔](#관리-콘솔)은 컨테이너 안에서 **5282** 를 듣는다. Compose 는 이것을 호스트의 **`127.0.0.1:5282`** 에만 연다. 그래서 서버 PC 안에서만(또는 SSH 터널로) 열린다. 다른 곳에 절대 열지 않는다. |
| 데이터 | 이름 있는 볼륨 `terminas-data` 를 **`/data`** 에 붙인다(DB, `totp.key`, `updates/`). |
| 고정 설정 | Compose 가 `SHELL_HOST=0.0.0.0`, `SHELL_PORT=5280`, `SHELL_DATA_DIR=/data`, `SHELL_TRUST_PROXY=1`, `SHELL_CONSOLE_HOST=0.0.0.0`, `SHELL_CONSOLE_PORT=5282` 를 정한다(`.env` 보다 우선). 이미지는 `NODE_ENV=production` 을 정한다. |
| 사용자 | 권한 없는 `node` 사용자로 돈다. |
| 상태 확인 | 30초마다 `GET /api/auth/config`. |

그다음 [리버스 프록시](#리버스-프록시)를 설정하고 `https://terminas.example.com` 을 연 뒤 [첫 서버 관리자](#첫-서버-관리자)로 넘어간다. [관리 콘솔](#관리-콘솔) 비밀번호도 정한다.

## 리버스 프록시

프록시가 할 일:

- `SHELL_PUBLIC_URL` 의 도메인으로 HTTPS 를 받는다,
- 모든 요청을 원래 `Host` 헤더 그대로 `127.0.0.1:5280` 으로 넘긴다,
- **WebSocket 업그레이드**를 통과시킨다(웹 SSH 의 `/api/relay`),
- `X-Forwarded-For` 를 붙인다(`SHELL_TRUST_PROXY=1` 이라 서버가 이 값을 믿는다).

프록시는 공개 포트(5280)만 넘긴다. **관리 콘솔 포트(5282)는 절대 프록시로 넘기지 않는다.** 콘솔은 서버 PC 안에서만 닿게 만든 것이다([관리 콘솔](#관리-콘솔) 참고).

서버가 중계 WebSocket 마다 30초에 한 번 핑을 보내므로 보통의 유휴 시간 제한(60초 이상)이면 끊기지 않는다.

**Caddy** (인증서와 WebSocket 을 알아서 처리한다):

```caddyfile
terminas.example.com {
    reverse_proxy 127.0.0.1:5280
}
```

**nginx**:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name terminas.example.com;

    ssl_certificate     /etc/letsencrypt/live/terminas.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/terminas.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5280;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 300s;
    }
}
```

밖에서 확인한다:

```bash
curl -fsS https://terminas.example.com/api/auth/config
# {"google":true,"devLogin":false,"password":true,"openSignup":false,
#  "links":{"terms":"","privacy":"","source":"https://github.com/Studio-Yeonhong/Terminas"},"api":1,"minAppApi":1}
```

## Docker 없이 설치

```bash
git clone https://github.com/Studio-Yeonhong/Terminas.git /opt/terminas
cd /opt/terminas
npm ci            # 데스크톱 앱용 Electron 까지 모든 워크스페이스를 설치한다
npm run build     # 웹 화면을 web/dist 로 빌드한다
cp .env.example .env
```

`npm ci` 는 서버에 필요 없는 Electron 도 받는다. 건너뛰고 싶으면 `Dockerfile` 처럼 `server`·`web` 워크스페이스만 설치하면 된다.

`.env` 는 Docker 때처럼 고치고, 서버가 들을 주소도 정한다(기본값은 로컬 개발용이다):

```dotenv
SHELL_PUBLIC_URL=https://terminas.example.com
SHELL_HOST=127.0.0.1
SHELL_PORT=5280
SHELL_TRUST_PROXY=1
SHELL_DATA_DIR=data
# 비워 두면 표준 출력으로 남긴다
SHELL_LOG_FILE=data/logs/terminas.log
```

[관리 콘솔](#관리-콘솔)은 기본으로 `127.0.0.1:5282` 에서 열린다(`SHELL_CONSOLE_HOST`, `SHELL_CONSOLE_PORT`). `127.0.0.1` 그대로 둔다.

서버는 늘 **`NODE_ENV=production`** 으로 돌린다. 그래야 개발용 로그인이 켜져 있으면 서버가 뜨지 않는다. 중계의 차단 목록(웹 SSH 로 서버 자신의 루프백·인터페이스 주소에 못 들어간다)은 `SHELL_PUBLIC_URL` 이 localhost 가 아니면 늘 켜져 있고, 로컬 개발(localhost 주소이고 `NODE_ENV=production` 이 아님)일 때만 풀린다.

먼저 앞에서 한 번 띄워 확인한다:

```bash
NODE_ENV=production npm start
```

`npm start` 는 `server/` 에서 `node --env-file-if-exists=../.env src/index.ts` 를 돌린다. `SHELL_DATA_DIR`·`SHELL_LOG_FILE` 의 상대 경로는 작업 폴더가 아니라 **저장소 루트** 기준이다.

systemd 유닛(`/etc/systemd/system/terminas.service`):

```ini
[Unit]
Description=Terminas server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=terminas
WorkingDirectory=/opt/terminas/server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --env-file=/opt/terminas/.env src/index.ts
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`node` 가 `/usr/bin/node` 가 아니면 경로를 바꾼다(`which node`).

```bash
sudo useradd --system --home /opt/terminas terminas
sudo mkdir -p /opt/terminas/data
sudo chown -R terminas:terminas /opt/terminas/data
sudo chown terminas:terminas /opt/terminas/.env
sudo chmod 600 /opt/terminas/.env
sudo systemctl daemon-reload
sudo systemctl enable --now terminas
journalctl -u terminas -f
```

## 설정 목록

설정은 모두 환경변수이고 보통 `.env` 에 둔다(`.env.example` 참고). Docker 에서는 Compose 가 `env_file` 로 `.env` 를 읽는다.

### 주소

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `SHELL_PUBLIC_URL` | `http://localhost:5380` | 사람들이 브라우저에서 여는 주소. 운영에서는 `https://...`. https 면 세션 쿠키에 `Secure` 가 붙고 HSTS 를 보낸다. API 요청과 중계 WebSocket 은 이 출처에서 와야 하고, Google redirect URI 는 `<SHELL_PUBLIC_URL>/api/auth/google/callback` 이다. 사용자가 여는 주소와 정확히 같아야 한다(스킴·호스트·포트). |
| `SHELL_HOST` | `127.0.0.1` | 들을 인터페이스. Docker: 컨테이너 안에서 `0.0.0.0` 고정. |
| `SHELL_PORT` | `5381` | 들을 포트. Docker: `5280` 고정. |
| `SHELL_TRUST_PROXY` | `0` | 앞에 리버스 프록시·터널이 있을 때만 `1`. 그러면 같은 PC·사설망에 있는 프록시(루프백, 링크 로컬, `10/8`, `172.16/12`, `192.168/16`, `fc00::/7`)만 믿고, 그런 프록시가 붙인 `X-Forwarded-For` 의 맨 오른쪽 주소를 접속 IP 로 쓴다 — 사용자가 헤더에 직접 적어 넣은 주소는 무시한다. 프록시 주소·CIDR 을 쉼표로 적어도 된다. Docker: `1` 고정(포트를 `127.0.0.1` 에만 열기 때문). |
| `SHELL_RELAY_PRIVATE` | `all`, 누구나 가입이면 `admins` | 서버 둘레 사설망 주소(`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `198.18/15`, `fc00::/7`)로 **웹** SSH 를 열 수 있는 사람: `all`(누구나), `admins`(서버 관리자만), `none`(아무도). 데스크톱 앱은 직접 접속하므로 상관없다. |

### 로그인: Google

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | 비어 있음 | "웹 애플리케이션" 종류의 OAuth 클라이언트 ID. Google 값 둘을 비우면 Google 로그인이 꺼진다. |
| `GOOGLE_CLIENT_SECRET` | 비어 있음 | OAuth 클라이언트 보안 비밀. |
| `SHELL_BOOTSTRAP_ADMINS` | 비어 있음 | 쉼표로 나눈 이메일. **초대 없이** Google 로 들어올 수 있고 **서버 관리자**가 된다(팀을 만들 수 있다). |

### 로그인: 아이디·비밀번호

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `SHELL_PASSWORD_LOGIN` | `0` | `1` 이면 아이디·비밀번호 로그인을 보여 준다. 팀 초대 때 일회용 초대 코드가 나오고, 초대받은 사람이 그 코드로 자기 비밀번호를 정한다. |
| `SHELL_ADMIN_ID` | 비어 있음 | 첫 서버 관리자. 그 계정에 아직 비밀번호가 없으면 켤 때 만든다. 이메일이거나 `a-z 0-9 . _ -` 로 된 3~64자. `SHELL_PASSWORD_LOGIN=1` 이 필요하다. |
| `SHELL_ADMIN_PASSWORD` | 비어 있음 | 그 관리자의 비밀번호(10자 이상). 계정에 비밀번호가 없을 때만 쓰인다. **처음 켠 뒤 `.env` 에서 지운다.** |

### 가입과 공개 링크

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `SHELL_AUDIT_RETENTION_DAYS` | `365` | 이 날수보다 오래된 기록을 지운다(6시간마다 확인). `0` 이면 지우지 않는다. |
| `SHELL_OPEN_SIGNUP` | `0` | `1` 이면 누구나 초대 없이 Google(확인된 이메일)로 가입한다. 팀이 없는 사람도 개인 볼트를 쓰고, 누구나 팀을 만든다. `0` 이면 초대한 사람만 들어온다. 아이디·비밀번호로 스스로 가입하는 방법은 없다. [누구나 가입](#누구나-가입) 참고. |
| `SHELL_TERMS_URL` | 비어 있음 | 이용약관 주소. 넣으면 로그인 화면과 **설정 → 계정** 에 링크로 나온다. |
| `SHELL_PRIVACY_URL` | 비어 있음 | 개인정보처리방침 주소. 같은 곳에 나온다. |
| `SHELL_SOURCE_URL` | `https://github.com/Studio-Yeonhong/Terminas` | 로그인 화면과 **설정 → 계정** 의 **소스 코드 (AGPL-3.0)** 링크가 가는 곳. Terminas 는 AGPL-3.0 라이선스라, 서버를 고쳐서 돌리면 사용자가 고친 소스를 받을 수 있는 곳으로 바꾼다. |

`SHELL_TERMS_URL`·`SHELL_PRIVACY_URL`·`SHELL_SOURCE_URL`·`SHELL_APP_DOWNLOAD_URL` 은 `http://` 나 `https://` 주소여야 한다. 아니면 서버가 뜨지 않는다. 빈 값(예: `SHELL_SOURCE_URL=`)은 "기본값을 쓴다"는 뜻이다. 소스 코드 링크는 AGPL-3.0 의무라 끌 수 없다.

### 관리 콘솔 설정

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `SHELL_CONSOLE_PORT` | `5282` | 사람·팀·서버 기록을 다루는 [관리 콘솔](#관리-콘솔)의 포트. 공개 서버와 따로 듣는다. `0` 이면 콘솔을 끈다. 0~65535 사이의 정수가 아니면 서버가 뜨지 않는다. Docker: 컨테이너 안에서 `5282` 고정(끄려면 `docker-compose.yml` 에서 `0` 으로 바꾸고 `127.0.0.1:5282:5282` 포트 줄을 지운다). |
| `SHELL_CONSOLE_HOST` | `127.0.0.1` | 콘솔이 들을 인터페이스. `127.0.0.1`(또는 `::1`)로 둔다. 다른 값이면 서버가 로그에 경고를 남긴다. Docker: 컨테이너 안에서 `0.0.0.0` 고정이고, Compose 가 호스트의 `127.0.0.1` 에만 연다. |

콘솔 비밀번호는 환경변수가 아니다. DB 에 두고 `npm run console:password -w server` 로 정한다([관리 콘솔](#관리-콘솔) 참고).

### 데이터

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `SHELL_DATA_DIR` | `data` | `shell.db`(와 `-wal`·`-shm` 파일), `totp.key`, `updates/` 가 들어간다. 폴더를 통째로 백업한다. Docker: `/data` 고정. |
| `SHELL_LOG_FILE` | 비어 있음 | 비우면 콘솔로 남긴다. 파일 경로를 주면 거기에 남기고 요청마다 남기는 로그는 끈다(누가 무엇을 했는지는 화면의 **기록**에 있다). |
| `SHELL_TOTP_KEY` | 없음 | 2단계 인증(TOTP) 비밀값을 봉하는 32바이트 base64 키(선택). 없으면 처음 쓸 때 `<data>/totp.key` 를 만든다. `openssl rand -base64 32` 로 만들 수 있다. |

### 데스크톱 앱 내려받기

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `SHELL_APP_DOWNLOAD_URL` | `https://github.com/Studio-Yeonhong/Terminas/releases/latest` | 이 서버의 `<data>/updates` 에 설치 파일이 없을 때 웹 로그인 화면과 설정의 **Windows 앱 받기** 링크가 가는 곳. 기본값(빈 값일 때도)은 공식 배포 페이지다. |

### 개발 전용

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `SHELL_DEV_LOGIN` | `0` | 이메일만으로 로그인. `SHELL_PUBLIC_URL` 이 localhost 이고 `NODE_ENV` 가 `production` 이 아닐 때가 아니면 `1` 로는 서버가 뜨지 않는다. `0` 으로 둔다. |
| `TEST_SSHD_PORT`, `TEST_SSHD_USER`, `TEST_SSHD_PASSWORD`, `TEST_SSHD_OTP` | `2222`, `demo`, 비어 있음, 비어 있음 | 개발용 가짜 SSH 서버(`npm run dev:sshd`). |
| `TEST_VAULT_PASSWORD` | 비어 있음 | 자동 화면 시험에 쓰는 암호화 비밀번호. |

### 그 밖의 변수

| 변수 | 뜻 |
|---|---|
| `NODE_ENV` | 실제 서버에서는 `production`(Docker 이미지는 이미 그렇다). |
| `SHELL_UPDATES_DIR` | 데스크톱 앱 업데이트 파일을 `/updates/` 로 내보낼 폴더. 기본 `<SHELL_DATA_DIR>/updates`. |
| `LOG_LEVEL` | 로그 수준(기본 `info`). |
| `SHELL_EXIT_WITH_PARENT` | `1` 이면 부모 프로세스가 끝날 때 서버도 끝난다. 다른 프로세스가 감싸서 띄울 때 쓴다. |

서버는 켤 때 몇 가지 조합을 확인하고, 틀리면 뜨지 않는다([문제 해결](#문제-해결) 참고).

## 로그인 방법 고르기

| 구성 | 어울리는 곳 | 설정할 것 |
|---|---|---|
| Google 만 | 이미 Google 계정(Workspace 나 개인 Gmail)을 쓰는 팀 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SHELL_BOOTSTRAP_ADMINS` |
| 아이디·비밀번호만 | 외부 인증 서비스 없이 운영하는 서버, 인터넷이 막힌 곳·내부망 | `SHELL_PASSWORD_LOGIN=1`, `SHELL_ADMIN_ID`, `SHELL_ADMIN_PASSWORD` |
| 둘 다 | 섞인 팀 | 위 전부 |

둘 다 없으면 로그인 화면에 로그인 방법이 아직 설정되지 않았다고 나온다.

둘 다 켜면 아이디가 이메일인 계정은 어느 쪽으로든 들어온다. 기본으로는 어느 방법이든 초대받은 사람(과 서버 관리자)만 들어올 수 있다. 누구나 Google 로 가입하게 하려면 [누구나 가입](#누구나-가입)을 본다.

### Google 로그인 설정

1. [Google Cloud 콘솔](https://console.cloud.google.com)에서 프로젝트를 고른다.
2. **APIs & Services → OAuth consent screen**: User type 은 **External**(개인 Gmail 팀원도 들어오게), 앱 이름과 지원 이메일을 넣는다. Terminas 는 `openid`·`email`·`profile` 범위만 쓰므로 Google 검수가 필요 없다.
   게시 상태가 **Testing** 이면 거기 적은 테스트 사용자만 로그인할 수 있다(추가 문지기로 써도 된다). 초대한 누구나 받으려면(또는 [누구나 가입](#누구나-가입)을 켜서 아무나 받으려면) **In production** 으로 게시한다.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorized redirect URI: `https://terminas.example.com/api/auth/google/callback`(`SHELL_PUBLIC_URL` + `/api/auth/google/callback`). 로컬 시험용으로 `http://localhost:5380/api/auth/google/callback` 도 넣을 수 있다.
4. 나온 클라이언트 ID 와 보안 비밀을 `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET` 에 넣고 다시 켠다.

데스크톱 앱은 따로 설정할 것이 없다. 앱이 시스템 브라우저로 같은 Google 로그인을 열고, 서버가 일회용 코드를 앱(`127.0.0.1` 임시 포트)으로 넘기면 앱이 그 코드를 세션 토큰으로 바꾼다. PKCE 로 묶여 있어 코드만 가로채서는 못 쓴다.

Google 로그인은 Google 이 확인한 이메일만 받는다.

### 아이디·비밀번호 로그인

`SHELL_PASSWORD_LOGIN=1` 로 켠다. 그러면

- 비밀번호는 **scrypt** 해시로만 둔다.
- 로그인 비밀번호는 10~200자. 앞뒤 공백도 비밀번호의 일부다.
- **15분 안에 한 아이디로 10번**, 또는 **한 IP 에서 50번** 틀리면 그 15분이 끝날 때까지 막는다.
- 틀린 비밀번호와 없는 아이디는 같은 오류("아이디 또는 비밀번호가 맞지 않습니다")를 같은 시간에 돌려준다. 있는 아이디인지 알아낼 수 없다.
- 비밀번호로 들어와도 2단계 인증은 그대로 적용된다.
- 로그인 비밀번호는 **암호화 비밀번호와 달라야 한다.** 서버는 로그인 비밀번호를 보므로, 둘이 같으면 서버가 그 사람의 볼트를 열 수 있게 된다. 화면은 확인할 수 있는 곳에서 같은 값을 거절한다.

로그인 비밀번호는 **설정 → 계정 → 로그인 비밀번호** 에서 정하거나 바꾼다.

- 처음 정할 때(예: 지금까지 Google 로만 들어오던 사람)는 로그인한 지 10분 안이어야 한다. 필요하면 로그아웃했다가 다시 들어온다.
- 바꿀 때는 지금 로그인 비밀번호가 필요하다.
- 어느 쪽이든 그 사람의 다른 로그인은 끊는다.

## 누구나 가입

Terminas 서버는 기본으로 **초대한 사람만** 들어온다. 초대받은 사람과 서버 관리자만 로그인할 수 있다. `SHELL_OPEN_SIGNUP=1` 로 켜면 공개 서비스로 돌릴 수 있다.

- **누구나 초대 없이 Google 로 로그인한다.** 늘 그렇듯 Google 이 확인한 이메일만 받고, 그 이메일로 받아 둔 초대는 로그인할 때 수락된다.
- **팀이 없어도 개인 볼트로 Terminas 를 쓴다.** 마지막 팀에서 나가거나 빠져도 로그인이 막히지 않는다.
- **누구나 팀을 만든다.** 서버 관리자는 제한이 없고, 나머지는 한 사람이 팀을 20개까지 가질 수 있다([한도](#한도) 참고).
- 로그인 화면에 Google 계정으로 누구나 가입할 수 있다고 나온다.

**아이디·비밀번호로 스스로 가입하는 방법은 없다.** 서버는 입력 칸에 적은 이메일이 그 사람 것인지 확인할 수 없고, 스스로 등록한 주소가 다른 사람에게 온 팀 초대를 가로챌 수 있기 때문이다. 아이디·비밀번호 로그인 서버에서는 여전히 [초대 코드](#초대하기)로 들어온다. 그런 서버에서 `SHELL_OPEN_SIGNUP=1` 은 이미 있는 계정이 팀 없이도 로그인하고 팀을 만들 수 있다는 뜻일 뿐이다.

누구나 가입은 암호화를 바꾸지 않는다. 새 계정은 모두 자기 키를 만들고, 팀원이 볼트 키를 건네기 전에는 누구도 팀 볼트를 읽을 수 없다([security-model.md](security-model.md#open-sign-up), 영어).

공개로 열기 전에:

- **Google OAuth 동의 화면을 게시한다**(**In production**, [Google 로그인 설정](#google-로그인-설정) 참고). **Testing** 이면 거기 적은 테스트 사용자만 로그인한다.
- **이용약관과 개인정보처리방침을 게시하고** `SHELL_TERMS_URL`·`SHELL_PRIVACY_URL` 에 넣는다. 로그인 화면과 **설정 → 계정** 에 링크로 나온다.
- **중계가 닿는 범위를 생각한다.** 로그인한 사람은 누구나 서버가 닿고 SSH 인사말로 답하는 어느 주소로든 웹 SSH 를 열 수 있다. 누구나 가입 서버에서는 서버 둘레 사설망 주소가 기본으로 서버 관리자만 된다(`SHELL_RELAY_PRIVATE=admins`, [보안 참고](#보안-참고)).
- 서버 코드를 고쳤다면 `SHELL_SOURCE_URL` 을 고친 소스로 바꾼다([라이선스](../README.ko.md#라이선스)).

## 첫 서버 관리자

**서버 관리자**는 팀을 제한 없이 만들 수 있고, 팀에 속하지 않아도 로그인할 수 있다. 이 역할이 하는 일은 이것뿐이고, 웹이나 데스크톱 앱에 관리 화면이 생기지 않는다. 사람·팀 관리는 서버 PC 에 따로 있는 [관리 콘솔](#관리-콘솔)에서 자체 비밀번호로 한다. 서버 관리자라고 볼트 내용을 볼 수 있는 것은 **아니다**.

**Google:** 내 이메일을 `SHELL_BOOTSTRAP_ADMINS` 에 넣고 다시 켠 뒤 **Google로 계속하기** 를 누른다.

**아이디·비밀번호:** `SHELL_ADMIN_ID` 와 `SHELL_ADMIN_PASSWORD` 를 넣고 서버를 켠다. 로그에 관리자 비밀번호를 정했다고 나온다. 그다음 **`.env` 에서 `SHELL_ADMIN_PASSWORD` 를 지운다.** 계정에 비밀번호가 없을 때만 쓰이므로 다시 적용되지는 않지만, 디스크에 남겨 둘 이유가 없다. 명령줄로 만들 수도 있다:

```bash
npm run user:password -w server -- admin --create-admin
# Docker:
docker compose exec terminas node server/scripts/user-password.ts admin --create-admin
```

처음 로그인한 뒤:

1. **암호화 비밀번호**(어떤 로그인 비밀번호와도 다르게)를 만들고, 화면에 나오는 **복구 키**를 보관한다. 복구 키는 한 번만 보여 준다.
2. **설정 → 팀 만들기** 를 연다. 팀에는 "Team" 이라는 기본 볼트가 생긴다.
3. 사람들을 초대한다(다음 절).
4. 나중에 사람·팀을 관리할 수 있게 서버에서 [관리 콘솔](#관리-콘솔) 비밀번호를 정한다.

## 팀과 초대

### 역할

| 역할 | 할 수 있는 것 |
|---|---|
| 소유자 | 팀의 모든 것: 모든 팀 볼트 편집, 관리자·멤버 초대, 역할 변경, 팀 삭제. 팀을 만든 사람이 소유자가 된다. |
| 관리자 | 모든 팀 볼트 편집, 멤버 초대, 볼트 권한 관리. |
| 멤버 | 볼트마다 받은 권한만: `edit` 또는 `view`. 새 멤버는 기본 "Team" 볼트를 **보기**로 받는다. |

모든 사람에게는 자기만 여는 **개인(Personal) 볼트**도 하나씩 있다. 서버는 내용을 못 보지만 누가 쓸 수 있는지는 검사한다.

### 초대하기

**설정 → (팀) → 초대** 에서 이메일과 역할을 넣고 **초대** 를 누른다. 관리자 초대는 소유자만 할 수 있다.

- **묻지 않고 넣지 않는다.** 초대는 대기로 남는다. 초대받은 사람이 로그인하면 볼트 화면 위쪽 줄에서 보고 수락하거나 거절한다. 그 이메일에 계정이 있든 없든 초대한 사람이 받는 답은 같다.
- **Google 로그인:** 초대받아야만 들어오는 서버에서 처음 로그인하는 사람은 초대한 팀에 바로 들어간다(초대 덕분에 들어온 것이라). 그 밖의 사람 — 이미 계정이 있는 사람, [누구나 가입](#누구나-가입) 서버의 새 계정 — 은 앱에서 수락한다.
- **아이디·비밀번호 로그인:** **일회용 초대 코드**(`XXXX-XXXX-XXXX`)와 기한이 나온다. 믿을 수 있는 경로로 그 사람에게 전한다. 아이디·비밀번호로 로그인하는 사람은 가입할 때도, 다른 팀 초대를 수락할 때도 이 코드가 필요하다(이메일을 확인한 적이 없는 계정이라서).
  - 코드는 **7일** 동안 쓸 수 있고 **한 번만** 보여 준다. 서버에는 해시만 남는다.
  - 잃어버렸거나 기한이 지났으면 대기 중인 초대 옆의 **초대 코드 새로 만들기** 를 누른다. 예전 코드는 더는 쓸 수 없다.
  - 대기 중인 초대는 언제든 취소할 수 있다.

초대받은 사람은 로그인 화면에서 **초대 코드를 받았나요? 가입하기** 를 누르고, 초대받은 이메일, 코드, 이름(선택), 로그인 비밀번호(10자 이상)를 넣는다. 그러면 로그인되고 팀에 들어간다. 두 방법을 다 켠 서버라면 초대받은 이메일의 Google 계정으로 로그인해도 된다 — 다만 아이디·비밀번호로 만든 계정은 나중에 Google 에 연결되지 않으니(같은 이메일의 Google 로그인은 거절된다) 사람마다 한 가지 방법을 고른다. `SHELL_BOOTSTRAP_ADMINS`·`SHELL_ADMIN_ID` 의 계정은 초대 코드로 만들 수 없다. 초대는 한 사람이 하루 100개까지 보낼 수 있다.

### 볼트 키 건네기

팀에 들어왔다고 볼트를 읽을 수 있는 것은 아니다. 새 팀원이 암호화 비밀번호를 정하면, 팀 소유자·관리자가 앱이나 웹을 열 때 **팀원 N명이 볼트 키를 기다립니다** 가 뜬다. 그 사람의 이메일과 **키 지문**을 확인하고(지문은 그 사람과 말로 또는 직접 대조하는 것이 가장 확실하다) 확인을 누르면, 내 클라이언트가 볼트 키를 내 키로 그 사람의 공개키에 봉해 올린다 — 그래서 받는 쪽 앱은 내가 준 키임을 안다. 이 기기에서 전에 본 사람만 기본으로 체크하고, 처음 보는 사람은 지문을 확인한 뒤 직접 체크한다. 이 기기에서 전에 본 팀원 키와 다르면 "키가 바뀜" 으로 표시한다.

0.3.2 까지의 앱이 공유한 볼트 키에는 누가 봉했는지가 없다. 그 키를 전에 연 기기의 앱은 그냥 자기 키로 다시 봉해 두고, 한 번도 본 적 없는 기기에서는 볼트를 열기 전에 묻는다. 공유받은 적 없는 볼트에서 이 질문이 나오면 열지 말고 팀 관리자에게 알린다.

### 내보내기와 팀 삭제

- 팀에서 내보내거나 볼트 권한을 빼면 서버에 있는 그 사람의 볼트 키 사본을 지운다. 이미 비밀을 봤을 수 있으니 **그 사람이 볼 수 있던 서버 비밀번호·키는 바꾼다.**
- 팀 삭제는 팀 소유자만, 팀 이름을 그대로 적어야 한다. 팀 볼트와 그 안의 항목·볼트 키, 팀원 관계, 초대가 지워지고 기록은 남는다.
- 소속 팀이 하나도 없는 사람은 로그인할 수 없다. 서버 관리자와 [누구나 가입](#누구나-가입) 서버의 사람은 예외다.

## 관리 콘솔

사람·팀·서버 기록은 **관리 콘솔**에서 관리한다. 서버 프로세스가 따로 된 포트로 여는 작은 웹 페이지이고, 기본 주소는 `http://127.0.0.1:5282/admin` 이다. 웹 화면이나 데스크톱 앱의 일부가 아니고, 공개 서버(리버스 프록시 뒤의 5280 포트)에는 관리 API 가 아예 없다. 콘솔은 서버 PC 안에서만 답한다.

콘솔에는 서버 명령줄에서 정하는 자체 비밀번호가 있다. 사람들의 계정·Google 로그인과는 별개다. [서버 관리자](#첫-서버-관리자)라도 자기 Terminas 계정으로 콘솔에 들어가지 못하고, 콘솔 비밀번호로 Terminas 에 로그인할 수도 없다.

**관리자도 여기서 볼트 내용은 볼 수 없다.** 계정 정보와 시각·개수만 다룬다.

### 콘솔 비밀번호 정하기

서버에서, 저장소 폴더에서 돌린다(서버와 같은 `.env` 를 읽는다):

```bash
npm run console:password -w server              # 비밀번호 정하기·바꾸기 (화면에 보이지 않게 두 번 묻는다)
npm run console:password -w server -- --otp     # TOTP 코드도 요구하기
npm run console:password -w server -- --no-otp  # TOTP 코드 요구 끄기
npm run console:password -w server -- --off     # 비밀번호 지우기: 아무도 콘솔에 로그인할 수 없다
# Docker:
docker compose exec terminas node server/scripts/console-password.ts [--otp|--no-otp|--off]
```

- 비밀번호는 로그인 비밀번호처럼 10~200자다. DB 에는 scrypt 해시로만 둔다.
- `--otp` 는 비밀번호를 먼저 정해야 쓸 수 있다. 인증 앱(Google Authenticator, 1Password, Authy 등)에 등록할 키(와 `otpauth://` 주소)를 보여 주고, 확인을 위해 앱의 지금 코드를 묻는다. 다시 돌리면 키를 새로 만든다. 비밀값은 모두의 2단계 인증 비밀값과 같은 서버 키(`SHELL_TOTP_KEY` 또는 `<data>/totp.key`)로 봉한다.
- 비밀번호나 OTP 설정을 바꾸면 열려 있던 콘솔 로그인은 모두 끊긴다. 서버를 다시 켤 필요는 없다.
- 비밀번호를 정하기 전에는 아무도 로그인할 수 없고, 콘솔은 비밀번호를 정하는 방법만 보여 준다.

### 콘솔 열기

서버 PC 에서(또는 원격 데스크톱으로) `http://127.0.0.1:5282/admin` 을 연다. 다른 컴퓨터에서는 SSH 로 포트를 넘겨 받아 그 컴퓨터에서 같은 주소를 연다:

```bash
ssh -L 5282:127.0.0.1:5282 user@server
# 그다음 이 컴퓨터에서 http://127.0.0.1:5282/admin 을 연다
```

콘솔 비밀번호(켰다면 TOTP 코드까지)로 로그인한다.

- 콘솔 로그인은 8시간 동안 이어지고 메모리에만 있다. 서버를 다시 켜면 다시 로그인해야 한다.
- 15분 안에 5번 틀리면 그 15분이 끝날 때까지 맞는 비밀번호로도 들어갈 수 없다.
- 화면은 브라우저 언어에 따라 한국어나 영어로 나온다.

**콘솔 포트를 인터넷에 열거나 공개 리버스 프록시로 넘기지 않는다.** Docker 라면 `docker-compose.yml` 이 호스트의 `127.0.0.1:5282` 에만 연다. Docker 없이 돌리면 `SHELL_CONSOLE_HOST=127.0.0.1` 로 둔다. `SHELL_CONSOLE_PORT=0` 이면 콘솔이 아예 꺼진다([관리 콘솔 설정](#관리-콘솔-설정) 참고). 콘솔은 `127.0.0.1`·`localhost`·`[::1]` 가 아닌 이름으로 부른 요청도 거절한다. 콘솔을 지키는 장치는 [security-model.md](security-model.md#admin-console)(영어)에 모두 있다.

### 개요

가입한 사람, 7일 동안 새로 가입, 7일·30일 동안 로그인, 막힌 계정, 팀, 볼트, 볼트 항목, 살아 있는 로그인 수와, 서버 방식 배지(누구나 가입 또는 초대한 사람만, Google, 아이디·비밀번호)를 보여 준다.

### 사용자

최근 가입 순으로 100명씩 보여 준다. 이메일·이름으로 찾고, 모두·서버 관리자·막힌 계정·암호화 설정 전으로 거른다. 줄마다 가입일, 마지막 로그인, 팀 수와 배지(서버 관리자, 막힘, 2단계, 암호화 설정 전, Google, 비밀번호)가 나오고, 다음 작업을 할 수 있다:

| 동작 | 하는 일 |
|---|---|
| 막기 / 풀기 | 막힌 계정은 로그인할 수 없다. 막으면 그 사람을 모든 기기에서 로그아웃시키고 열려 있던 웹 SSH 도 끊는다. |
| 관리자로 / 관리자 해제 | [서버 관리자](#첫-서버-관리자)(팀을 제한 없이 만들고, 팀 없이도 로그인)로 만들거나 뺀다. |
| 모든 기기에서 로그아웃 | 그 사람의 로그인을 모두 끊고 열려 있던 웹 SSH 도 끊는다. |
| 2단계 인증 초기화 | 인증 앱과 복구 코드를 모두 잃은 사람의 2단계 인증을 끈다([`mfa:reset`](#2단계-인증) 과 같다). |
| 계정 지우기 | 확인을 위해 그 사람의 이메일을 그대로 적어야 한다. 다른 팀원이 있는 팀의 유일한 소유자이면 거절한다. 먼저 소유권을 넘기거나 그 팀을 지운다. 혼자 있는 팀, 개인 볼트, 로그인, 볼트 키가 함께 지워지고 다른 팀에서도 빠진다. 기록은 남는다. 되돌릴 수 없다. |

`SHELL_BOOTSTRAP_ADMINS` 에 있는 이메일은 다음 Google 로그인 때 다시 서버 관리자가 된다. 여기서 관리자를 빼기 전에 그 목록에서 먼저 지운다.

### 팀

최근 만든 팀 500개와 소유자, 팀원 수, 볼트 수, 만든 날을 보여 준다.

### 서버 기록

볼트 밖의 일: 로그인과 거절된 로그인, 콘솔 로그인과 실패한 콘솔 로그인, 관리 작업, 팀 만들기·지우기, 2단계 인증 변경 등. **누가** 칸에 마우스를 올리면 IP 주소가 나온다. 볼트 안의 일은 화면의 **기록**에 그대로 있다.

콘솔에서 한 일은 모두 여기에 남는다(`admin_user_disable`, `admin_user_enable`, `admin_grant`, `admin_revoke`, `admin_signout`, `mfa_reset`, `admin_user_delete`). 콘솔은 누구의 계정에도 묶여 있지 않으므로 행위자 없이 `detail.by` 가 `console` 로 남는다. 콘솔 로그인은 `console_login`·`console_login_failed` 로, `console:password` 로 바꾼 것은 `console_password` 로 남는다.

### 콘솔 API

화면이 쓰는 API 다. 콘솔 포트에만 있고, 공개 서버에는 관리 API 가 없다(`/api/admin/*` 은 404). 모든 요청은 `127.0.0.1`·`localhost`·`[::1]` 로 불러야 한다(다른 `Host` 는 421). 무언가를 바꾸는 요청은 `x-console: 1` 머리글도 있어야 하고, `Origin` 이 붙어 있으면 그것도 이 PC 주소여야 한다. `state` 와 `login` 말고는 모두 콘솔 로그인이 필요하다.

| API | 쓰임 |
|---|---|
| `GET /admin/api/state` | 비밀번호·OTP 를 정했는지, 이 브라우저가 로그인했는지 |
| `POST /admin/api/login` | 본문 `{"password": "...", "code": "123456"}`(`code` 는 OTP 를 켰을 때만). 로그인 쿠키를 준다 |
| `POST /admin/api/logout` | 이 콘솔 로그인을 끝낸다 |
| `GET /admin/api/stats` | 개요 숫자와 서버 방식 |
| `GET /admin/api/users` | 사람 목록. 쿼리 `q`(이메일·이름), `filter`(`all`, `admins`, `disabled`, `nokeys`), `offset` |
| `GET /admin/api/users/:id` | 한 사람의 소속 팀(지우기 전에 보여 준다) |
| `POST /admin/api/users/:id/disable` | 본문 `{"disabled": true}` 또는 `false` |
| `POST /admin/api/users/:id/admin` | 본문 `{"admin": true}` 또는 `false` |
| `POST /admin/api/users/:id/signout` | 모든 기기에서 로그아웃 |
| `POST /admin/api/users/:id/mfa-reset` | 2단계 인증 초기화 |
| `DELETE /admin/api/users/:id` | 본문 `{"confirm": "<이메일>"}` |
| `GET /admin/api/teams` | 팀 목록 |
| `GET /admin/api/audit` | 서버 기록, 200개씩. 더 오래된 것은 쿼리 `before`(기록 ID) |

## 한도

모든 서버에 적용된다. 주로 누구나 가입하는 서버가 남용되지 않게 하려는 것이다.

| 한도 | 값 |
|---|---|
| 한 사람이 가질 수 있는 팀 | 20개(서버 관리자는 제한 없음) |
| 팀 하나의 볼트 | 50개 |
| 볼트 하나의 항목 | 5,000개 |
| 한 사람이 동시에 여는 웹 SSH 연결 | 20개 |
| 한 사람이 새로 여는 웹 SSH 연결 | 10분에 120개 |

웹 SSH 횟수는 메모리에 있어서 서버를 다시 켜면 초기화된다.

## 2단계 인증

- 사람마다 **설정 → 보안·암호화 → 2단계 인증** 에서 인증 앱(Google Authenticator, 1Password, Authy 등)으로 켠다. 일회용 **복구 코드** 10개를 한 번만 보여 준다.
- Google 로그인과 아이디·비밀번호 로그인 모두 뒤에 적용된다. 코드를 넣기 전에는 모든 API 와 웹 중계가 막힌다. 다섯 번 틀리면 그 로그인 시도는 끝난다.
- 코드를 확인하려면 서버가 각자의 TOTP 비밀값을 알아야 한다. 비밀값은 `SHELL_TOTP_KEY`, 없으면 `<data>/totp.key` 로 봉해 두므로 DB 만 새어서는 쓸 수 없다. **이 키를 DB 와 함께 백업한다.** 잃으면 2단계 인증을 켠 사람은 모두 초기화해야 한다.

인증 앱과 복구 코드를 모두 잃은 사람은 서버를 운영하는 사람이 [관리 콘솔](#관리-콘솔)이나 명령줄에서 2단계 인증을 꺼 준다(어느 쪽이든 기록에 `mfa_reset` 으로 남는다):

```bash
npm run mfa:reset -w server -- user@example.com
# Docker:
docker compose exec terminas node server/scripts/mfa-reset.ts user@example.com
```

계정 아이디가 이메일이 아니면 그 아이디를 넣는다.

## 로그인 비밀번호 초기화

서버를 운영하는 사람은 명령줄에서 어느 계정이든 로그인 비밀번호를 새로 정할 수 있다:

```bash
npm run user:password -w server -- <아이디>
npm run user:password -w server -- <아이디> --create-admin    # 없는 아이디면 새 서버 관리자로 만든다
# Docker:
docker compose exec terminas node server/scripts/user-password.ts <아이디>
```

- 비밀번호는 화면에 보이지 않게 두 번 묻는다. 터미널이 아니면 표준 입력의 첫 줄과 둘째 줄을 쓴다.
- 그 계정의 로그인은 모두 끊는다.
- 바뀌는 것은 **로그인** 비밀번호뿐이다. 서버는 볼트를 열 수 없으므로 서버 쪽에서 **암호화** 비밀번호를 초기화할 방법은 없다. 암호화 비밀번호를 잊은 사람은 복구 키로 풀고 새 비밀번호를 정한다. 둘 다 잃었으면 로그인한 지 10분 안에 잠금 화면에서 처음부터 다시 할 수 있다. 개인 볼트 내용은 지워지고, 팀 볼트 키는 팀 관리자가 다시 건넨다.

## 백업

**데이터 폴더를 통째로** 백업한다:

| 파일 | 이유 |
|---|---|
| `shell.db`, `shell.db-wal`, `shell.db-shm` | 계정·팀·권한·암호화된 볼트·기록과 관리 콘솔 비밀번호. DB 가 WAL 모드라 셋을 함께 복사한다. |
| `totp.key` | 관리 콘솔 OTP 를 포함해 2단계 인증 비밀값을 봉하는 키(`SHELL_TOTP_KEY` 를 쓰지 않을 때). |
| `updates/` | 데스크톱 앱을 직접 배포할 때만. |

`.env`(Google 보안 비밀, 쓴다면 `SHELL_TOTP_KEY`)도 안전한 곳에 한 부 둔다.

가장 간단하고 확실한 방법은 서버를 잠깐 멈추고 폴더를 복사하는 것이다.

**Docker** (이름 있는 볼륨 앞에는 Compose 프로젝트 이름이 붙는다 — `docker volume ls` 로 확인):

```bash
docker compose stop terminas
docker run --rm -v terminas_terminas-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/terminas-data-$(date +%F).tgz -C /data .
docker compose start terminas
```

**Docker 없이:**

```bash
sudo systemctl stop terminas
sudo tar czf terminas-data-$(date +%F).tgz -C /opt/terminas data
sudo systemctl start terminas
```

되살릴 때는 서버를 멈추고 데이터 폴더를 백업으로 바꾼 뒤 다시 켠다.

백업이 새어도 볼트 내용은 풀리지 않는다. 다만 이메일·이름·팀과 볼트 이름·팀원 관계·역할·기록은 보인다.

## 업그레이드

먼저 백업한다. DB 마이그레이션은 켤 때 자동으로 돌고, 되돌리는 마이그레이션은 없다.

**Docker:**

```bash
git pull
docker compose up -d --build
```

**Docker 없이:**

```bash
git pull
npm ci
npm run build
sudo systemctl restart terminas
```

서버는 켤 때 웹 화면 파일을 등록한다. 그래서 **웹 화면을 다시 빌드했으면 반드시 서버를 다시 켠다.** 안 그러면 새 파일이 재시작 전까지 404 가 된다.

데스크톱 앱은 화면을 자기 안에 들고 있다. 서버와 앱의 차이가 너무 크면 앱이 **서버와 앱의 버전이 맞지 않습니다** 를 띄우고 어느 쪽을 업데이트할지 알려 준다([데스크톱 앱 연결](#데스크톱-앱-연결) 참고). 서버를 최신으로 두면 이런 일이 없다.

## 데스크톱 앱 연결

공식 Windows 앱 사용자는 앱을 내 서버에 연결할 수 있다.

1. 앱을 처음 켜면 어느 서버에 연결할지 묻는다. 나중에는 로그인 화면에서 서버 이름 옆 **바꾸기** 를 누른다. 또는 **도움말 → 서버 주소 바꾸기…**, **설정 → 계정 → 연결된 서버 → 서버 바꾸기**.
2. **직접 운영하는 서버** 를 고르고 도메인이나 IP 주소를 넣는다. 예: `terminas.example.com`, `192.168.0.10:5280`.
3. 앱은 저장하기 전에 그 주소에서 Terminas 서버가 답하는지 확인한다.

주소 규칙:

- 스킴 없이 넣으면 앱이 `https://` 를 붙인다.
- 내부망·VPN 주소 — `localhost`, `127.x`, `10.x`, `172.16~31.x`, `192.168.x`, `100.64~127.x`(Tailscale 등), IPv6 `fc00::/7`·`fe80::/10`·`::1` — 는 대신 `http://` 를 붙이고, 암호화되지 않은 연결이니 같은 내부망이나 VPN 안에서만 쓰라고 경고한다.
- 인터넷 주소는 `https` 만 된다.

내부망의 평문 http 는 데스크톱 앱에서만 된다. 브라우저는 `localhost` 가 아니면 평문 http 에서 웹 화면을 돌리지 않고, Docker 라면 그 인터페이스에 포트도 열어야 한다. 어디서든 HTTPS 를 권한다.

그 밖에 알아 둘 것:

- **업데이트는 늘 공식 업데이트 배포처에서** 받고 내 서버에서는 받지 않는다. 앱은 [GitHub Releases](https://github.com/Studio-Yeonhong/Terminas/releases)를 먼저 보고, 안 되면 공식 서버의 `/updates` 를 본다. 어느 쪽이든 공식 Ed25519 서명이 있어야만 설치한다. 직접 운영하는 서버를 골라도 업데이트 방식은 그대로다. 앱을 직접 빌드해 배포하는 조직은 자체 서명 키와 업데이트 배포처를 써야 한다([development.md](development.md#releasing-your-own-desktop-builds), 영어).
- **앱·서버 호환.** 서버는 `GET /api/auth/config` 로 API 수준(`api`)과 받아 주는 가장 낮은 앱 수준(`minAppApi`)을 알린다. 서버가 앱이 필요로 하는 것보다 오래됐으면 앱은 서버 업데이트를 요청하라고, 앱이 너무 오래됐으면 앱을 업데이트하라고 안내한다.
- **웹의 내려받기 링크.** 웹 로그인 화면과 설정에 **Windows 앱 받기** 가 나온다. 서버의 `<data>/updates` 에 설치 파일이 없으면 `SHELL_APP_DOWNLOAD_URL`(기본값은 공식 배포 페이지)로 간다.
- 앱은 서버 주소마다 로그인을 따로 기억한다.

## 보안 참고

**서버를 운영하는 사람(또는 DB 를 가진 사람)이 볼 수 있는 것과 없는 것** — [관리 콘솔](#관리-콘솔)은 왼쪽 칸의 일부만 보여 준다:

| 볼 수 있다 | 볼 수 없다 |
|---|---|
| 이메일, 이름, 프로필 사진, 마지막 로그인 시각 | 호스트 주소, 사용자 이름, 비밀번호, SSH 키, 스니펫, 포워딩 규칙, 저장한 HTTP 요청 |
| 팀 이름, 볼트 이름, 팀원 관계, 역할, 볼트 권한 | 알려진 호스트 지문과 호스트 OS 정보(암호화된 항목 안에 있다) |
| 볼트에 어떤 종류의 항목이 있고 언제 바뀌었는지 | 기록의 대상 이름(볼트 키로 암호화) |
| 기록의 동작·시각·IP 주소, 세션의 IP 와 브라우저 정보 | 터미널 내용과 파일 전송(SSH 로 종단간 암호화) |
| **웹** SSH 만: 중계가 열려 있는 동안의 대상 호스트·포트(남기지 않는다) | 볼트 키, 계정 키, 암호화 비밀번호, 복구 키 |
| 로그인하는 순간의 로그인 비밀번호(저장은 scrypt 해시로만), TOTP 비밀값(서버 키로 봉함) | |

권하는 것:

- **`SHELL_DEV_LOGIN=0` 으로 둔다.** 이메일만으로 누구나 로그인하게 된다. 운영이 아닌 localhost 가 아니면 서버가 뜨지 않는다.
- **`SHELL_TRUST_PROXY=1` 은 프록시 뒤에서만.** 프록시가 없으면 사용자가 `X-Forwarded-For` 를 꾸며 IP 별 제한을 피하고 기록의 IP 를 속일 수 있다. Docker Compose 는 포트를 `127.0.0.1` 에만 열기 때문에 `1` 로 둔다. 포트를 다른 곳에 열면 이것도 바꾼다.
- **`NODE_ENV=production` 으로 돌린다**(Docker 이미지는 이미 그렇다). 중계가 서버 자신의 루프백·링크 로컬·인터페이스 주소를 막는다.
- **중계가 닿는 범위를 생각한다.** 로그인한 사용자는 서버가 닿고 SSH 인사말로 답하는 어느 주소로든 웹 SSH 를 열 수 있다. 사설망 주소(`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `198.18/15`, `fc00::/7`)는 `SHELL_RELAY_PRIVATE` 를 따른다 — 기본은 `all`, Google 계정만 있으면 누구나 들어오는 [누구나 가입](#누구나-가입) 서버에서는 기본이 `admins`. 서버가 닿는 공인 주소(공유기를 거쳐 돌아오는 서버 자신의 공인 IP 포함)는 누구에게나 열려 있으니, 서버 위치를 정하거나 서버의 나가는 트래픽을 그에 맞게 제한한다.
- **공개 서비스로 돌릴 생각이 아니면 초대한 사람만 받는다.** `SHELL_OPEN_SIGNUP` 의 기본값은 `0` 이다. 켠다면 이용약관과 개인정보처리방침을 게시하고 [관리 콘솔](#관리-콘솔)을 살핀다.
- **관리 콘솔은 서버 PC 안에 둔다.** 콘솔 포트(5282)를 밖에 열거나 리버스 프록시로 넘기지 말고, SSH 터널이나 원격 데스크톱으로 연다. 콘솔 비밀번호는 길게 정하고 OTP 도 켠다(`console:password -- --otp`).
- **`.env` 와 데이터 폴더를 보호한다**(`chmod 600 .env`). 처음 켠 뒤 `SHELL_ADMIN_PASSWORD` 를 지운다.
- **민감한 작업은 데스크톱 앱에서.** 웹 화면의 코드는 내 서버가 준다. 서버가 장악되면 바뀐 웹 코드가 브라우저에서 넣은 비밀번호를 빼 갈 수 있다. 데스크톱 앱은 화면을 자기 안에 들고 있어 이 위험이 없다.
- 새 팀원에게 볼트 키를 건네기 전에 **키 지문을 대조한다.**

## 문제 해결

서버 로그와 명령줄 메시지는 지금은 한국어로 나온다.

| 증상 | 원인과 해결 |
|---|---|
| `SHELL_DEV_LOGIN=1 is only allowed with a localhost SHELL_PUBLIC_URL outside production` 으로 서버가 끝난다 | `SHELL_DEV_LOGIN=0` 으로 둔다. |
| `SHELL_ADMIN_ID needs SHELL_PASSWORD_LOGIN=1` 으로 서버가 끝난다 | 아이디·비밀번호 로그인을 켜거나 `SHELL_ADMIN_ID` 를 지운다. |
| `SHELL_ADMIN_ID must be an email address or 3-64 characters...` 로 서버가 끝난다 | 이메일이나 `a-z 0-9 . _ -` 로 된 3~64자를 쓴다. |
| `SHELL_ADMIN_PASSWORD must be at least 10 characters` 로 서버가 끝난다 | 더 긴 비밀번호를 쓴다. |
| `SHELL_CONSOLE_PORT must be 0-65535` 로 서버가 끝난다 | 포트 번호를 넣거나, 콘솔을 끄려면 `0` 을 넣는다. |
| `SHELL_TERMS_URL must be an http(s) URL` 로 서버가 끝난다(`SHELL_PRIVACY_URL`·`SHELL_SOURCE_URL`·`SHELL_APP_DOWNLOAD_URL` 도 같다) | 공백 없는 온전한 `https://...`(또는 `http://...`) 주소를 넣거나 그 변수를 지운다. |
| 로그에 `SHELL_ADMIN_ID=... 계정에 비밀번호가 없습니다` 경고 | 한 번 켤 동안만 `SHELL_ADMIN_PASSWORD` 를 넣거나 `user:password` 를 돌린다. |
| 로그인 화면: "로그인 방법이 아직 설정되지 않았습니다" | Google 이나 `SHELL_PASSWORD_LOGIN=1` 을 설정하고 다시 켠다. |
| Google: `redirect_uri_mismatch` | Authorized redirect URI 가 정확히 `<SHELL_PUBLIC_URL>/api/auth/google/callback` 이어야 한다. |
| Google: 일부 사람만 로그인된다 | OAuth 동의 화면이 아직 **Testing** 이다. 테스트 사용자로 넣거나 게시한다. |
| "초대받지 않은 계정입니다" | 그 이메일을 먼저 초대한다. 서버 관리자라면 `SHELL_BOOTSTRAP_ADMINS` 에 넣는다. 누구나 Google 로 가입하게 하려면 `SHELL_OPEN_SIGNUP=1` 로 둔다. |
| "소속된 팀이 없습니다" | `SHELL_OPEN_SIGNUP=1` 이 아니면, 서버 관리자가 아닌 사람은 팀이 하나 이상 있어야 한다. |
| 팀·볼트를 만들거나 항목을 더할 때 한도 메시지가 나온다 | [한도](#한도) 참고: 한 사람이 가지는 팀 20개(서버 관리자 제외), 팀 하나에 볼트 50개, 볼트 하나에 항목 5,000개. |
| 웹 SSH: "동시에 열 수 있는 연결이 너무 많습니다." | 그 사람이 웹 SSH 를 이미 20개 열었거나, 10분 안에 120개를 열었다. 몇 개를 닫거나 기다린다. |
| 웹 화면에서 하는 일이 403 "허용되지 않은 출처입니다"(`bad_origin`)로 실패한다 | `SHELL_PUBLIC_URL` 이 브라우저 주소와 다르다(스킴·호스트·포트가 같아야 한다). |
| 웹 SSH 가 바로 실패하고 브라우저에 WebSocket 오류가 난다 | 프록시가 `/api/relay` 의 WebSocket 업그레이드를 통과시키지 않는다. |
| "SSH 서버가 아닙니다 (인사말이 오지 않았습니다)." | 대상이 10초 안에 SSH 인사말을 보내지 않았다. 주소와 포트를 확인한다. |
| "해당 주소로는 연결할 수 없습니다." | 중계는 서버 자신의 루프백·인터페이스 주소를 막는다. 그 호스트는 데스크톱 앱으로 연다. |
| "이 서버에서는 내부망 주소로 웹 접속을 할 수 없습니다." | 사설망에 있는 호스트인데 `SHELL_RELAY_PRIVATE` 가 이 계정에 허용하지 않는다(누구나 가입이면 서버 관리자만). 데스크톱 앱으로 열거나 설정을 바꾼다. |
| 웹 SSH 가 키 교환에서 실패한다 | 브라우저 SSH 는 curve25519 를 쓰지 않는다. SSH 서버가 ECDH(`ecdh-sha2-nistp256/384/521`)나 Diffie-Hellman 키 교환을 받아야 한다. OpenSSH 기본 설정은 받는다. |
| 업그레이드 뒤 웹 화면이 비거나 파일이 404 | 웹 화면을 다시 빌드했으면 서버를 다시 켠다. |
| "여러 번 틀려서 잠시 막았습니다." | 15분 기다린다. 횟수는 메모리에 있어서 서버를 다시 켜도 초기화된다. |
| 서버를 옮긴 뒤 모두의 2단계 인증 코드가 안 된다(관리 콘솔 OTP 도) | `totp.key`(또는 `SHELL_TOTP_KEY`)를 옮기지 않았다. 되살리거나, 해당하는 사람마다 `mfa:reset` 을, 콘솔은 `console:password -- --otp`(또는 `--no-otp`)를 돌린다. |
| 관리 콘솔이 열리지 않는다(연결 거부·시간 초과) | 콘솔은 `SHELL_CONSOLE_HOST`(기본 `127.0.0.1`)에서만 듣는다. 서버 PC 에서 `http://127.0.0.1:5282/admin` 을 열거나 SSH 터널(`ssh -L 5282:127.0.0.1:5282 user@server`)로 연다. `SHELL_CONSOLE_PORT` 가 `0` 이 아닌지, Docker 라면 `docker-compose.yml` 에 `127.0.0.1:5282:5282` 가 그대로 있는지 확인한다. |
| 로그에 `관리 콘솔을 열지 못했습니다` | 다른 프로그램이 그 포트를 쓴다. 그 프로그램을 멈추거나 `SHELL_CONSOLE_PORT` 를 바꾼다. 공개 서버는 콘솔 없이 그대로 돈다. |
| 관리 콘솔: "This console only answers on 127.0.0.1 / localhost." | 다른 이름(도메인, 내부망 주소, 프록시)으로 불렀다. `http://127.0.0.1:5282/admin` 으로 연다. 다른 컴퓨터에서는 SSH 터널로. |
| 관리 콘솔에 비밀번호 정하는 명령만 나온다(로그에 `관리 콘솔 비밀번호가 없습니다` 경고) | 콘솔 비밀번호를 아직 정하지 않았다. `npm run console:password -w server` 를 돌린다(Docker: `docker compose exec terminas node server/scripts/console-password.ts`). |
| 관리 콘솔 로그인이 여러 번 틀린 뒤 막혔다 | 15분 안에 5번 틀리면 막힌다. 15분 기다린다(횟수는 메모리에 있어서 서버를 다시 켜도 초기화된다). 비밀번호를 잊었거나 인증 앱을 잃었으면 서버에서 `console:password` 를 다시 돌린다(`--no-otp` 는 OTP 를 끈다). |
| 데스크톱 앱: "그 주소에서 Terminas 서버를 찾지 못했습니다." | 주소·HTTPS·프록시를 확인한다. `https://<도메인>/api/auth/config` 가 답해야 한다. |
| 데스크톱 앱: "인터넷 주소는 https 만 쓸 수 있습니다" | https 를 쓴다. 꼭 http 가 필요하면 내부망·VPN IP 로. |
| 데스크톱 앱: "서버와 앱의 버전이 맞지 않습니다" | 안내대로 서버(또는 앱)를 업데이트한다. |
