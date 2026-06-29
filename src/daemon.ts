import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pid } from 'node:process';
import { startBroker } from './broker.js';

const dir = process.argv[2];
if (!dir) throw new Error('Missing grapevine runtime dir');

await mkdir(dir, { recursive: true, mode: 0o700 });
const pidFile = join(dir, 'daemon.pid');
if (!(await claimPidFile(pidFile))) process.exit(0);

await startBroker({ dir, socket: join(dir, 'broker.sock'), auditLog: join(dir, 'audit.jsonl'), state: join(dir, 'state.json') }, { unref: false });

async function claimPidFile(path: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(pid));
      await file.close();
      return true;
    } catch {
      await stopStaleDaemon(path);
    }
  }
  return false;
}

async function stopStaleDaemon(path: string) {
  const oldPid = Number(await readFile(path, 'utf8').catch(() => '0'));
  if (oldPid && oldPid !== pid && await isGrapevineDaemon(oldPid)) {
    try {
      process.kill(oldPid, 'SIGTERM');
    } catch {}
  }
  await rm(path, { force: true });
}

async function isGrapevineDaemon(targetPid: number) {
  const cmdline = await readFile(`/proc/${targetPid}/cmdline`, 'utf8').catch(() => '');
  return cmdline.includes('grapevine') && cmdline.includes('daemon.');
}
