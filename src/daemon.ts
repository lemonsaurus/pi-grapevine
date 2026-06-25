import { join } from 'node:path';
import { startBroker } from './broker.js';

const dir = process.argv[2];
if (!dir) throw new Error('Missing grapevine runtime dir');

await startBroker({ dir, socket: join(dir, 'broker.sock'), auditLog: join(dir, 'audit.jsonl') }, { unref: false });
