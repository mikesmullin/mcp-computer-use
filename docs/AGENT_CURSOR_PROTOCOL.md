# Optional shared agent cursor, protocol v1

`agent-cursor.service` owns one Rust drawing process. Clients speak newline-delimited
JSON over a local Unix stream socket. This is independent of MCP and is not exposed
as an agent tool. mcp-zen implements the protocol without importing computer-use
code, launching it, or requiring its checkout. The computer-use MCP is also a client.

Default endpoint: `$XDG_RUNTIME_DIR/agent-cursor.sock` (normally
`/run/user/1000/agent-cursor.sock`). `AGENT_CURSOR_SOCKET` overrides it for either
producer and the listener. The socket is mode 0600. The service never accepts input
injection commands, evaluates code, or moves the human pointer.

## Lifecycle

Build the existing Rust helper, then install the example user service (adjust paths
and DISPLAY/XAUTHORITY for another machine):

```sh
cargo build --release --manifest-path overlay/Cargo.toml
mkdir -p ~/.config/systemd/user
cp systemd/agent-cursor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-cursor.service
```

Or run `node scripts/agent-cursor.mjs` in the desktop environment. The listener starts
the drawing process lazily on the first move. Restarting an MCP client does not own,
stop, or reposition the shared renderer. To disable all shared animation, stop the
service. `CUA_CURSOR=off` disables only a computer-use client's notifications;
`AGENT_CURSOR=off` disables only mcp-zen's notifications. Neither changes input.
Set renderer color/idle/fade overrides on the service, then restart that service.

Older, already-running computer-use processes still own their old private overlays.
Reconnect those MCP sessions after upgrading. The native lifecycle smoke test uses
an explicitly private renderer to test crash recovery without killing the shared one.

## Request and reply

One request per connection; one response, then EOF. Example:

```json
{"version":1,"requestId":"unique-id","event":"before_click","position":{"space":"screen-device-pixels","x":2430,"y":1580},"expiresAt":1792963001000}
```

`expiresAt` is an absolute Unix timestamp in milliseconds, at most 10 seconds in the
future. Both clients use an 1800 ms deadline. Coordinates are **desktop device
pixels**, not CSS pixels, and remain internal to services. Values must fit signed
16-bit integers (the existing X11 helper's range).

Events:

- `before_click`, `before_select`, `before_hover`, `before_scroll`, `move`: animate
  to `position`, wait for arrival, acknowledge. Only wired producers send events;
  mcp-zen currently covers click/click_at/tap/check/uncheck, find mutations, fill/type,
  select/set_range, hover/reveal, Enter/Space activation and native fullscreen clicks.
- `before_type`: animate, then set the arrow amber.
- `typing_start`, `typing_end`: change the shared arrow's typing highlight. Amber
  has a five-second safety timeout if a producer disappears.
- `show`: place the overlay directly; `refresh`: repaint its current position.
- `status`: read current position, last accepted drawing event and overlay PID.

```json
{"version":1,"requestId":"unique-id","ok":true,"status":"done","position":{"x":2430,"y":1580},"lastEvent":{"event":"before_click","requestId":"unique-id","at":1792963000500},"overlayPid":12345}
```

`ok` means drawing completed, **not that an application action succeeded**.
Unavailable/expired/invalid/busy requests return `ok:false`. Notifications never
perform the click. There is no public click/execute/eval command on this socket.

The listener serializes drawing, bounds its queue to eight requests, drops expired
or disconnected queued events, and keeps 256 request IDs for duplicate suppression.
Moves with less than 900 ms remaining are dropped before they start. Requests are
limited to 4096 characters. It refuses to replace a live socket or an unowned path.
A movement already started can finish even if its sender disconnects; no input is
associated with that movement. Clients never retry a browser action because drawing
failed. This service is visual feedback, not a cross-application action lock.

## Zen interaction sequence

1. If the socket is absent, execute the existing DOM operation normally.
2. If present, use the extension's internal `interaction_prepare` to resolve the
   target (including find locators), scroll if necessary, and obtain screen-device
   coordinates plus a short-lived, single-use preparation token.
3. Notify and wait for acknowledgement, up to 1800 ms. Missing/crashed listeners
   fail open; an old extension without preparation support also works without animation.
4. Check the active tab, target identity, fingerprint, hit testing and current
   position again. A moved/replaced target does not receive an old-position click.
5. Perform the original DOM operation exactly once. End amber after typing, even
   if the browser action fails. Operator tab switches retain the existing steering
   warning/fresh-context behavior.

The ordinary DOM interaction remains synthetic; adding the overlay does not make
it native input. mcp-computer-use retains its native independent-pointer delivery.
The model still supplies labels/refs, never the socket coordinates.
