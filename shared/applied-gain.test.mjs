// node --test shared/   (Node 22.18 or later: it reads the .ts file directly)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appliedGain } from './applied-gain.ts';

const el = (volume = 1, more = {}) => ({ volume, muted: false, paused: false, ...more });
const node = (value, state = 'running') => ({ gain: { value }, context: { state } });

test('the gain path reports what the node holds, past 100% included', () => {
  assert.deepEqual(appliedGain(el(1), node(0.15)), { path: 'gain', applied: 0.15, running: true });
  assert.deepEqual(appliedGain(el(1), node(2.4)), { path: 'gain', applied: 2.4, running: true });
});

test('the element\'s own volume multiplies in front of the node', () => {
  assert.deepEqual(appliedGain(el(0.5), node(2)), { path: 'gain', applied: 1, running: true });
});

test('the element path is the element\'s volume, which cannot pass 100%', () => {
  assert.deepEqual(appliedGain(el(1), null), { path: 'element', applied: 1, running: true });
  assert.deepEqual(appliedGain(el(0.3), undefined), { path: 'element', applied: 0.3, running: true });
});

test('no element is "off": there is nothing for a slider to change', () => {
  assert.deepEqual(appliedGain(null, null), { path: 'off', applied: null, running: false });
  assert.deepEqual(appliedGain(undefined, node(1)), { path: 'off', applied: null, running: false });
});

test('a context that is not running is not called running, whatever the gain reads', () => {
  assert.deepEqual(appliedGain(el(1), node(1, 'suspended')), { path: 'gain', applied: 1, running: false });
  assert.deepEqual(appliedGain(el(1), node(1, 'closed')), { path: 'gain', applied: 1, running: false });
  assert.equal(appliedGain(el(1), { gain: { value: 1 } }).running, true, 'a context that does not say its state');
});

test('a muted or paused element is not running, and a muted one applies nothing', () => {
  assert.deepEqual(appliedGain(el(1, { muted: true }), node(2)), { path: 'gain', applied: 0, running: false });
  assert.deepEqual(appliedGain(el(1, { paused: true }), node(2)), { path: 'gain', applied: 2, running: false });
  assert.deepEqual(appliedGain(el(0.4, { muted: true }), null), { path: 'element', applied: 0, running: false });
});

test('a value that is not a number is never reported as a gain', () => {
  assert.deepEqual(appliedGain(el(1), node(Number.NaN)), { path: 'gain', applied: null, running: false });
  assert.deepEqual(appliedGain(el(Number.NaN), null), { path: 'element', applied: null, running: false });
});

test('values are kept to four places, so 0.15 does not read 0.15000000596', () => {
  assert.equal(appliedGain(el(1), node(Math.fround(0.15))).applied, 0.15);
});

// The report is only worth something if it is read from the nodes of THIS sound. These hold the wiring in store.tsx.
test('the playback report carries both outputs of every playing sound, read from its own nodes', () => {
  const store = fs.readFileSync(new URL('../src/lib/store.tsx', import.meta.url), 'utf8');
  assert.match(store, /out: appliedGain\(playing\.audio, playing\.gain\)/);
  assert.match(store, /monitor: appliedGain\(playing\.monitorAudio, playing\.monitorGain\)/);
  for (const file of ['../shared/types.ts', '../electron/types.ts']) {
    const types = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(types, /out\?: AppliedGain/, `${file} does not carry "out"`);
    assert.match(types, /monitor\?: AppliedGain/, `${file} does not carry "monitor"`);
  }
});
