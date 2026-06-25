export const maxBodyBytes = 16 * 1024;
export const peerTtlMs = 10 * 60 * 1000;

export type Peer = {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  sessionId?: string;
  sessionFile?: string;
  lastSeen: number;
};

export type PeerInput = Omit<Peer, 'lastSeen'>;

export type GrapevineMessage = {
  id: string;
  from: string;
  to: string;
  body: string;
  replyTo?: string;
  createdAt: number;
};

export type ControlCommand =
  | { id: string; type: 'prompt'; text: string; deliverAs?: 'steer' | 'followUp'; createdAt: number }
  | { id: string; type: 'abort'; createdAt: number };

export type SessionEvent = {
  id: number;
  sessionId: string;
  type: string;
  at: number;
  data: unknown;
};

export type GrapevineRequest =
  | { type: 'ping' }
  | { type: 'hello'; peer: PeerInput }
  | { type: 'list'; peer: PeerInput }
  | { type: 'send'; peer: PeerInput; to: string; body: string; replyTo?: string }
  | { type: 'inbox'; peer: PeerInput }
  | { type: 'session_register'; peer: PeerInput }
  | { type: 'session_list'; peer: PeerInput }
  | { type: 'session_prompt'; peer: PeerInput; target: string; text: string; deliverAs?: 'steer' | 'followUp' }
  | { type: 'session_abort'; peer: PeerInput; target: string }
  | { type: 'session_take_commands'; peer: PeerInput }
  | { type: 'session_event'; peer: PeerInput; eventType: string; data: unknown }
  | { type: 'session_events'; peer: PeerInput; target: string; after?: number };

export type GrapevineResponse =
  | { ok: true; status: 'pong' }
  | { ok: true; peer: Peer; inbox?: GrapevineMessage[] }
  | { ok: true; peers: Peer[] }
  | { ok: true; sessions: Peer[] }
  | { ok: true; commands: ControlCommand[] }
  | { ok: true; events: SessionEvent[] }
  | { ok: true; status: 'queued'; command: ControlCommand }
  | { ok: true; status: 'delivered'; message: Omit<GrapevineMessage, 'body'> }
  | { ok: true; status: 'recorded'; event: SessionEvent }
  | { ok: false; status: 'not_found' | 'ambiguous' | 'too_large'; error: string };
