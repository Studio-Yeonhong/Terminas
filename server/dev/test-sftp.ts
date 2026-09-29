// 테스트 sshd 의 SFTP 서브시스템. data/dev-sftp-root 폴더를 "/" 로 보여 준다 (밖으로는 못 나간다).
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';

const { STATUS_CODE, flagsToString } = (ssh2.utils as unknown as { sftp: { STATUS_CODE: Record<string, number>; flagsToString: (f: number) => string | null } }).sftp;

const HOME = '/home/demo';
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

type Handle = { kind: 'file'; fd: number } | { kind: 'dir'; real: string; done: boolean };

export function seedSftpRoot(root: string) {
  const home = path.join(root, 'home', 'demo');
  if (fs.existsSync(home)) return;
  fs.mkdirSync(path.join(home, 'projects', 'web'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, '한글 폴더'), { recursive: true });
  fs.mkdirSync(path.join(root, 'var', 'log'), { recursive: true });
  fs.writeFileSync(path.join(home, 'readme.txt'), 'Terminas 테스트 SFTP 입니다.\n진짜 서버가 아닙니다.\n');
  fs.writeFileSync(path.join(home, 'projects', 'web', 'index.html'), '<!doctype html>\n<title>hello</title>\n<h1>hello</h1>\n');
  fs.writeFileSync(path.join(home, 'projects', 'deploy.sh'), '#!/bin/sh\necho deploy\n');
  fs.writeFileSync(path.join(home, 'logs', 'app.log'), Array.from({ length: 2000 }, (_, i) => `line ${i + 1} ok`).join('\n'));
  fs.writeFileSync(path.join(home, '한글 폴더', '메모.md'), '# 메모\n\n한글 파일 이름 시험\n');
  fs.writeFileSync(path.join(root, 'var', 'log', 'syslog'), 'boot ok\n');
}

