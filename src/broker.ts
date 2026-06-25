import { appendFile, chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { basename } from 'node:path';
import { cwd, pid } from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { grapevinePaths, type GrapevinePaths } from './paths.js';
import { maxBodyBytes, peerTtlMs, type GrapevineMessage, type GrapevineRequest, type GrapevineResponse, type Peer } from './protocol.js';

let server: Server | undefined;

type State = {
  peers: Map<string, Peer>;
  inboxes: Map<string, GrapevineMessage[]>;
  paths: GrapevinePaths;
  idleTimer?: NodeJS.Timeout;
};

const state: State = {
  peers: new Map(),
  inboxes: new Map(),
  paths: grapevinePaths(),
};

export function currentPeer(): Omit<Peer, 'lastSeen'> {
  const name = process.env.PI_GRAPEVINE_NAME || basename(cwd()) || 'pi';
  const id = createHash('sha256').update(`${name}:${cwd()}:${pid}`).digest('hex').slice(0, 12);
  return { id, name, cwd: cwd(), pid };
}

export async function requestBroker(request: GrapevineRequest, paths = grapevinePaths()): Promise<GrapevineResponse> {
  await ensureBroker(paths);
  return sendRequest(request, paths.socket);
}

export async function ensureBroker(paths = grapevinePaths()): Promise<void> {
  try {
    await ping(paths.socket);
    return;
  } catch {
    await startBroker(paths);
  }
}

async function startBroker(paths: GrapevinePaths): Promise<void> {
  if (server?.listening) return;

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
      const line = buffer.slice(0, lineEnd);
      void handleLine(socket, line);
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
    const request = JSON.parse(line) as GrapevineRequest;
    const response = await handleRequest(request);
    socket.end(`${JSON.stringify(response)}\n`);
  } catch (error) {
    socket.end(`${JSON.stringify({ ok: false, status: 'not_found', error: String(error) })}\n`);
  }
}

async function handleRequest(request: GrapevineRequest): Promise<GrapevineResponse> {
  armIdleExit();
  prunePeers();
  if (request.type === 'ping') return { ok: true, status: 'pong' };

  const peer = touchPeer(request.peer);

  if (request.type === 'hello') {
    await audit('hello', { peer: peer.id, name: peer.name });
    return { ok: true, peer, inbox: state.inboxes.get(peer.id) ?? [] };
  }

  if (request.type === 'list') return { ok: true, peers: [...state.peers.values()] };

  if (request.type === 'inbox') {
    const inbox = state.inboxes.get(peer.id) ?? [];
    state.inboxes.set(peer.id, []);
    return { ok: true, peer, inbox };
  }

  if (Buffer.byteLength(request.body, 'utf8') > maxBodyBytes) {
    await audit('send_failed', { from: peer.id, to: request.to, status: 'too_large' });
    return { ok: false, status: 'too_large', error: 'Message body is too large.' };
  }

  const matches = findPeers(request.to, peer.id);
  if (matches.length === 0) {
    await audit('send_failed', { from: peer.id, to: request.to, status: 'not_found' });
    return { ok: false, status: 'not_found', error: 'No matching peer.' };
  }
  if (matches.length > 1) {
    await audit('send_failed', { from: peer.id, to: request.to, status: 'ambiguous' });
    return { ok: false, status: 'ambiguous', error: 'Peer name is ambiguous. Use the peer id.' };
  }

  const message: GrapevineMessage = {
    id: randomUUID(),
    from: peer.id,
    to: matches[0].id,
    body: request.body,
    replyTo: request.replyTo,
    createdAt: Date.now(),
  };
  state.inboxes.set(message.to, [...(state.inboxes.get(message.to) ?? []), message]);
  await audit('send', { id: message.id, from: message.from, to: message.to, replyTo: message.replyTo });
  const { body: _body, ...metadata } = message;
  return { ok: true, status: 'delivered', message: metadata };
}

function touchPeer(peer: Omit<Peer, 'lastSeen'>): Peer {
  const seen = { ...peer, lastSeen: Date.now() };
  state.peers.set(peer.id, seen);
  return seen;
}

function findPeers(target: string, senderId: string): Peer[] {
  return [...state.peers.values()].filter((peer) => peer.id !== senderId && (peer.id === target || peer.name === target));
}

function prunePeers() {
  const cutoff = Date.now() - peerTtlMs;
  for (const [id, peer] of state.peers) {
    if (peer.lastSeen < cutoff) state.peers.delete(id);
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
