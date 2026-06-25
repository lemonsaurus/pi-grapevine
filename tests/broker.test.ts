import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBroker } from '../src/broker.js';
import type { GrapevinePaths, } from '../src/paths.js';

const alice = { id: 'alice-id', name: 'alice', cwd: '/tmp/alice', pid: 101 };
const bob = { id: 'bob-id', name: 'bob', cwd: '/tmp/bob', pid: 202 };

test('peers can list, send, and read messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths: GrapevinePaths = {
    dir,
    socket: join(dir, 'broker.sock'),
    auditLog: join(dir, 'audit.jsonl'),
  };

  try {
    await requestBroker({ type: 'hello', peer: alice }, paths);
    await requestBroker({ type: 'hello', peer: bob }, paths);

    const list = await requestBroker({ type: 'list', peer: alice }, paths);
    assert.equal(list.ok, true);
    assert.equal('peers' in list && list.peers.length, 2);

    const send = await requestBroker({ type: 'send', peer: alice, to: 'bob', body: 'ping' }, paths);
    assert.equal(send.ok, true);
    assert.equal('status' in send && send.status, 'delivered');

    const inbox = await requestBroker({ type: 'inbox', peer: bob }, paths);
    assert.equal(inbox.ok, true);
    assert.equal('inbox' in inbox && inbox.inbox?.[0]?.body, 'ping');

    const empty = await requestBroker({ type: 'inbox', peer: bob }, paths);
    assert.equal(empty.ok, true);
    assert.equal('inbox' in empty && empty.inbox?.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
