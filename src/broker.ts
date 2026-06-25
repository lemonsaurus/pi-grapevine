import { appendFile, chmod, mkdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { basename } from 'node:path';
import { cwd, pid } from 'node:process';
import { grapevinePaths, type GrapevinePaths } from './paths.js';
import {
  maxBodyBytes,
  peerTtlMs,
  type ControlCommand,
  type GrapevineMessage,
  type GrapevineRequest,
  type GrapevineResponse,
  type Peer,
  type PeerInput,
  type SessionEvent,
} from './protocol.js';

let server: Server | undefined;

type State = {
  peers: Map<string, Peer>;
  inboxes: Map<string, GrapevineMessage[]>;
  commands: Map<string, ControlCommand[]>;
  events: SessionEvent[];
  nextEventId: number;
  paths: GrapevinePaths;
  idleTimer?: NodeJS.Timeout;
};

const state: State = {
  peers: new Map(),
  inboxes: new Map(),
  commands: new Map(),
  events: [],
  nextEventId: 1,
  paths: grapevinePaths(),
};

export function currentPeer(input: Partial<PeerInput> = {}): PeerInput {
  const name = input.name || process.env.PI_GRAPEVINE_NAME || basename(cwd()) || 'pi';
  const sessionPart = input.sessionId ? `:${input.sessionId}` : '';
  const id = input.id || createHash('sha256').update(`${name}:${cwd()}:${pid}${sessionPart}`).digest('hex').slice(0, 12);
  return { id, name, cwd: input.cwd ?? cwd(), pid: input.pid ?? pid, sessionId: input.sessionId, sessionFile: input.sessionFile };
}

export async function requestBroker(request: GrapevineRequest, paths = grapevinePaths()): Promise<GrapevineResponse> {
  await ensureBroker(paths);
  return sendRequest(request, paths.socket);
}

export async function ensureBroker(paths = grapevinePaths()): Promise<void> {
  try {
    await ping(paths.socket);
  } catch {
    await startBroker(paths);
  }
}

async function startBroker(paths: GrapevinePaths): Promise<void> {
  if (server?.listening && state.paths.socket === paths.socket) return;
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }

  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  await rm(paths.socket, { force: true });
  state.paths = paths;

  server = createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) return;
      void handleLine(socket, buffer.slice(0, lineEnd));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(paths.socket, () => {
      server!.off('error', reject);
      resolve();
    });
  });
  await chmod(paths.socket, 0o600);
  server.unref();
  armIdleExit();
}

async function handleLine(socket: Socket, line: string) {
  try {
    socket.end(`${JSON.stringify(await handleRequest(JSON.parse(line) as GrapevineRequest))}\n`);
  } catch (error) {
    socket.end(`${JSON.stringify({ ok: false, status: 'not_found', error: String(error) })}\n`);
  }
}

async function handleRequest(request: GrapevineRequest): Promise<GrapevineResponse> {
  armIdleExit();
  prunePeers();
  if (request.type === 'ping') return { ok: true, status: 'pong' };

  const peer = touchPeer(request.peer);
  if (request.type === 'hello') return hello(peer);
  if (request.type === 'list') return { ok: true, peers: [...state.peers.values()] };
  if (request.type === 'inbox') return takeInbox(peer);
  if (request.type === 'session_register') return registerSession(peer);
  if (request.type === 'session_list') return { ok: true, sessions: sessions() };
  if (request.type === 'session_prompt') return queueCommand(peer, request.target, { id: randomUUID(), type: 'prompt', text: request.text, deliverAs: request.deliverAs, createdAt: Date.now() });
  if (request.type === 'session_abort') return queueCommand(peer, request.target, { id: randomUUID(), type: 'abort', createdAt: Date.now() });
  if (request.type === 'session_take_commands') return takeCommands(peer);
  if (request.type === 'session_event') return recordEvent(peer, request.eventType, request.data);
  if (request.type === 'session_events') return readEvents(request.target, request.after ?? 0);
  return sendMessage(peer, request.to, request.body, request.replyTo);
}

async function hello(peer: Peer): Promise<GrapevineResponse> {
  await audit('hello', { peer: peer.id, name: peer.name, sessionId: peer.sessionId });
  return { ok: true, peer, inbox: state.inboxes.get(peer.id) ?? [] };
}

function takeInbox(peer: Peer): GrapevineResponse {
  const inbox = state.inboxes.get(peer.id) ?? [];
  state.inboxes.set(peer.id, []);
  return { ok: true, peer, inbox };
}

async function registerSession(peer: Peer): Promise<GrapevineResponse> {
  await audit('session_register', { peer: peer.id, name: peer.name, sessionId: peer.sessionId });
  return { ok: true, peer };
}

