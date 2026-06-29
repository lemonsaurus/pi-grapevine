export type WorkerSpawnParams = {
  name: string;
  cwd: string;
  extensionPath: string;
  window?: string;
  group?: string;
};

export function workerSpawnExec(params: WorkerSpawnParams) {
  const command = `PI_GRAPEVINE_NAME=${shellQuote(params.name)} PI_SKIP_VERSION_CHECK=1 pi -e ${shellQuote(params.extensionPath)} --no-session`;
  const windowName = params.window ?? params.group;
  if (windowName) {
    return { bin: 'agency', args: ['spawn', '--window', windowName, '--cmd', command, params.cwd], location: `${params.cwd} in ${windowName}` };
  }
  return { bin: 'tmux', args: ['new-window', '-d', '-c', params.cwd, '-n', `gv-${params.name}`, command], location: params.cwd };
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
