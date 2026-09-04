import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStdin, mockStderr } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  type FakeStdin = InstanceType<typeof EventEmitter> & {
    isTTY: boolean;
    setRawMode: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    setEncoding: ReturnType<typeof vi.fn>;
    removeListener: (event: string, fn: (...args: unknown[]) => void) => void;
  };
  const stdin = new EventEmitter() as FakeStdin;
  stdin.isTTY = true;
  stdin.setRawMode = vi.fn();
  stdin.pause = vi.fn();
  stdin.resume = vi.fn();
  stdin.setEncoding = vi.fn();
  stdin.removeListener = stdin.removeListener.bind(
    stdin,
  ) as FakeStdin['removeListener'];

  const stderr = { write: vi.fn() };
  return { mockStdin: stdin, mockStderr: stderr };
});

vi.mock('node:process', () => ({
  stdin: mockStdin,
  stderr: mockStderr,
}));

import { promptPassphrase } from '../src/prompt.ts';

function resetStdin(opts: { tty: boolean } = { tty: true }): void {
  mockStdin.removeAllListeners();
  (mockStdin as { isTTY: boolean }).isTTY = opts.tty;
  (mockStdin.setRawMode as ReturnType<typeof vi.fn>).mockClear();
  (mockStdin.pause as ReturnType<typeof vi.fn>).mockClear();
  (mockStdin.resume as ReturnType<typeof vi.fn>).mockClear();
  (mockStdin.setEncoding as ReturnType<typeof vi.fn>).mockClear();
  mockStderr.write.mockClear();
}

describe('promptPassphrase', () => {
  beforeEach(() => {
    resetStdin({ tty: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('prompt label and stream setup', () => {
    it('should write the label and switch stdin into raw + utf8 mode on a TTY', async () => {
      const promise = promptPassphrase('Alice keystore');
      mockStdin.emit('data', Buffer.from('x\n'));
      await promise;

      expect(mockStderr.write).toHaveBeenCalledWith(
        'Passphrase for Alice keystore: ',
      );
      expect(mockStdin.setRawMode).toHaveBeenCalledWith(true);
      expect(mockStdin.resume).toHaveBeenCalled();
      expect(mockStdin.setEncoding).toHaveBeenCalledWith('utf8');
    });

    it('should NOT call setRawMode when stdin is not a TTY', async () => {
      resetStdin({ tty: false });
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('\n'));
      await promise;

      expect(mockStdin.setRawMode).not.toHaveBeenCalled();
      expect(mockStdin.resume).toHaveBeenCalled();
    });
  });

  describe('successful read paths', () => {
    it('should resolve with the typed characters on CR (0x0d)', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('hunter2'));
      mockStdin.emit('data', Buffer.from([0x0d]));
      const pp = await promise;

      expect(pp).toBe('hunter2');
      expect(mockStdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(mockStdin.pause).toHaveBeenCalled();
      expect(mockStderr.write).toHaveBeenLastCalledWith('\n');
    });

    it('should resolve on LF (0x0a)', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('p4ss\n'));
      const pp = await promise;
      expect(pp).toBe('p4ss');
    });

    it('should return an empty string when user presses Enter immediately', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('\n'));
      const pp = await promise;
      expect(pp).toBe('');
    });

    it('should handle DEL (0x7f) as backspace', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('abc'));
      mockStdin.emit('data', Buffer.from([0x7f]));
      mockStdin.emit('data', Buffer.from('d\n'));
      const pp = await promise;
      expect(pp).toBe('abd');
    });

    it('should handle BS (0x08) as backspace', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('xyz'));
      mockStdin.emit('data', Buffer.from([0x08, 0x08]));
      mockStdin.emit('data', Buffer.from('a\n'));
      const pp = await promise;
      expect(pp).toBe('xa');
    });

    it('should delete a whole astral character on backspace, not half a surrogate pair', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('pw🔒'));
      mockStdin.emit('data', Buffer.from([0x7f]));
      mockStdin.emit('data', Buffer.from('x\n'));
      const pp = await promise;
      expect(pp).toBe('pwx');
    });

    it('should drop a trailing backspace that empties the buffer', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from([0x7f]));
      mockStdin.emit('data', Buffer.from('q\n'));
      const pp = await promise;
      expect(pp).toBe('q');
    });
  });

  describe('abort path', () => {
    it('should reject with "Aborted" on Ctrl+C (0x03)', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('partial'));
      mockStdin.emit('data', Buffer.from([0x03]));
      await expect(promise).rejects.toThrow('Aborted');
      expect(mockStdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(mockStdin.pause).toHaveBeenCalled();
    });

    it('should ignore characters after Ctrl+C within the same chunk', async () => {
      const promise = promptPassphrase('label');
      // 0x03 short-circuits the loop; "abc\n" after it must not resolve.
      mockStdin.emit('data', Buffer.from([0x03, 0x61, 0x62, 0x63, 0x0a]));
      await expect(promise).rejects.toThrow('Aborted');
    });
  });

  describe('stream close path', () => {
    it('should reject with "Aborted" when stdin ends with an empty buffer', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('end');
      await expect(promise).rejects.toThrow('Aborted');
    });

    it('should resolve with the buffer when stdin ends without a trailing newline', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('data', Buffer.from('piped-secret'));
      mockStdin.emit('end');
      await expect(promise).resolves.toBe('piped-secret');
    });

    it('should reject when stdin emits an error', async () => {
      const promise = promptPassphrase('label');
      mockStdin.emit('error', new Error('stream boom'));
      await expect(promise).rejects.toThrow('stream boom');
    });
  });
});
