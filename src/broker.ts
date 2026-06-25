import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwd, pid } from 'node:process';
import { grapevinePaths, type GrapevinePaths } from './paths.js';
import { maxBodyBytes, peerTtlMs, type CommandRecord, type ControlCommand, type GrapevineMessage, type GrapevineRequest, type GrapevineResponse, type Peer, type PeerInput, type SessionEvent, type SessionStatus } from './protocol.js';

let server: Server | undefined;

type State = {
  peers: Map<string, Peer>;
  inboxes: Map<string, GrapevineMessage[]>;
  commands: Map<string, ControlCommand[]>;
  commandRecords: Map<string, CommandRecord>;
  events: SessionEvent[];
  nextEventId: number;
  paths: GrapevinePaths;
  idleTimer?: NodeJS.Timeout;
};

const state: State = {
  peers: new Map(),
  inboxes: new Map(),
  commands: new Map(),
  commandRecords: new Map(),
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
    return;
  } catch {
    if (paths.socket !== grapevinePaths().socket || process.env.PI_GRAPEVINE_IN_PROCESS === '1') {
      await startBroker(paths);
      return;
    }
    startDaemon(paths);
    await waitForBroker(paths.socket);
  }
}

export async function startBroker(paths: GrapevinePaths, options: { unref?: boolean } = { unref: true }): Promise<void> {
  if (server?.listening && state.paths.socket === paths.socket) return;
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server!.close((error) => (error ? reject(error) : resolve())));
    server = undefined;
  }

  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await chmod(paths.dir, 0o700);
  await rm(paths.socket, { force: true });
  state.paths = paths;
  await loadState();

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
  if (options.unref !== false) server.unref();
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
  if (request.type === 'daemon_status') return daemonStatus();
  if (request.type === 'hello') return hello(peer);
  if (request.type === 'list') return { ok: true, peers: [...state.peers.values()] };
  if (request.type === 'inbox') return takeInbox(peer);
  if (request.type === 'session_register') return registerSession(peer);
  if (request.type === 'session_list') return { ok: true, sessions: sessions() };
  if (request.type === 'session_status') return sessionStatus(request.target);
  if (request.type === 'session_prompt') return queueCommand(peer, request.target, { id: randomUUID(), type: 'prompt', text: request.text, deliverAs: request.deliverAs, createdAt: Date.now() });
  if (request.type === 'session_abort') return queueCommand(peer, request.target, { id: randomUUID(), type: 'abort', createdAt: Date.now() });
  if (request.type === 'session_compact') return queueCommand(peer, request.target, { id: randomUUID(), type: 'compact', createdAt: Date.now() });
  if (request.type === 'session_tree') return queueCommand(peer, request.target, { id: randomUUID(), type: 'tree', createdAt: Date.now() });
  if (request.type === 'session_navigate') return queueCommand(peer, request.target, { id: randomUUID(), type: 'navigate', targetEntryId: request.targetEntryId, createdAt: Date.now() });
  if (request.type === 'session_fork') return queueCommand(peer, request.target, { id: randomUUID(), type: 'fork', targetEntryId: request.targetEntryId, createdAt: Date.now() });
  if (request.type === 'session_clone') return queueCommand(peer, request.target, { id: randomUUID(), type: 'clone', targetEntryId: request.targetEntryId, createdAt: Date.now() });
  if (request.type === 'session_take_commands') return takeCommands(peer);
  if (request.type === 'session_command_update') return updateCommand(peer, request.commandId, request.state, request.error);
  if (request.type === 'session_event') return recordEvent(peer, request.eventType, request.data);
  if (request.type === 'session_events') return readEvents(request.target, request.after ?? 0);
  return sendMessage(peer, request.to, request.body, request.replyTo);
}

function daemonStatus(): GrapevineResponse {
  return {
    ok: true,
    daemon: {
      pid,
      socket: state.paths.socket,
      auditLog: state.paths.auditLog,
      stateFile: state.paths.state,
      peerCount: state.peers.size,
      sessionCount: sessions().length,
      eventCount: state.events.length,
      commandCount: state.commandRecords.size,
    },
  };
}

async function hello(peer: Peer): Promise<GrapevineResponse> {
  await audit('hello', { peer: peer.id, name: peer.name, sessionId: peer.sessionId });
  return { ok: true, peer, inbox: state.inboxes.get(peer.id) ?? [] };
}

function takeInbox(peer: Peer): GrapevineResponse {
  const inbox = state.inboxes.get(peer.id) ?? [];
  state.inboxes.set(peer.id, []);
  void persist();
  return { ok: true, peer, inbox };
}

async function registerSession(peer: Peer): Promise<GrapevineResponse> {
  await audit('session_register', { peer: peer.id, name: peer.name, sessionId: peer.sessionId });
  await persist();
  return { ok: true, peer };
}

function sessions(): Peer[] {
  return [...state.peers.values()].filter((peer) => peer.sessionId);
}

function sessionStatus(target?: string): GrapevineResponse {
  const selected = target ? [findSession(target)] : sessions().map((peer) => ({ ok: true as const, peer }));
  const statuses: SessionStatus[] = [];
  for (const item of selected) {
    if (!item.ok) return item;
    statuses.push(statusForPeer(item.peer));
  }
  return { ok: true, statuses };
}

