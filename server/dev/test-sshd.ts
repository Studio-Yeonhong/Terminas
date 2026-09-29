// 개발용 가짜 SSH 서버 (127.0.0.1 전용). 실제 셸을 열지 않고 흉내만 낸다.
//   비밀번호:    TEST_SSHD_USER / TEST_SSHD_PASSWORD
//   공개키:      data/dev-authorized_keys 에 적힌 키 (TEST_SSHD_USER 로)
//   2단계 인증:  사용자 otp — 비밀번호 + TEST_SSHD_OTP
//   --new-hostkey 로 띄우면 호스트 키가 바뀐다 (지문 불일치 경고 시험용)
//   TEST_SSHD_OS=ubuntu|debian|rocky|alpine|windows 면 그 OS 인 척한다 (인사말 + /etc/os-release — OS 로고 시험용)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ssh2 from 'ssh2';
import { seedSftpRoot, serveSftp } from './test-sftp.ts';

const { Server, utils } = ssh2;
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const port = Number(process.env.TEST_SSHD_PORT ?? 2222);
const USER = process.env.TEST_SSHD_USER ?? 'demo';
const PASSWORD = process.env.TEST_SSHD_PASSWORD ?? '';
const OTP = process.env.TEST_SSHD_OTP ?? '';
if (!PASSWORD) throw new Error('TEST_SSHD_PASSWORD 를 .env 에 넣어 주세요');

const sftpRoot = path.join(dataDir, 'dev-sftp-root');
fs.mkdirSync(sftpRoot, { recursive: true });
seedSftpRoot(sftpRoot);

const keyFile = path.join(dataDir, 'dev-sshd-hostkey');
if (process.argv.includes('--new-hostkey') || !fs.existsSync(keyFile)) {
  const pair = (utils as unknown as { generateKeyPairSync: (t: string, o: object) => { private: string } }).generateKeyPairSync('ed25519', {
    comment: 'terminas-test-sshd',
  });
  fs.writeFileSync(keyFile, pair.private);
}

// OS 흉내: 인사말(서버 버전 문자열)과, OS 를 묻는 명령에 돌려줄 /etc/os-release
const FAKE_OS: Record<string, { ident: string; release: string }> = {
  ubuntu: { ident: 'OpenSSH_9.6p1 Ubuntu-3ubuntu13.5', release: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n' },
  debian: { ident: 'OpenSSH_9.2p1 Debian-2+deb12u3', release: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n' },
  rocky: { ident: 'OpenSSH_8.7', release: 'NAME="Rocky Linux"\nID="rocky"\nID_LIKE="rhel centos fedora"\n' },
  alpine: { ident: 'OpenSSH_9.9', release: 'NAME="Alpine Linux"\nID=alpine\n' },
  windows: { ident: 'OpenSSH_for_Windows_9.5', release: '' },
};
const fakeOs = FAKE_OS[process.env.TEST_SSHD_OS ?? ''];

function authorizedKeys() {
  const file = path.join(dataDir, 'dev-authorized_keys');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => utils.parseKey(l))
    .filter((k): k is ssh2.ParsedKey => !(k instanceof Error) && !Array.isArray(k));
}

const wide = (ch: string) => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch);

