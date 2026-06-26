# pi-grapevine

Use Grapevine for Pi-to-Pi worker orchestration when available: spawn, delegate, steer, abort, compact, tree, status, and event streaming. Use raw panes only when Grapevine is unavailable or direct TUI control is the task.

Clean up temporary panes and daemon processes after smoke tests.

Verify with:

```bash
pnpm typecheck
PI_GRAPEVINE_IN_PROCESS=1 pnpm test
```
