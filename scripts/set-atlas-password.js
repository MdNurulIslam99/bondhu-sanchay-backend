// Asks for the Atlas password without showing it, then activates the Atlas URI in .env.
import { readFile, writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import { Writable } from 'node:stream';

const file = new URL('../.env', import.meta.url);
const text = await readFile(file, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);
const placeholder = /^\s*#?\s*MONGODB_URI=(mongodb\+srv:\/\/[^:]+:)<db_password>(@.*)$/;
const target = lines.findIndex(line => placeholder.test(line));
if (target === -1) {
  console.error('No Atlas MONGODB_URI containing <db_password> was found in .env.');
  process.exit(1);
}

const silent = new Writable({ write: (chunk, encoding, done) => done() });
const input = readline.createInterface({ input: process.stdin, output: silent, terminal: true });
process.stdout.write('Atlas database password (hidden), then Enter: ');
const password = await new Promise(resolve => {
  input.once('line', resolve);
  input.once('SIGINT', () => resolve(''));
  input.once('close', () => resolve(''));
});
input.close();
process.stdout.write('\n');
if (!password) {
  console.error('No password entered. .env was not changed.');
  process.exit(1);
}

const [, start, end] = lines[target].match(placeholder);
const updated = lines.map((line, index) => {
  if (index === target) return `MONGODB_URI=${start}${encodeURIComponent(password)}${end}`;
  if (/^\s*MONGODB_URI=/.test(line)) return `# ${line}`;
  if (line.startsWith('# MongoDB Atlas:')) return '# MongoDB Atlas is active. For the local database, swap which MONGODB_URI line is commented.';
  return line;
});
await writeFile(file, updated.join(eol));
console.log('.env now uses MongoDB Atlas. Next: npm run db:migrate, then npm run dev');