function runShell(stream: ssh2.ServerChannel, username: string, size: () => { cols: number; rows: number }) {
  let closed = false;
  const out = (s: string) => stream.write(s.replace(/\n/g, '\r\n'));
  const prompt = () => out(`\x1b[1;32m${username}@test-sshd\x1b[0m:\x1b[1;34m~\x1b[0m$ `);
  const exit = () => {
    closed = true;
    out('logout\n');
    stream.exit(0);
    stream.end();
  };
  const exec = (line: string) => {
    const [cmd, ...args] = line.split(/\s+/);
    switch (cmd) {
      case '':
        return;
      case 'help':
        return out('commands: help whoami hostname date echo ls uname size colors seq clear exit\n');
      case 'whoami':
        return out(`${username}\n`);
      case 'hostname':
        return out('test-sshd\n');
      case 'date':
        return out(`${new Date().toString()}\n`);
      case 'echo':
        return out(`${args.join(' ')}\n`);
      case 'ls':
        return out('\x1b[1;34mprojects\x1b[0m  \x1b[1;34mlogs\x1b[0m  notes.txt  \x1b[1;32mdeploy.sh\x1b[0m  한글파일.md\n');
      case 'uname':
        return out('Linux test-sshd 6.8.0-studio x86_64 GNU/Linux\n');
      case 'size': {
        const s = size();
        return out(`${s.cols}x${s.rows}\n`);
      }
      case 'colors': {
        let s = '';
        for (let i = 0; i < 16; i++) s += `\x1b[48;5;${i}m  \x1b[0m`;
        s += '\n';
        for (let i = 16; i < 232; i++) s += `\x1b[48;5;${i}m \x1b[0m${(i - 15) % 36 === 0 ? '\n' : ''}`;
        return out(`${s}\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m \x1b[31mred\x1b[0m \x1b[32mgreen\x1b[0m\n`);
      }
      case 'seq': {
        const n = Math.min(Number(args[0]) || 10, 100000);
        const lines: string[] = [];
        for (let i = 1; i <= n; i++) lines.push(String(i));
        return out(`${lines.join('\n')}\n`);
      }
      case 'clear':
        return out('\x1b[2J\x1b[H');
      case 'exit':
      case 'logout':
        return exit();
      default:
        return out(`${cmd}: command not found\n`);
    }
  };

  out(`Terminas test sshd — 진짜 서버가 아닙니다. 'help' 를 입력해 보세요.\n\n`);
  prompt();
  let line = '';
  stream.on('data', (data: Buffer) => {
    const text = data.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]/g, '');
    for (const ch of text) {
      if (closed) return;
      if (ch === '\r' || ch === '\n') {
        out('\n');
        exec(line.trim());
        line = '';
        if (!closed) prompt();
      } else if (ch === '\x7f' || ch === '\b') {
        const chars = [...line];
        const last = chars.pop();
        if (last) {
          line = chars.join('');
          stream.write(wide(last) ? '\b\b  \b\b' : '\b \b');
        }
      } else if (ch === '\x03') {
        out('^C\n');
        line = '';
        prompt();
      } else if (ch === '\x04') {
        if (!line) exit();
      } else if (ch >= ' ') {
        line += ch;
        stream.write(ch);
      }
    }
  });
}

new Server({ hostKeys: [fs.readFileSync(keyFile)], ...(fakeOs ? { ident: fakeOs.ident } : {}) }, (client) => {
  let username = '';
  client
    .on('authentication', (ctx) => {
      username = ctx.username;
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASSWORD) return ctx.accept();
      if (ctx.method === 'publickey' && ctx.username === USER) {
        const match = authorizedKeys().find((k) => k.getPublicSSH().equals(ctx.key.data));
        if (match && (!ctx.signature || match.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
        return ctx.reject();
      }
      if (ctx.method === 'keyboard-interactive' && ctx.username === 'otp' && OTP) {
        return ctx.prompt(
          [
            { prompt: 'Password: ', echo: false },
            { prompt: 'Verification code: ', echo: true },
          ],
          (answers) => (answers[0] === PASSWORD && answers[1] === OTP ? ctx.accept() : ctx.reject()),
        );
      }
      ctx.reject(['password', 'publickey', 'keyboard-interactive']);
    })
    .on('ready', () => {
      // 포트 포워딩(direct-tcpip): 이 가짜 서버에서는 127.0.0.1 로만 이어 준다
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1' && info.destIP !== 'localhost') return reject();
        const sock = net.connect(info.destPort, '127.0.0.1');
        sock.once('error', () => reject());
        sock.once('connect', () => {
          const ch = accept();
          sock.removeAllListeners('error');
          sock.on('error', () => ch.close());
          ch.on('error', () => sock.destroy());
          sock.pipe(ch).pipe(sock);
        });
      });
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        let cols = 80;
        let rows = 24;
        session.on('pty', (accept, _reject, info) => {
          cols = info.cols;
          rows = info.rows;
          accept?.();
        });
        session.on('window-change', (accept, _reject, info) => {
          cols = info.cols;
          rows = info.rows;
          accept?.();
        });
        session.on('shell', (accept) => runShell(accept(), username, () => ({ cols, rows })));
        session.on('sftp', (accept) => serveSftp(accept() as ssh2.SFTPWrapper & NodeJS.EventEmitter, sftpRoot, username));
        session.on('exec', (accept, _reject, info) => {
          const stream = accept();
          if (fakeOs && info.command.includes('/etc/os-release')) {
            stream.write(`${fakeOs.release}Linux\n`);
            stream.exit(0);
            stream.end();
            return;
          }
          stream.write(`exec: ${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    })
    .on('error', () => {});
}).listen(port, '127.0.0.1', () => {
  console.log(`test sshd listening on 127.0.0.1:${port} (user ${USER})`);
});
