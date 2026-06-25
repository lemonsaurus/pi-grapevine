import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { currentPeer, requestBroker } from './broker.js';
import type { GrapevineMessage, Peer } from './protocol.js';

export default function grapevine(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'grapevine_status',
    label: 'Grapevine Status',
    description: 'Show local pi-grapevine status and unread messages.',
    parameters: Type.Object({}),
    async execute() {
      const response = await requestBroker({ type: 'hello', peer: currentPeer() });
      if (response.ok && 'peer' in response) {
        return result(formatStatus(response.peer, response.inbox ?? []), response);
      }
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_list',
    label: 'Grapevine Peers',
    description: 'List local pi-grapevine peers.',
    parameters: Type.Object({}),
    async execute() {
      const response = await requestBroker({ type: 'list', peer: currentPeer() });
      if (response.ok && 'peers' in response) return result(formatPeers(response.peers), response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_send',
    label: 'Grapevine Send',
    description: 'Send a local message to a pi-grapevine peer by id or name.',
    parameters: Type.Object({
      to: Type.String(),
      body: Type.String(),
    }),
    async execute(_toolCallId: string, { to, body }: { to: string; body: string }) {
      const response = await requestBroker({ type: 'send', peer: currentPeer(), to, body });
      if (response.ok && 'message' in response) return result(`Delivered ${response.message.id} to ${response.message.to}.`, response);
      return result(errorText(response), response);
    },
  });

  pi.registerTool({
    name: 'grapevine_reply',
    label: 'Grapevine Reply',
    description: 'Reply to the newest unread inbound message.',
    parameters: Type.Object({ body: Type.String() }),
    async execute(_toolCallId: string, { body }: { body: string }) {
      const inboxResponse = await requestBroker({ type: 'inbox', peer: currentPeer() });
      if (!(inboxResponse.ok && 'inbox' in inboxResponse)) return result(errorText(inboxResponse), inboxResponse);
      const message = inboxResponse.inbox?.at(-1);
      if (!message) return result('No unread message to reply to.', inboxResponse);
      const sendResponse = await requestBroker({ type: 'send', peer: currentPeer(), to: message.from, body, replyTo: message.id });
      if (sendResponse.ok && 'message' in sendResponse) return result(`Replied to ${message.from}.`, sendResponse);
      return result(errorText(sendResponse), sendResponse);
    },
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
  return [
    'pi-grapevine broker is running.',
    `You: ${peer.name} (${peer.id})`,
    `Unread: ${inbox.length}`,
    ...inbox.map((message) => `- ${message.from}: ${message.body}`),
  ].join('\n');
}

function formatPeers(peers: Peer[]) {
  if (peers.length === 0) return 'No peers.';
  return peers.map((peer) => `${peer.name} (${peer.id}) ${peer.cwd}`).join('\n');
}
