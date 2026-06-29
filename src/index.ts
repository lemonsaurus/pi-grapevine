import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentPeer, requestBroker } from './broker.js';
import type { ControlCommand, GrapevineMessage, Peer, PeerInput, SessionEvent, TaskDigest } from './protocol.js';
import { workerSpawnExec } from './spawn.js';

const pollTimers = new Map<string, NodeJS.Timeout>();
const activeCommands = new Map<string, string>();

export default function grapevine(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => activateSession(pi, ctx));
  pi.on('session_shutdown', (_event, ctx) => deactivateSession(ctx));
  pi.on('agent_start', (event, ctx) => postSessionEvent(ctx, 'agent_start', event));
  pi.on('agent_end', async (event, ctx) => {
    await postSessionEvent(ctx, 'agent_end', event);
    const commandId = activeCommands.get(peerForContext(ctx).id);
    if (commandId) await updateCommand(ctx, commandId, 'done');
    activeCommands.delete(peerForContext(ctx).id);
  });
  pi.on('message_update', (event, ctx) => postSessionEvent(ctx, 'message_update', event.assistantMessageEvent));
  pi.on('message_end', (event, ctx) => postSessionEvent(ctx, 'message_end', event.message));
  pi.on('tool_execution_start', (event, ctx) => postSessionEvent(ctx, 'tool_execution_start', event));
  pi.on('tool_execution_update', (event, ctx) => postSessionEvent(ctx, 'tool_execution_update', event));
  pi.on('tool_execution_end', (event, ctx) => postSessionEvent(ctx, 'tool_execution_end', event));

  pi.registerTool({
    name: 'grapevine_status',
    label: 'Grapevine Status',
    description: 'Show broker, current peer, and steerable session state.',
    parameters: Type.Object({ target: Type.Optional(Type.String()) }),
    async execute(_id, params: { target?: string }, _signal, _onUpdate, ctx) {
      const peer = peerForContext(ctx);
      const hello = await requestBroker({ type: 'hello', peer });
      const status = await requestBroker({ type: 'session_status', peer, target: params.target });
      return result([hello.ok && 'peer' in hello ? formatStatus(hello.peer, hello.inbox ?? []) : errorText(hello), status.ok && 'statuses' in status ? formatSessionStatuses(status.statuses) : errorText(status)].join('\n\n'), { hello, status });
    },
  });

  pi.registerTool({
    name: 'grapevine_daemon',
    label: 'Grapevine Daemon',
    description: 'Show local pi-grapevine daemon status.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'daemon_status', peer: peerForContext(ctx) });
      if (response.ok && 'daemon' in response) return result(JSON.stringify(response.daemon, null, 2), response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_list',
    label: 'Grapevine Peers',
    description: 'List local pi-grapevine peers.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'list', peer: peerForContext(ctx) });
      if (response.ok && 'peers' in response) return result(formatPeers(response.peers), response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_sessions',
    label: 'Grapevine Sessions',
    description: 'List steerable local Pi sessions.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_list', peer: peerForContext(ctx) });
      if (response.ok && 'sessions' in response) return result(formatSessions(response.sessions), response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_spawn',
    label: 'Grapevine Spawn',
    description: 'Spawn a named Pi worker in tmux with pi-grapevine loaded.',
    parameters: Type.Object({ name: Type.String(), cwd: Type.Optional(Type.String()), window: Type.Optional(Type.String()), group: Type.Optional(Type.String()) }),
    async execute(_id, params: { name: string; cwd?: string; window?: string; group?: string }, _signal, _onUpdate, ctx) {
      const extensionPath = fileURLToPath(import.meta.url);
      const workerCwd = resolve(params.cwd ?? ctx.cwd);
      const spawn = workerSpawnExec({ name: params.name, cwd: workerCwd, extensionPath, window: params.window, group: params.group });
      const execResult = await pi.exec(spawn.bin, spawn.args);
      const location = spawn.location;
      return result(execResult.code === 0 ? `Spawned ${params.name} in ${location}.` : execResult.stderr || execResult.stdout, { execResult });
    },
  });

  pi.registerTool({
    name: 'grapevine_prompt',
    label: 'Grapevine Prompt',
    description: 'Prompt or steer another local Pi session. Use deliverAs=steer for mid-work redirection and followUp to queue after completion.',
    parameters: Type.Object({ target: Type.String(), text: Type.String(), deliverAs: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('followUp')])) }),
    async execute(_id, params: { target: string; text: string; deliverAs?: 'steer' | 'followUp' }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_prompt', peer: peerForContext(ctx), target: params.target, text: params.text, deliverAs: params.deliverAs });
      if (response.ok && 'command' in response) return result(`Queued ${response.command.type} ${response.command.id}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_delegate',
    label: 'Grapevine Delegate',
    description: 'Send a task to a worker and wait for a digest with final answer, tools, and events.',
    parameters: Type.Object({ target: Type.String(), task: Type.String(), timeoutMs: Type.Optional(Type.Number()) }),
    async execute(_id, params: { target: string; task: string; timeoutMs?: number }, _signal, onUpdate, ctx) {
      const digest = await delegate(ctx, params.target, params.task, params.timeoutMs ?? 120_000, (line) => onUpdate?.({ content: [{ type: 'text', text: line }], details: {} }));
      return { content: [{ type: 'text', text: formatDigest(digest) }], details: digest };
    },
  });

  pi.registerTool({
    name: 'grapevine_abort',
    label: 'Grapevine Abort',
    description: 'Abort another local Pi session.',
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params: { target: string }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_abort', peer: peerForContext(ctx), target: params.target });
      if (response.ok && 'command' in response) return result(`Queued abort ${response.command.id}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_compact',
    label: 'Grapevine Compact',
    description: 'Ask another local Pi session to compact its context.',
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params: { target: string }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_compact', peer: peerForContext(ctx), target: params.target });
      if (response.ok && 'command' in response) return result(`Queued compact ${response.command.id}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_tree',
    label: 'Grapevine Tree',
    description: 'Ask another local Pi session to report a tree snapshot.',
    parameters: Type.Object({ target: Type.String() }),
    async execute(_id, params: { target: string }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_tree', peer: peerForContext(ctx), target: params.target });
      if (response.ok && 'command' in response) return result(`Queued tree ${response.command.id}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_navigate',
    label: 'Grapevine Navigate',
    description: 'Ask another local Pi session to navigate to a tree entry when supported by Pi.',
    parameters: Type.Object({ target: Type.String(), targetEntryId: Type.String() }),
    async execute(_id, params: { target: string; targetEntryId: string }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_navigate', peer: peerForContext(ctx), target: params.target, targetEntryId: params.targetEntryId });
      if (response.ok && 'command' in response) return result(`Queued navigate ${response.command.id}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_fork',
    label: 'Grapevine Fork',
    description: 'Ask another local Pi session to fork from a tree entry when supported by Pi.',
    parameters: Type.Object({ target: Type.String(), targetEntryId: Type.String() }),
    async execute(_id, params: { target: string; targetEntryId: string }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_fork', peer: peerForContext(ctx), target: params.target, targetEntryId: params.targetEntryId });
      if (response.ok && 'command' in response) return result(`Queued fork ${response.command.id}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_clone',
    label: 'Grapevine Clone',
    description: 'Ask another local Pi session to clone at a tree entry when supported by Pi.',
    parameters: Type.Object({ target: Type.String(), targetEntryId: Type.String() }),
    async execute(_id, params: { target: string; targetEntryId: string }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_clone', peer: peerForContext(ctx), target: params.target, targetEntryId: params.targetEntryId });
      if (response.ok && 'command' in response) return result(`Queued clone ${response.command.id}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_events',
    label: 'Grapevine Events',
    description: 'Read lifecycle, streaming, tool, and answer events from another local Pi session.',
    parameters: Type.Object({ target: Type.String(), after: Type.Optional(Type.Number()) }),
    async execute(_id, params: { target: string; after?: number }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_events', peer: peerForContext(ctx), target: params.target, after: params.after });
      if (response.ok && 'events' in response) return result(formatEvents(response.events), response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_send',
    label: 'Grapevine Send',
    description: 'Send a local message to a pi-grapevine peer by id or name.',
    parameters: Type.Object({ to: Type.String(), body: Type.String() }),
    async execute(_id, { to, body }: { to: string; body: string }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'send', peer: peerForContext(ctx), to, body });
      if (response.ok && 'message' in response) return result(`Delivered ${response.message.id} to ${response.message.to}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_reply',
    label: 'Grapevine Reply',
    description: 'Reply to the newest unread inbound message.',
    parameters: Type.Object({ body: Type.String() }),
    async execute(_id, { body }: { body: string }, _signal, _onUpdate, ctx) {
      const inboxResponse = await requestBroker({ type: 'inbox', peer: peerForContext(ctx) });
      if (!(inboxResponse.ok && 'inbox' in inboxResponse)) return result(errorText(inboxResponse), inboxResponse);
      const message = inboxResponse.inbox?.at(-1);
      if (!message) return result('No unread message to reply to.', inboxResponse);
      const sendResponse = await requestBroker({ type: 'send', peer: peerForContext(ctx), to: message.from, body, replyTo: message.id });
      if (sendResponse.ok && 'message' in sendResponse) return result(`Replied to ${message.from}.`, sendResponse);
      return result(errorText(sendResponse), sendResponse);
    },
  });
}

function activateSession(pi: ExtensionAPI, ctx: ExtensionContext) {
  if (process.env.PI_GRAPEVINE_DISABLE === '1') return;
  const peer = peerForContext(ctx);
  if (pollTimers.has(peer.id)) return;
  void safeGrapevine(ctx, () => requestBroker({ type: 'session_register', peer }));
  const timer = setInterval(() => void safeGrapevine(ctx, () => pollCommands(pi, ctx)), 2000);
  timer.unref?.();
  pollTimers.set(peer.id, timer);
  setGrapevineStatus(ctx, 'ok');
}

function deactivateSession(ctx: ExtensionContext) {
  const peer = peerForContext(ctx);
  clearInterval(pollTimers.get(peer.id));
  pollTimers.delete(peer.id);
  void safeGrapevine(ctx, () => requestBroker({ type: 'session_unregister', peer }));
  ctx.ui.setStatus('grapevine', undefined);
}

async function pollCommands(pi: ExtensionAPI, ctx: ExtensionContext) {
  const peer = peerForContext(ctx);
  const response = await requestBroker({ type: 'session_take_commands', peer });
  if (!(response.ok && 'commands' in response)) return;
  setGrapevineStatus(ctx, 'ok');
  for (const command of response.commands) await applyCommand(pi, ctx, command);
}

async function safeGrapevine(ctx: ExtensionContext, fn: () => Promise<unknown>) {
  try {
    return await fn();
  } catch (error) {
    setGrapevineStatus(ctx, 'error');
    return undefined;
  }
}

function setGrapevineStatus(ctx: ExtensionContext, state: 'ok' | 'error') {
  const label = state === 'ok' ? 'Grapevine' : 'Grapevine error';
  const color = state === 'ok' ? 'success' : 'warning';
  ctx.ui.setStatus('grapevine', ctx.ui.theme.fg(color, label));
}

async function applyCommand(pi: ExtensionAPI, ctx: ExtensionContext, command: ControlCommand) {
  const peerId = peerForContext(ctx).id;
  if (command.type === 'abort') {
    ctx.abort();
    await updateCommand(ctx, command.id, 'aborted');
    await postSessionEvent(ctx, 'remote_abort', { id: command.id });
    return;
  }
  if (command.type === 'compact') {
    await updateCommand(ctx, command.id, 'running');
    ctx.compact({
      onComplete: (compactResult) => {
        void updateCommand(ctx, command.id, 'done');
        void postSessionEvent(ctx, 'remote_compact_done', compactResult);
      },
      onError: (error) => {
        void updateCommand(ctx, command.id, 'failed', error.message);
        void postSessionEvent(ctx, 'remote_compact_failed', { message: error.message });
      },
    });
    await postSessionEvent(ctx, 'remote_compact', { id: command.id });
    return;
  }
  if (command.type === 'tree') {
    await updateCommand(ctx, command.id, 'done');
    await postSessionEvent(ctx, 'remote_tree', { id: command.id, snapshot: treeSnapshot(ctx) });
    return;
  }
  if (command.type === 'navigate') return runSessionMethod(ctx, command.id, 'navigateTree', [command.targetEntryId]);
  if (command.type === 'fork') return runSessionMethod(ctx, command.id, 'fork', [command.targetEntryId]);
  if (command.type === 'clone') return runSessionMethod(ctx, command.id, 'fork', [command.targetEntryId, { position: 'at' }]);
  activeCommands.set(peerId, command.id);
  await updateCommand(ctx, command.id, 'running');
  pi.sendUserMessage(command.text, command.deliverAs ? { deliverAs: command.deliverAs } : undefined);
  await postSessionEvent(ctx, 'remote_prompt', { id: command.id, deliverAs: command.deliverAs });
}

async function runSessionMethod(ctx: ExtensionContext, commandId: string, method: 'navigateTree' | 'fork', args: unknown[]) {
  const target = ctx as ExtensionContext & { navigateTree?: (...args: unknown[]) => Promise<unknown>; fork?: (...args: unknown[]) => Promise<unknown> };
  const fn = target[method];
  if (!fn) {
    await updateCommand(ctx, commandId, 'failed', `${method} is not available in this Pi context`);
    await postSessionEvent(ctx, `remote_${method}_failed`, { id: commandId, message: `${method} unavailable` });
    return;
  }
  await updateCommand(ctx, commandId, 'running');
  try {
    const output = await fn.apply(target, args);
    await updateCommand(ctx, commandId, 'done');
    await postSessionEvent(ctx, `remote_${method}_done`, { id: commandId, output, snapshot: treeSnapshot(ctx) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateCommand(ctx, commandId, 'failed', message);
    await postSessionEvent(ctx, `remote_${method}_failed`, { id: commandId, message });
  }
}

async function updateCommand(ctx: ExtensionContext, commandId: string, state: 'accepted' | 'running' | 'done' | 'failed' | 'aborted', error?: string) {
  if (process.env.PI_GRAPEVINE_DISABLE === '1') return;
  await requestBroker({ type: 'session_command_update', peer: peerForContext(ctx), commandId, state, error }).catch(() => undefined);
}

async function postSessionEvent(ctx: ExtensionContext, eventType: string, data: unknown) {
  if (process.env.PI_GRAPEVINE_DISABLE === '1') return;
  const peer = peerForContext(ctx);
  if (!peer.sessionId) return;
  await requestBroker({ type: 'session_event', peer, eventType, data }).catch(() => undefined);
}

async function delegate(ctx: ExtensionContext, target: string, task: string, timeoutMs: number, update: (line: string) => void): Promise<TaskDigest> {
  const peer = peerForContext(ctx);
  const before = await requestBroker({ type: 'session_events', peer, target });
  const after = before.ok && 'events' in before ? before.events.at(-1)?.id ?? 0 : 0;
  const queued = await requestBroker({ type: 'session_prompt', peer, target, text: task });
  if (!(queued.ok && 'command' in queued)) throw new Error(errorText(queued));
  const commandId = queued.command.id;
  const deadline = Date.now() + timeoutMs;
  let latest = after;
  let finalAnswer = '';
  const events: SessionEvent[] = [];
  const tools = new Set<string>();

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await requestBroker({ type: 'session_events', peer, target, after: latest });
    if (!(response.ok && 'events' in response)) continue;
    for (const event of response.events) {
      events.push(event);
      latest = Math.max(latest, event.id);
      const tool = toolName(event.data);
      if (tool) tools.add(tool);
      const answer = assistantText(event.data);
      if (answer) finalAnswer = answer;
      if (event.type === 'tool_execution_start') update(`${event.id} tool ${tool ?? 'unknown'}`);
      if (event.type === 'message_end' && answer) update(`${event.id} answer ${answer.slice(0, 200)}`);
      if (event.type === 'agent_end' && events.some((candidate) => candidate.type === 'remote_prompt' && JSON.stringify(candidate.data).includes(commandId))) {
        return { target, commandId, finalAnswer, tools: [...tools], events };
      }
    }
  }
  throw new Error(`Timed out waiting for ${target}`);
}

function treeSnapshot(ctx: ExtensionContext) {
  const manager = ctx.sessionManager as typeof ctx.sessionManager & { getLeafId?: () => string | null };
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: manager.getLeafId?.() ?? null,
    entries: ctx.sessionManager.getEntries(),
    generatedAt: new Date().toISOString(),
  };
}

function peerForContext(ctx: ExtensionContext): PeerInput {
  return currentPeer({
    name: process.env.PI_GRAPEVINE_NAME || ctx.sessionManager.getSessionName?.() || ctx.cwd.split('/').at(-1) || 'pi',
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile?.(),
  });
}

function result(text: string, details: unknown) {
  return { content: [{ type: 'text' as const, text }], details };
}

function errorText(response: unknown) {
  if (typeof response === 'object' && response && 'error' in response) return String(response.error);
  return 'Unexpected broker response.';
}

function formatStatus(peer: Peer, inbox: GrapevineMessage[]) {
  return ['pi-grapevine broker is running.', `You: ${peer.name} (${peer.id})`, `Session: ${peer.sessionId ?? 'none'}`, `Unread: ${inbox.length}`, ...inbox.map((message) => `- ${message.from}: ${message.body}`)].join('\n');
}

function formatPeers(peers: Peer[]) {
  if (peers.length === 0) return 'No peers.';
  return peers.map((peer) => `${peer.name} (${peer.id}) ${peer.cwd}`).join('\n');
}

function formatSessions(sessions: Peer[]) {
  if (sessions.length === 0) return 'No steerable sessions.';
  return sessions.map((peer) => `${peer.name} (${peer.id}) session=${peer.sessionId} cwd=${peer.cwd}`).join('\n');
}

function formatSessionStatuses(statuses: Array<{ peer: Peer; busy: boolean; currentTool?: string; lastAnswer?: string; pendingCommands: number; lastEventId: number }>) {
  if (statuses.length === 0) return 'No steerable sessions.';
  return statuses.map((status) => [
    `${status.peer.name} (${status.peer.id}) ${status.busy ? 'busy' : 'idle'}`,
    `  session=${status.peer.sessionId}`,
    `  cwd=${status.peer.cwd}`,
    `  pending=${status.pendingCommands} lastEvent=${status.lastEventId}`,
    status.currentTool ? `  tool=${status.currentTool}` : undefined,
    status.lastAnswer ? `  last=${status.lastAnswer.slice(0, 240)}` : undefined,
  ].filter(Boolean).join('\n')).join('\n');
}

function formatEvents(events: SessionEvent[]) {
  if (events.length === 0) return 'No events.';
  return events.map((event) => `${event.id} ${event.type}: ${summary(event.data)}`).join('\n');
}

function formatDigest(digest: TaskDigest) {
  return [`Command: ${digest.commandId}`, `Target: ${digest.target}`, `Tools: ${digest.tools.join(', ') || 'none'}`, '', digest.finalAnswer || '(no final answer)'].join('\n');
}

function summary(data: unknown): string {
  if (typeof data === 'object' && data && 'role' in data) return `${String((data as { role?: unknown }).role)} ${textContent(data).slice(0, 200)}`.trim();
  return JSON.stringify(data).slice(0, 300);
}

function assistantText(data: unknown): string | undefined {
  const record = typeof data === 'object' && data ? data as { role?: unknown; content?: unknown } : {};
  if (record.role !== 'assistant') return undefined;
  const text = textContent(record).trim();
  return text || undefined;
}

function textContent(data: unknown): string {
  const content = (data as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text?: unknown }).text) : '')).join('');
}

function toolName(data: unknown): string | undefined {
  return typeof data === 'object' && data && 'toolName' in data ? String((data as { toolName?: unknown }).toolName) : undefined;
}

