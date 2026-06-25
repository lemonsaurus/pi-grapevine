# pi-grapevine

Paranoid local messaging for Pi agents.

For now this is a hello-world Pi extension and a sketch for a local-only agent grapevine.


## Distribution

This repo is not meant to become a maintained npm package.

Steal it, fork it, vendor it, reshape it. The design is the product: a small local broker plus a Pi extension that agents can understand and repair. If Pi changes and this breaks, point Pi at the code and let it fix the local copy.

The era of self-improving software, babyyyy.

## Security posture

The safest network is no network. v1 uses OS-local IPC only.

See [`docs/threat-model.md`](docs/threat-model.md).


## Initial tool surface

- `grapevine_status`: show broker and current peer state.
- `grapevine_list`: list connected peers.
- `grapevine_send`: send a message to one peer.
- `grapevine_reply`: reply to the most recent inbound message.

See [`docs/protocol.md`](docs/protocol.md).


## Runtime files

- `~/.pi/grapevine/broker.sock`
- `~/.pi/grapevine/audit.jsonl`

Runtime directories should be `0700`. Files with message metadata should be `0600`.
