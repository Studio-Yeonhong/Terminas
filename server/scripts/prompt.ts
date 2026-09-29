// 명령줄에서 비밀번호처럼 화면에 보이지 않게 받기 (터미널이 아니면 표준 입력의 줄을 차례로 읽는다)
import readline from 'node:readline';

let pipedLines: string[] | null = null;
let pipedIndex = 0;
async function readPiped() {
  if (pipedLines) return pipedLines;
  const rl = readline.createInterface({ input: process.stdin });
  pipedLines = [];
  for await (const line of rl) pipedLines.push(line);
  return pipedLines;
}

export async function ask(prompt: string, { hidden = true } = {}): Promise<string> {
  if (!process.stdin.isTTY) return (await readPiped())[pipedIndex++] ?? '';
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value && !hidden) process.stdout.write('\b \b');
          value = value.slice(0, -1);
        } else {
          value += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on('data', onData);
  });
}
