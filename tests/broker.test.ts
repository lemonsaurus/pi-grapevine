import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBroker } from '../src/broker.js';
import type { GrapevinePaths } from '../src/paths.js';

const alice = { id: 'alice-id', name: 'alice', cwd: '/tmp/alice', pid: 101 };
const bob = { id: 'bob-id', name: 'bob', cwd: '/tmp/bob', pid: 202 };

test('peers can list, send, and read messages', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths = testPaths(dir);

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

test('sessions can queue control commands and read events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths = testPaths(dir);
  const manager = { id: 'manager-id', name: 'manager', cwd: '/tmp/manager', pid: 303 };
  const worker = { id: 'worker-id', name: 'worker', cwd: '/tmp/worker', pid: 404, sessionId: 'pi-session-1', sessionFile: '/tmp/session.jsonl' };

  try {
    await requestBroker({ type: 'session_register', peer: worker }, paths);

    const sessions = await requestBroker({ type: 'session_list', peer: manager }, paths);
    assert.equal(sessions.ok, true);
    assert.equal('sessions' in sessions && sessions.sessions[0]?.sessionId, 'pi-session-1');

    const queued = await requestBroker({ type: 'session_prompt', peer: manager, target: 'worker', text: '/skill:load', deliverAs: 'steer' }, paths);
    assert.equal(queued.ok, true);
    assert.equal('command' in queued && queued.command.type, 'prompt');

    const commands = await requestBroker({ type: 'session_take_commands', peer: worker }, paths);
    assert.equal(commands.ok, true);
    assert.equal('commands' in commands && commands.commands[0]?.type, 'prompt');

    await requestBroker({ type: 'session_event', peer: worker, eventType: 'message_end', data: { role: 'assistant', content: 'done' } }, paths);
    const events = await requestBroker({ type: 'session_events', peer: manager, target: 'pi-session-1' }, paths);
    assert.equal(events.ok, true);
    assert.equal('events' in events && events.events[0]?.type, 'message_end');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function testPaths(dir: string): GrapevinePaths {
  return {
    dir,
    socket: join(dir, 'broker.sock'),
    auditLog: join(dir, 'audit.jsonl'),
  };
}
