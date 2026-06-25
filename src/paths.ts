import { homedir } from 'node:os';
import { join } from 'node:path';

export type GrapevinePaths = {
  dir: string;
  socket: string;
  auditLog: string;
  state: string;
};

export function grapevinePaths(home = homedir()): GrapevinePaths {
  const dir = join(home, '.pi', 'grapevine');
  return {
    dir,
    socket: join(dir, 'broker.sock'),
    auditLog: join(dir, 'audit.jsonl'),
    state: join(dir, 'state.json'),
  };
}
