# Threat model

## Assets

- Source code and repo paths visible to Pi sessions.
- Tool arguments and results.
- User prompts and agent replies sent through the channel.
- Session identity metadata.

## Trust boundary

`pi-grapevine` trusts only the local OS user account. It does not trust networks, public relays, browser origins, or other local users.

## v1 controls

- Local IPC only.
- No TCP bind.
- No remote pairing.
- No transcript streaming.
- Bounded message size.
- Explicit peer list.
- Audit log for joins, leaves, sends, and failures.
- Broker exits after idle timeout.

## Out of scope for v1

- Cross-machine messaging.
- Phone control.
- Push notifications.
- Shell command execution.
- File browsing.
- Tool approval from another device.

## Future bridge requirements

Any future remote bridge needs a separate design review and must start read-only.
Minimum bar:

- Self-hosted only.
- Tailscale or WireGuard only.
- End-to-end encryption for message payloads.
- Explicit per-session enablement.
- Per-device revocation.
- Bounded transcript previews.
- Visible remote-attached indicator.
