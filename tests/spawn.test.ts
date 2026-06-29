import test from 'node:test';
import assert from 'node:assert/strict';
import { workerSpawnExec } from '../src/spawn.js';

test('worker spawn keeps simple tmux window behavior', () => {
  const spawn = workerSpawnExec({ name: 'lane-a', cwd: '/tmp/work', extensionPath: '/tmp/gv.js' });

  assert.equal(spawn.bin, 'tmux');
  assert.deepEqual(spawn.args.slice(0, 6), ['new-window', '-d', '-c', '/tmp/work', '-n', 'gv-lane-a']);
});

test('worker spawn uses agency window grouping', () => {
  const spawn = workerSpawnExec({ name: 'lane-a', cwd: '/tmp/work', extensionPath: '/tmp/gv.js', group: 'typecast-reviews' });

  assert.equal(spawn.bin, 'agency');
  assert.equal(spawn.location, '/tmp/work in typecast-reviews');
  assert.deepEqual(spawn.args.slice(0, 4), ['spawn', '--window', 'typecast-reviews', '--cmd']);
  assert.equal(spawn.args.at(-1), '/tmp/work');
});
