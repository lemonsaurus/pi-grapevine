import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestBroker } from '../src/broker.js';
import type { GrapevinePaths } from '../src/paths.js';

const alice = { id: 'alice-id', name: 'alice', cwd: '/tmp/alice', pid: process.pid };
const bob = { id: 'bob-id', name: 'bob', cwd: '/tmp/bob', pid: process.pid };

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

test('transient session updates do not bloat state on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths = testPaths(dir);
  const worker = { id: 'worker-concurrent', name: 'worker', cwd: '/tmp/worker', pid: process.pid, sessionId: 'pi-session-concurrent' };

  try {
    await requestBroker({ type: 'session_register', peer: worker }, paths);
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        requestBroker({
          type: 'session_event',
          peer: worker,
          eventType: 'message_update',
          data: { role: 'assistant', content: `chunk ${index}` },
        }, paths),
      ),
    );

    const saved = JSON.parse(await readFile(paths.state, 'utf8')) as { events?: unknown[] };
    assert.equal(saved.events?.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('busy state survives event retention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths = testPaths(dir);
  const manager = { id: 'manager-busy', name: 'manager', cwd: '/tmp/manager', pid: process.pid };
  const worker = { id: 'worker-busy', name: 'worker', cwd: '/tmp/worker', pid: process.pid, sessionId: 'pi-session-busy' };

  try {
    await requestBroker({ type: 'session_register', peer: worker }, paths);
    await requestBroker({ type: 'session_event', peer: worker, eventType: 'agent_start', data: { type: 'agent_start' } }, paths);
    for (let index = 0; index < 600; index += 1) {
      await requestBroker({ type: 'session_event', peer: worker, eventType: 'message_end', data: { role: 'assistant', content: `answer ${index}` } }, paths);
    }

    const status = await requestBroker({ type: 'session_status', peer: manager, target: 'worker' }, paths);
    assert.equal(status.ok, true);
    assert.equal('statuses' in status && status.statuses[0]?.busy, true);
    assert.equal('statuses' in status && status.statuses[0]?.lastAnswer, 'answer 599');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dead sessions are pruned from telemetry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths = testPaths(dir);
  const manager = { id: 'manager-prune', name: 'manager', cwd: '/tmp/manager', pid: process.pid };
  const deadWorker = { id: 'worker-dead', name: 'worker', cwd: '/tmp/worker', pid: 99999999, sessionId: 'pi-session-dead' };

  try {
    await requestBroker({ type: 'session_register', peer: deadWorker }, paths);

    const daemon = await requestBroker({ type: 'daemon_status', peer: manager }, paths);
    assert.equal(daemon.ok, true);
    assert.equal('daemon' in daemon && daemon.daemon.sessionCount, 0);
    assert.equal('daemon' in daemon && daemon.daemon.prunedPeerCount, 1);
    assert.equal('daemon' in daemon && typeof daemon.daemon.stateBytes, 'number');
    assert.equal('daemon' in daemon && typeof daemon.daemon.auditBytes, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sessions unregister on shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths = testPaths(dir);
  const worker = { id: 'worker-unregister', name: 'worker', cwd: '/tmp/worker', pid: process.pid, sessionId: 'pi-session-unregister' };

  try {
    await requestBroker({ type: 'session_register', peer: worker }, paths);
    const removed = await requestBroker({ type: 'session_unregister', peer: worker }, paths);
    assert.equal(removed.ok, true);

    const listed = await requestBroker({ type: 'session_list', peer: { id: 'manager-unregister', name: 'manager', cwd: '/tmp/manager', pid: process.pid } }, paths);
    assert.equal(listed.ok, true);
    assert.equal('sessions' in listed && listed.sessions.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sessions can queue control commands and read events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-grapevine-'));
  const paths = testPaths(dir);
  const manager = { id: 'manager-id', name: 'manager', cwd: '/tmp/manager', pid: process.pid };
  const worker = { id: 'worker-id', name: 'worker', cwd: '/tmp/worker', pid: process.pid, sessionId: 'pi-session-1', sessionFile: '/tmp/session.jsonl' };

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

    const updated = await requestBroker({ type: 'session_command_update', peer: worker, commandId: 'command' in queued ? queued.command.id : '', state: 'running' }, paths);
    assert.equal(updated.ok, true);
    assert.equal('record' in updated && updated.record.state, 'running');

    await requestBroker({ type: 'session_event', peer: worker, eventType: 'agent_start', data: { type: 'agent_start' } }, paths);
    await requestBroker({ type: 'session_event', peer: worker, eventType: 'message_end', data: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, paths);
    const events = await requestBroker({ type: 'session_events', peer: manager, target: 'pi-session-1' }, paths);
    assert.equal(events.ok, true);
    assert.equal('events' in events && events.events.at(-1)?.type, 'message_end');

    const status = await requestBroker({ type: 'session_status', peer: manager, target: 'pi-session-1' }, paths);
    assert.equal(status.ok, true);
    assert.equal('statuses' in status && status.statuses[0]?.busy, true);
    assert.equal('statuses' in status && status.statuses[0]?.lastAnswer, 'done');

    const daemon = await requestBroker({ type: 'daemon_status', peer: manager }, paths);
    assert.equal(daemon.ok, true);
    assert.equal('daemon' in daemon && daemon.daemon.sessionCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function testPaths(dir: string): GrapevinePaths {
  return {
    dir,
    socket: join(dir, 'broker.sock'),
    auditLog: join(dir, 'audit.jsonl'),
    state: join(dir, 'state.json'),
  };
}
