export const maxBodyBytes = 16 * 1024;
export const peerTtlMs = 10 * 60 * 1000;

export type CommandState = 'queued' | 'accepted' | 'running' | 'done' | 'failed' | 'aborted';

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
  | { id: string; type: 'abort'; createdAt: number }
  | { id: string; type: 'compact'; createdAt: number }
  | { id: string; type: 'tree'; createdAt: number }
  | { id: string; type: 'navigate'; targetEntryId: string; createdAt: number }
  | { id: string; type: 'fork'; targetEntryId: string; createdAt: number }
  | { id: string; type: 'clone'; targetEntryId: string; createdAt: number };

export type CommandRecord = {
  id: string;
  sessionId: string;
  type: ControlCommand['type'];
  state: CommandState;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

export type SessionEvent = {
  id: number;
  sessionId: string;
  type: string;
  at: number;
  data: unknown;
};

export type SessionStatus = {
  peer: Peer;
  busy: boolean;
  currentTool?: string;
  lastAnswer?: string;
  lastEventId: number;
  pendingCommands: number;
  commands: CommandRecord[];
};

export type DaemonStatus = {
  pid: number;
  socket: string;
  auditLog: string;
  stateFile: string;
  stateBytes: number;
  auditBytes: number;
  auditRotations: number;
  peerCount: number;
  sessionCount: number;
  eventCount: number;
  commandCount: number;
  prunedPeerCount: number;
  failedRequestCount: number;
};

export type TaskDigest = {
  target: string;
  commandId: string;
  finalAnswer: string;
  tools: string[];
  events: SessionEvent[];
};

export type GrapevineRequest =
  | { type: 'ping' }
  | { type: 'daemon_status'; peer: PeerInput }
  | { type: 'hello'; peer: PeerInput }
  | { type: 'list'; peer: PeerInput }
  | { type: 'send'; peer: PeerInput; to: string; body: string; replyTo?: string }
  | { type: 'inbox'; peer: PeerInput }
  | { type: 'session_register'; peer: PeerInput }
  | { type: 'session_unregister'; peer: PeerInput }
  | { type: 'session_list'; peer: PeerInput }
  | { type: 'session_status'; peer: PeerInput; target?: string }
  | { type: 'session_prompt'; peer: PeerInput; target: string; text: string; deliverAs?: 'steer' | 'followUp' }
  | { type: 'session_abort'; peer: PeerInput; target: string }
  | { type: 'session_compact'; peer: PeerInput; target: string }
  | { type: 'session_tree'; peer: PeerInput; target: string }
  | { type: 'session_navigate'; peer: PeerInput; target: string; targetEntryId: string }
  | { type: 'session_fork'; peer: PeerInput; target: string; targetEntryId: string }
  | { type: 'session_clone'; peer: PeerInput; target: string; targetEntryId: string }
  | { type: 'session_take_commands'; peer: PeerInput }
  | { type: 'session_command_update'; peer: PeerInput; commandId: string; state: CommandState; error?: string }
  | { type: 'session_event'; peer: PeerInput; eventType: string; data: unknown }
  | { type: 'session_events'; peer: PeerInput; target: string; after?: number };

export type GrapevineResponse =
  | { ok: true; status: 'pong' }
  | { ok: true; daemon: DaemonStatus }
  | { ok: true; peer: Peer; inbox?: GrapevineMessage[] }
  | { ok: true; peers: Peer[] }
  | { ok: true; sessions: Peer[] }
  | { ok: true; statuses: SessionStatus[] }
  | { ok: true; commands: ControlCommand[] }
  | { ok: true; events: SessionEvent[] }
  | { ok: true; status: 'queued'; command: ControlCommand; record: CommandRecord }
  | { ok: true; status: 'updated'; record: CommandRecord }
  | { ok: true; status: 'delivered'; message: Omit<GrapevineMessage, 'body'> }
  | { ok: true; status: 'recorded'; event: SessionEvent }
  | { ok: true; status: 'unregistered' }
  | { ok: false; status: 'not_found' | 'ambiguous' | 'too_large'; error: string };
