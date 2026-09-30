import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const demo = readFileSync(new URL('../src/i595Demo.js', import.meta.url), 'utf8');

test('I-595 has a first-paint loader before the dynamic application import', () => {
  const guard = index.indexOf("document.documentElement.classList.add('i595-booting')");
  const loader = index.indexOf('id="i595-boot-loader"');
  const entry = index.indexOf('src="/src/entry.js"');
  assert.ok(guard > 0 && loader > guard && entry > loader);
  assert.match(index, /html\.i595-booting body > :not\(#i595-boot-loader\)/);
});

test('the I-595 module preserves the loader during body replacement and removes it when ready', () => {
  assert.match(demo, /bootLoaderMarkup/);
  assert.match(demo, /classList\.remove\('i595-booting'\)/);
  assert.match(demo, /querySelector\('#i595-boot-loader'\)\?\.remove\(\)/);
});
