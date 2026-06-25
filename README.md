# pi-grapevine

Paranoid local messaging for Pi agents.

For now this is a local-only Pi session control plane over a Unix socket.


## Distribution

This repo is not meant to become a maintained npm package.

Steal it, fork it, vendor it, reshape it. The design is the product: a small local broker plus a Pi extension that agents can understand and repair. If Pi changes and this breaks, point Pi at the code and let it fix the local copy.

The era of self-improving software, babyyyy.

## Security posture

The safest network is no network. v1 uses a Unix domain socket on Linux and macOS.

See [`docs/threat-model.md`](docs/threat-model.md).


## Tool surface

- `grapevine_status`: start the broker, register this session, show unread messages.
- `grapevine_list`: list peers seen in the last 10 minutes.
- `grapevine_sessions`: list steerable Pi sessions.
- `grapevine_prompt`: prompt, steer, or queue follow-up work in another session.
- `grapevine_abort`: abort another session.
- `grapevine_events`: read lifecycle, tool, and answer events from another session.
- `grapevine_send`: send a message to one peer by name or id.
- `grapevine_reply`: reply to the newest unread inbound message.

Set `PI_GRAPEVINE_NAME` before starting Pi to give a session a stable human name. Send `/skill:name` through `grapevine_prompt` to run a skill in the target session.

See [`docs/protocol.md`](docs/protocol.md).


## Runtime files

- `~/.pi/grapevine/broker.sock`
- `~/.pi/grapevine/audit.jsonl`

The broker runs as a detached local daemon started on demand by the extension.

Runtime directories should be `0700`. Files with message metadata should be `0600`.


## Non-goals

- Network remote control.
- Mobile access.
- Public relay support.
- Cross-machine routing.
- Generic session transcript export.
- Autonomous swarm orchestration.
- Windows native support.

Blocking request/response can come later if the basic channel proves useful.