export function serveSftp(sftp: ssh2.SFTPWrapper & NodeJS.EventEmitter, root: string, username: string) {
  const handles = new Map<number, Handle>();
  const modes = new Map<string, number>();
  let next = 1;

  const locate = (p: string) => {
    const virtual = path.posix.resolve(HOME, p || '.');
    const real = path.join(root, ...virtual.split('/').filter(Boolean));
    if (real !== root && !real.startsWith(root + path.sep)) throw Object.assign(new Error('outside'), { code: 'EACCES' });
    return { virtual, real };
  };
  const handleBuf = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const handleOf = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
  const attrsOf = (real: string, st: fs.Stats) => {
    const dir = st.isDirectory();
    const perm = modes.get(real) ?? (dir ? 0o755 : real.endsWith('.sh') ? 0o755 : 0o644);
    return {
      mode: (dir ? S_IFDIR : 0o100000) | perm,
      uid: 1000,
      gid: 1000,
      size: dir ? 4096 : st.size,
      atime: Math.floor(st.atimeMs / 1000),
      mtime: Math.floor(st.mtimeMs / 1000),
    };
  };
  const fail = (reqid: number, err: NodeJS.ErrnoException) => {
    const code = err.code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : err.code === 'EACCES' || err.code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
    sftp.status(reqid, code, err.message);
  };
  const ok = (reqid: number) => sftp.status(reqid, STATUS_CODE.OK);
  const longname = (name: string, a: ReturnType<typeof attrsOf>) => {
    const t = (a.mode & S_IFMT) === S_IFDIR ? 'd' : '-';
    const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1].map((b, i) => (a.mode & b ? 'rwx'[i % 3] : '-')).join('');
    return `${t}${bits} 1 ${username} ${username} ${a.size} Jan  1 00:00 ${name}`;
  };
  const guard = (reqid: number, fn: () => void) => {
    try {
      fn();
    } catch (err) {
      fail(reqid, err as NodeJS.ErrnoException);
    }
  };
  const setMode = (real: string, attrs: { mode?: number }) => {
    if (typeof attrs?.mode === 'number') modes.set(real, attrs.mode & 0o7777);
  };

  sftp.on('REALPATH', (reqid: number, p: string) =>
    guard(reqid, () => {
      const { virtual } = locate(p);
      sftp.name(reqid, [{ filename: virtual, longname: virtual, attrs: {} as never }]);
    }),
  );
  const statHandler = (reqid: number, p: string) =>
    guard(reqid, () => {
      const { real } = locate(p);
      fs.stat(real, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf(real, st) as never)));
    });
  sftp.on('STAT', statHandler);
  sftp.on('LSTAT', statHandler);
  sftp.on('SETSTAT', (reqid: number, p: string, attrs: { mode?: number }) =>
    guard(reqid, () => {
      const { real } = locate(p);
      if (!fs.existsSync(real)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      setMode(real, attrs);
      ok(reqid);
    }),
  );
  sftp.on('OPENDIR', (reqid: number, p: string) =>
    guard(reqid, () => {
      const { real } = locate(p);
      fs.stat(real, (err, st) => {
        if (err) return fail(reqid, err);
        if (!st.isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE, 'not a directory');
        const n = next++;
        handles.set(n, { kind: 'dir', real, done: false });
        sftp.handle(reqid, handleBuf(n));
      });
    }),
  );
  sftp.on('READDIR', (reqid: number, hb: Buffer) => {
    const h = handleOf(hb);
    if (!h || h.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.done) return sftp.status(reqid, STATUS_CODE.EOF);
    h.done = true;
    fs.readdir(h.real, (err, names) => {
      if (err) return fail(reqid, err);
      const list = names.flatMap((name) => {
        try {
          const real = path.join(h.real, name);
          const a = attrsOf(real, fs.statSync(real));
          return [{ filename: name, longname: longname(name, a), attrs: a }];
        } catch {
          return [];
        }
      });
      if (!list.length) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.name(reqid, list as never);
    });
  });
  sftp.on('OPEN', (reqid: number, p: string, flags: number, attrs: { mode?: number }) =>
    guard(reqid, () => {
      const { real } = locate(p);
      const mode = flagsToString(flags);
      if (!mode) return sftp.status(reqid, STATUS_CODE.FAILURE, 'bad flags');
      fs.open(real, mode, (err, fd) => {
        if (err) return fail(reqid, err);
        setMode(real, attrs);
        const n = next++;
        handles.set(n, { kind: 'file', fd });
        sftp.handle(reqid, handleBuf(n));
      });
    }),
  );
  sftp.on('READ', (reqid: number, hb: Buffer, offset: number, length: number) => {
    const h = handleOf(hb);
    if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    const buf = Buffer.alloc(Math.min(length, 256 * 1024));
    fs.read(h.fd, buf, 0, buf.length, offset, (err, n) => {
      if (err) return fail(reqid, err);
      if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, n));
    });
  });
  sftp.on('WRITE', (reqid: number, hb: Buffer, offset: number, data: Buffer) => {
    const h = handleOf(hb);
    if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.write(h.fd, data, 0, data.length, offset, (err) => (err ? fail(reqid, err) : ok(reqid)));
  });
  sftp.on('FSTAT', (reqid: number, hb: Buffer) => {
    const h = handleOf(hb);
    if (!h || h.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.fstat(h.fd, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf('', st) as never)));
  });
  sftp.on('FSETSTAT', (reqid: number) => ok(reqid));
  sftp.on('CLOSE', (reqid: number, hb: Buffer) => {
    const h = handleOf(hb);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    handles.delete(hb.readUInt32BE(0));
    if (h.kind === 'file') fs.close(h.fd, (err) => (err ? fail(reqid, err) : ok(reqid)));
    else ok(reqid);
  });
  sftp.on('REMOVE', (reqid: number, p: string) => guard(reqid, () => fs.unlink(locate(p).real, (err) => (err ? fail(reqid, err) : ok(reqid)))));
  sftp.on('RMDIR', (reqid: number, p: string) => guard(reqid, () => fs.rmdir(locate(p).real, (err) => (err ? fail(reqid, err) : ok(reqid)))));
  sftp.on('MKDIR', (reqid: number, p: string) =>
    guard(reqid, () => fs.mkdir(locate(p).real, (err) => (err ? fail(reqid, err) : ok(reqid)))),
  );
  sftp.on('RENAME', (reqid: number, from: string, to: string) =>
    guard(reqid, () => {
      const dst = locate(to).real;
      // SFTP v3: 대상이 있으면 실패
      if (fs.existsSync(dst)) return sftp.status(reqid, STATUS_CODE.FAILURE, 'target exists');
      fs.rename(locate(from).real, dst, (err) => (err ? fail(reqid, err) : ok(reqid)));
    }),
  );
  sftp.on('READLINK', (reqid: number) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
  sftp.on('SYMLINK', (reqid: number) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
  sftp.on('close', () => {
    for (const h of handles.values()) if (h.kind === 'file') fs.close(h.fd, () => {});
    handles.clear();
  });
}