function sessions(): Peer[] {
  return [...state.peers.values()].filter((peer) => peer.sessionId);
}

async function queueCommand(from: Peer, target: string, command: ControlCommand): Promise<GrapevineResponse> {
  const match = findSession(target, from.id);
  if (!match.ok) return match;
  state.commands.set(match.peer.id, [...(state.commands.get(match.peer.id) ?? []), command]);
  await audit('command', { from: from.id, to: match.peer.id, command: command.type });
  return { ok: true, status: 'queued', command };
}

function takeCommands(peer: Peer): GrapevineResponse {
  const commands = state.commands.get(peer.id) ?? [];
  state.commands.set(peer.id, []);
  return { ok: true, commands };
}

async function recordEvent(peer: Peer, type: string, data: unknown): Promise<GrapevineResponse> {
  const event = { id: state.nextEventId++, sessionId: peer.id, type, at: Date.now(), data };
  state.events.push(event);
  state.events = state.events.slice(-500);
  await audit('event', { peer: peer.id, type });
  return { ok: true, status: 'recorded', event };
}

function readEvents(target: string, after: number): GrapevineResponse {
  const match = findSession(target);
  if (!match.ok) return match;
  return { ok: true, events: state.events.filter((event) => event.sessionId === match.peer.id && event.id > after) };
}

async function sendMessage(peer: Peer, to: string, body: string, replyTo?: string): Promise<GrapevineResponse> {
  if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
    await audit('send_failed', { from: peer.id, to, status: 'too_large' });
    return { ok: false, status: 'too_large', error: 'Message body is too large.' };
  }

  const matches = findPeers(to, peer.id);
  if (matches.length === 0) return failure('not_found', 'No matching peer.', { from: peer.id, to });
  if (matches.length > 1) return failure('ambiguous', 'Peer name is ambiguous. Use the peer id.', { from: peer.id, to });

  const message = { id: randomUUID(), from: peer.id, to: matches[0].id, body, replyTo, createdAt: Date.now() };
  state.inboxes.set(message.to, [...(state.inboxes.get(message.to) ?? []), message]);
  await audit('send', { id: message.id, from: message.from, to: message.to, replyTo: message.replyTo });
  const { body: _body, ...metadata } = message;
  return { ok: true, status: 'delivered', message: metadata };
}

async function failure(status: 'not_found' | 'ambiguous', error: string, data: Record<string, unknown>): Promise<GrapevineResponse> {
  await audit('send_failed', { ...data, status });
  return { ok: false, status, error };
}

function touchPeer(peer: PeerInput): Peer {
  const seen = { ...peer, lastSeen: Date.now() };
  state.peers.set(peer.id, seen);
  return seen;
}

function findPeers(target: string, senderId?: string): Peer[] {
  return [...state.peers.values()].filter((peer) => peer.id !== senderId && (peer.id === target || peer.name === target));
}

function findSession(target: string, senderId?: string): { ok: true; peer: Peer } | { ok: false; status: 'not_found' | 'ambiguous'; error: string } {
  const matches = sessions().filter((peer) => peer.id !== senderId && (peer.id === target || peer.name === target || peer.sessionId === target));
  if (matches.length === 0) return { ok: false, status: 'not_found', error: 'No matching session.' };
  if (matches.length > 1) return { ok: false, status: 'ambiguous', error: 'Session name is ambiguous. Use the peer id or Pi session id.' };
  return { ok: true, peer: matches[0] };
}

function prunePeers() {
  const cutoff = Date.now() - peerTtlMs;
  for (const [id, peer] of state.peers) {
    if (peer.lastSeen < cutoff) {
      state.peers.delete(id);
      state.commands.delete(id);
    }
  }
}

async function audit(event: string, data: Record<string, unknown>) {
  await appendFile(state.paths.auditLog, `${JSON.stringify({ event, at: Date.now(), ...data })}\n`, { mode: 0o600 });
  await chmod(state.paths.auditLog, 0o600);
}

function armIdleExit() {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    void server?.close();
    server = undefined;
  }, 30 * 60 * 1000);
  state.idleTimer.unref();
}

function ping(socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => socket.end(`${JSON.stringify({ type: 'ping' })}\n`));
    socket.once('data', () => resolve());
    socket.once('error', reject);
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error('broker ping timed out'));
    });
  });
}

function sendRequest(request: GrapevineRequest, socketPath: string): Promise<GrapevineResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd === -1) return;
      resolve(JSON.parse(buffer.slice(0, lineEnd)) as GrapevineResponse);
      socket.end();
    });
    socket.once('error', reject);
  });
}
