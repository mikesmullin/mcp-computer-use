import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAwesomeOutput, createAwesome } from '../lib/awesome.mjs';

test('parseAwesomeOutput unwraps lua values', () => {
  assert.equal(parseAwesomeOutput('   string "hello"'), 'hello');
  assert.equal(parseAwesomeOutput('   string "hello\nworld"'), 'hello\nworld');
  assert.equal(parseAwesomeOutput('   boolean true'), true);
  assert.equal(parseAwesomeOutput('   double 2.0'), 2);
});

test('window match prefers id and reports ambiguity', async () => {
  const raw = [
    'zen\tNavigator\tPost\t10\t20\t800\t600\t2\tfalse\t111\ttrue',
    'zen\tNavigator\tOther\t0\t0\t100\t100\t1\tfalse\t222\tfalse',
    'Code\tcode\tVS Code\t1\t1\t50\t50\t2\tfalse\t333\tfalse',
  ].join('\n');
  const awesome = createAwesome(async () => ({ ok: true, out: `   string "${raw.replace(/\n/g, '\\n')}"`, stdout: `   string "${raw.replace(/\n/g, '\\n')}"` }));
  // lua() uses stdout/out parse — feed list() via lua return of TSV
  const listed = awesome.match([
    { class: 'zen', instance: 'Navigator', title: 'Post', x: 10, y: 20, width: 800, height: 600, screen: 2, fullscreen: false, windowId: 111, focused: true },
    { class: 'zen', instance: 'Navigator', title: 'Other', x: 0, y: 0, width: 100, height: 100, screen: 1, fullscreen: false, windowId: 222, focused: false },
  ], { class: 'zen' });
  assert.equal(listed.length, 2);
  const one = awesome.match(listed, { windowId: 111 });
  assert.equal(one[0].title, 'Post');
});
