import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentPeer, requestBroker } from './broker.js';
import type { ControlCommand, GrapevineMessage, Peer, PeerInput, SessionEvent } from './protocol.js';

const pollTimers = new Map<string, NodeJS.Timeout>();
const lastEventIds = new Map<string, number>();

export default function grapevine(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => activateSession(pi, ctx));
  pi.on('session_shutdown', (_event, ctx) => deactivateSession(ctx));
  pi.on('agent_start', (event, ctx) => postSessionEvent(ctx, 'agent_start', event));
  pi.on('agent_end', (event, ctx) => postSessionEvent(ctx, 'agent_end', event));
  pi.on('message_end', (event, ctx) => postSessionEvent(ctx, 'message_end', event.message));
  pi.on('tool_execution_start', (event, ctx) => postSessionEvent(ctx, 'tool_execution_start', event));
  pi.on('tool_execution_end', (event, ctx) => postSessionEvent(ctx, 'tool_execution_end', event));

  pi.registerTool({
    name: 'grapevine_status',
    label: 'Grapevine Status',
    description: 'Show local pi-grapevine status and unread messages.',
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'hello', peer: peerForContext(ctx) });
      if (response.ok && 'peer' in response) return result(formatStatus(response.peer, response.inbox ?? []), response);
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
    name: 'grapevine_prompt',
    label: 'Grapevine Prompt',
    description: 'Prompt or steer another local Pi session. Use deliverAs=steer for mid-work redirection and followUp to queue after completion.',
    parameters: Type.Object({
      target: Type.String(),
      text: Type.String(),
      deliverAs: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('followUp')])),
    }),
    async execute(_id, params: { target: string; text: string; deliverAs?: 'steer' | 'followUp' }, _signal, _onUpdate, ctx) {
      const response = await requestBroker({ type: 'session_prompt', peer: peerForContext(ctx), target: params.target, text: params.text, deliverAs: params.deliverAs });
      if (response.ok && 'command' in response) return result(`Queued ${response.command.type} ${response.command.id}.`, response);
      return result(errorText(response), response);
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
    name: 'grapevine_events',
    label: 'Grapevine Events',
    description: 'Read lifecycle, tool, and answer events from another local Pi session.',
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
  const peer = peerForContext(ctx);
  if (pollTimers.has(peer.id)) return;
  void requestBroker({ type: 'session_register', peer });
  const timer = setInterval(() => void pollCommands(pi, ctx), 500);
  timer.unref?.();
  pollTimers.set(peer.id, timer);
  ctx.ui.setStatus('grapevine', ctx.ui.theme.fg('success', 'Grapevine'));
}

function deactivateSession(ctx: ExtensionContext) {
  const peer = peerForContext(ctx);
  clearInterval(pollTimers.get(peer.id));
  pollTimers.delete(peer.id);
  ctx.ui.setStatus('grapevine', undefined);
}

async function pollCommands(pi: ExtensionAPI, ctx: ExtensionContext) {
  const peer = peerForContext(ctx);
  const response = await requestBroker({ type: 'session_take_commands', peer });
  if (!(response.ok && 'commands' in response)) return;
  for (const command of response.commands) await applyCommand(pi, ctx, command);
}

async function applyCommand(pi: ExtensionAPI, ctx: ExtensionContext, command: ControlCommand) {
  if (command.type === 'abort') {
    ctx.abort();
    await postSessionEvent(ctx, 'remote_abort', { id: command.id });
    return;
  }
  pi.sendUserMessage(command.text, command.deliverAs ? { deliverAs: command.deliverAs } : undefined);
  await postSessionEvent(ctx, 'remote_prompt', { id: command.id, deliverAs: command.deliverAs });
}

async function postSessionEvent(ctx: ExtensionContext, eventType: string, data: unknown) {
  const peer = peerForContext(ctx);
  if (!peer.sessionId) return;
  await requestBroker({ type: 'session_event', peer, eventType, data }).catch(() => undefined);
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

function formatEvents(events: SessionEvent[]) {
  if (events.length === 0) return 'No events.';
  for (const event of events) lastEventIds.set(event.sessionId, event.id);
  return events.map((event) => `${event.id} ${event.type}: ${summary(event.data)}`).join('\n');
}

function summary(data: unknown): string {
  if (typeof data === 'object' && data && 'role' in data) return `${String((data as { role?: unknown }).role)} ${textContent(data).slice(0, 200)}`.trim();
  return JSON.stringify(data).slice(0, 300);
}

function textContent(data: unknown): string {
  const content = (data as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (typeof part === 'object' && part && 'text' in part ? String((part as { text?: unknown }).text) : '')).join('');
}
