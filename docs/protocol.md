# Protocol sketch

`pi-grapevine` uses a tiny request and event protocol over a local Unix socket.

## Peer hello

```json
{
  "type": "hello",
  "id": "req_...",
  "payload": {
    "name": "reviewer",
    "cwd": "/home/lemon/git/project",
    "pid": 12345
  }
}
```

## List peers

```json
{ "type": "list", "id": "req_..." }
```

## Send message

```json
{
  "type": "send",
  "id": "req_...",
  "payload": {
    "to": "peer-id-or-name",
    "body": "Can you check this?",
    "replyTo": null
  }
}
```

## Delivery statuses

- `delivered`
- `not_found`
- `ambiguous`
- `too_large`
- `offline`

Message bodies are delivered to the target session only. Audit logs record metadata, not bodies.
