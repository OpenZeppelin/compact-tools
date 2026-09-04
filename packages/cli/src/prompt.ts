import { stderr, stdin } from 'node:process';

/**
 * Prompt for a keystore passphrase with terminal echo suppressed; falls back
 * to plain line-read off a TTY. Prompt text and the trailing newline go to
 * STDERR so `--json` (and any piped) callers keep a clean single-object STDOUT.
 */
export async function promptPassphrase(label: string): Promise<string> {
  stderr.write(`Passphrase for ${label}: `);
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
      stdin.removeListener('end', onEnd);
      stdin.removeListener('error', onError);
      stderr.write('\n');
    };

    // Without these, a non-interactive stdin that closes without a trailing
    // newline (e.g. piped input, or a closed pipe) would never settle the
    // promise and the CLI would hang.
    const onEnd = () => {
      cleanup();
      if (buffer.length > 0) resolveFn(buffer);
      else rejectFn(new Error('Aborted'));
    };

    const onError = (err: Error) => {
      cleanup();
      rejectFn(err);
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
          // Split by code point: `slice(-1)` on a string would strip half a
          // surrogate pair, leaving a lone surrogate in the passphrase.
          buffer = [...buffer].slice(0, -1).join('');
          continue;
        }
        buffer += ch;
      }
    };

    if (isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onError);
  });
}