function statusForPeer(peer: Peer): SessionStatus {
  const events = state.events.filter((event) => event.sessionId === peer.id);
  const currentTool = [...events].reverse().find((event) => event.type === 'tool_execution_start' || event.type === 'tool_execution_end');
  const lastAnswer = [...events].reverse().map((event) => assistantText(event.data)).find(Boolean);
  const commands = [...state.commandRecords.values()].filter((record) => record.sessionId === peer.id).slice(-20);
  return {
    peer,
    busy: lastLifecycle(events) === 'agent_start',
    currentTool: currentTool?.type === 'tool_execution_start' ? readToolName(currentTool.data) : undefined,
    lastAnswer,
    lastEventId: events.at(-1)?.id ?? 0,
    pendingCommands: state.commands.get(peer.id)?.length ?? 0,
    commands,
  };
}

async function queueCommand(from: Peer, target: string, command: ControlCommand): Promise<GrapevineResponse> {
  const match = findSession(target, from.id);
  if (!match.ok) return match;
  state.commands.set(match.peer.id, [...(state.commands.get(match.peer.id) ?? []), command]);
  const record = { id: command.id, sessionId: match.peer.id, type: command.type, state: 'queued' as const, createdAt: command.createdAt, updatedAt: Date.now() };
  state.commandRecords.set(command.id, record);
  await audit('command', { from: from.id, to: match.peer.id, command: command.type, commandId: command.id });
  await persist();
  return { ok: true, status: 'queued', command, record };
}

function takeCommands(peer: Peer): GrapevineResponse {
  const commands = state.commands.get(peer.id) ?? [];
  state.commands.set(peer.id, []);
  for (const command of commands) setCommand(command.id, 'accepted');
  void persist();
  return { ok: true, commands };
}

async function updateCommand(peer: Peer, commandId: string, commandState: CommandRecord['state'], error?: string): Promise<GrapevineResponse> {
  const record = setCommand(commandId, commandState, error);
  await audit('command_update', { peer: peer.id, commandId, state: commandState, error });
  await persist();
  return { ok: true, status: 'updated', record };
}

function setCommand(commandId: string, commandState: CommandRecord['state'], error?: string): CommandRecord {
  const current = state.commandRecords.get(commandId) ?? { id: commandId, sessionId: 'unknown', type: 'prompt' as const, state: 'queued' as const, createdAt: Date.now(), updatedAt: Date.now() };
  const next = { ...current, state: commandState, error, updatedAt: Date.now() };
  state.commandRecords.set(commandId, next);
  return next;
}

async function recordEvent(peer: Peer, type: string, data: unknown): Promise<GrapevineResponse> {
  const event = { id: state.nextEventId++, sessionId: peer.id, type, at: Date.now(), data };
  state.events.push(event);
  state.events = state.events.slice(-2000);
  await audit('event', { peer: peer.id, type });
  await persist();
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
  await persist();
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
  void persist();
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

async function loadState() {
  try {
    const saved = JSON.parse(await readFile(state.paths.state, 'utf8')) as {
      peers?: Peer[];
      inboxes?: Array<[string, GrapevineMessage[]]>;
      commands?: Array<[string, ControlCommand[]]>;
      commandRecords?: CommandRecord[];
      events?: SessionEvent[];
      nextEventId?: number;
    };
    state.peers = new Map(saved.peers?.map((peer) => [peer.id, peer]));
    state.inboxes = new Map(saved.inboxes ?? []);
    state.commands = new Map(saved.commands ?? []);
    state.commandRecords = new Map(saved.commandRecords?.map((record) => [record.id, record]));
    state.events = saved.events ?? [];
    state.nextEventId = saved.nextEventId ?? Math.max(0, ...state.events.map((event) => event.id)) + 1;
  } catch {}
}

async function persist() {
  await writeFile(state.paths.state, JSON.stringify({
    peers: [...state.peers.values()],
    inboxes: [...state.inboxes.entries()],
    commands: [...state.commands.entries()],
    commandRecords: [...state.commandRecords.values()].slice(-500),
    events: state.events.slice(-2000),
    nextEventId: state.nextEventId,
  }), { mode: 0o600 }).catch(() => undefined);
  await chmod(state.paths.state, 0o600).catch(() => undefined);
}

function lastLifecycle(events: SessionEvent[]): string | undefined {
  return [...events].reverse().find((event) => event.type === 'agent_start' || event.type === 'agent_end')?.type;
}

function readToolName(data: unknown): string | undefined {
  return typeof data === 'object' && data && 'toolName' in data ? String((data as { toolName?: unknown }).toolName) : undefined;
}

function assistantText(data: unknown): string | undefined {
  const record = typeof data === 'object' && data ? data as { role?: unknown; content?: unknown } : {};
  if (record.role !== 'assistant') return undefined;
  const content = record.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.map((part) => typeof part === 'object' && part && 'text' in part ? String((part as { text?: unknown }).text) : '').join('').trim();
  return text || undefined;
}

function armIdleExit() {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    void server?.close();
    server = undefined;
  }, 30 * 60 * 1000);
  state.idleTimer.unref();
}

function startDaemon(paths: GrapevinePaths) {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const sourceDaemon = resolve(baseDir, 'daemon.ts');
  const daemonPath = existsSync(sourceDaemon) ? sourceDaemon : resolve(baseDir, 'daemon.js');
  const child = spawn(process.execPath, ['--import', 'jiti/register', daemonPath, paths.dir], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function waitForBroker(socketPath: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await ping(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error('pi-grapevine daemon did not start');
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
