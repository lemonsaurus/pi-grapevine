export const maxBodyBytes = 16 * 1024;
export const peerTtlMs = 10 * 60 * 1000;

export type Peer = {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  lastSeen: number;
};

export type GrapevineMessage = {
  id: string;
  from: string;
  to: string;
  body: string;
  replyTo?: string;
  createdAt: number;
};

export type PingRequest = {
  type: 'ping';
};

export type HelloRequest = {
  type: 'hello';
  peer: Omit<Peer, 'lastSeen'>;
};

export type ListRequest = {
  type: 'list';
  peer: Omit<Peer, 'lastSeen'>;
};

export type SendRequest = {
  type: 'send';
  peer: Omit<Peer, 'lastSeen'>;
  to: string;
  body: string;
  replyTo?: string;
};

export type InboxRequest = {
  type: 'inbox';
  peer: Omit<Peer, 'lastSeen'>;
};

export type GrapevineRequest = PingRequest | HelloRequest | ListRequest | SendRequest | InboxRequest;

export type GrapevineResponse =
  | { ok: true; status: 'pong' }
  | { ok: true; peer: Peer; inbox?: GrapevineMessage[] }
  | { ok: true; peers: Peer[] }
  | { ok: true; status: 'delivered'; message: Omit<GrapevineMessage, 'body'> }
  | { ok: false; status: 'not_found' | 'ambiguous' | 'too_large'; error: string };
