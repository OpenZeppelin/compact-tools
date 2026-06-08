import { stdin, stdout } from 'node:process';

/** Prompt for a keystore passphrase with terminal echo suppressed; falls back to plain line-read off a TTY. */
export async function promptPassphrase(label: string): Promise<string> {
  stdout.write(`Passphrase for ${label}: `);
  return readMaskedLine();
}

function readMaskedLine(): Promise<string> {
  return new Promise((resolveFn, rejectFn) => {
    let buffer = '';
    const isTTY = stdin.isTTY === true;

    const cleanup = () => {
      if (isTTY) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
    };

    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code === 0x03) {
          cleanup();
          rejectFn(new Error('Aborted'));
          return;
        }
        if (code === 0x0d || code === 0x0a) {
          cleanup();
          resolveFn(buffer);
          return;
        }
        if (code === 0x7f || code === 0x08) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += ch;
      }
    };

    if (isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}
