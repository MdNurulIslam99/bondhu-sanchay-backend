// The way Vercel starts the app: without server.js, and unable to require() ES-module-only packages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const run = code => spawnSync(process.execPath, ['--no-experimental-require-module', '--input-type=module', '-e', code], {
  encoding: 'utf8', timeout: 60000,
  env: { PATH: process.env.PATH, NODE_ENV: 'production', MONGODB_URI: 'mongodb://127.0.0.1:1/x' },
});

test('the app loads when require() cannot load ES modules', () => {
  const result = run("const { default: app } = await import('./src/app.js'); process.exit(typeof app === 'function' ? 0 : 2)");
  assert.equal(result.status, 0, result.stderr);
});

test('rich text stays clean with the pinned HTML parser', () => {
  const attacks = [
    '<p onclick="steal()">a</p>', '<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt&#58;alert(1)">x</a>', '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '<svg><script>alert(1)</script></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', '<iframe src="https://evil.example"></iframe>', '<style>body{display:none}</style>',
    '<textarea></textarea><script>alert(1)</script>', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', '<xmp><script>alert(1)</script></xmp>',
    '<p><!--><img src=x onerror=alert(1)>--></p>', '<a href="//evil.example">x</a>', '<option><script>alert(1)</script></option>',
  ];
  const result = run(`const { cleanHtml } = await import('./src/lib/html.js');
    console.log(JSON.stringify(${JSON.stringify(attacks)}.map(cleanHtml)));`);
  assert.equal(result.status, 0, result.stderr);
  for (const [index, output] of JSON.parse(result.stdout).entries()) {
    // No live element or attribute may survive; escaped text such as "&lt;img" is harmless.
    assert.doesNotMatch(output, /<(?!\/?(?:p|br|h2|h3|ul|ol|li|strong|em|a)[\s>/])|<[^>]*\son\w+\s*=|<a[^>]*href="(?!https?:|mailto:|tel:)[^"]*"/i, `${attacks[index]} => ${output}`);
  }
});
