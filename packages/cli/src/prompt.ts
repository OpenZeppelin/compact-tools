import { stdin, stdout } from 'node:process';

/**
 * Prompt the user for a keystore passphrase on stdout and read it from stdin
 * with terminal echo suppressed.
 *
 * Uses raw mode + manual byte handling so we can swallow each character as
 * it arrives (no glyphs, no asterisks) and handle Ctrl-C / Backspace
 * correctly. Falls back to plain line-read when stdin is not a TTY (piped
 * input in CI).
 */
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
