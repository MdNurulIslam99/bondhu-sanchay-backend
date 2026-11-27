// Terminal questions; secret answers are not echoed.
import readline from 'node:readline';
import { Writable } from 'node:stream';

export function createPrompt() {
  let hidden = false;
  const output = new Writable({ write: (chunk, encoding, done) => { if (!hidden) process.stdout.write(chunk, encoding); done(); } });
  const input = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const lines = input[Symbol.asyncIterator]();
  return {
    async ask(question, secret = false) {
      process.stdout.write(question);
      hidden = secret;
      const { value, done } = await lines.next();
      hidden = false;
      if (secret) process.stdout.write('\n');
      if (done) throw new Error('Cancelled');
      return value.trim();
    },
    close: () => input.close(),
  };
}
