# Independent agent cursor (X11)

A Rust helper draws a blue arrow with a dark outline, and delivers input through
an independent XInput2 master pointer. The human pointer is never warped or
saved/restored. The MCP remains CoffeeScript/Bun.

## Build and run

```sh
cd /workspace/mcp-computer-use
cargo build --release --manifest-path overlay/Cargo.toml
bun server.coffee
```

Needs an authorized X11 session (`DISPLAY`, `XAUTHORITY`), XInput2, XTEST,
SHAPE, `xdotool`, `scrot`, Python 3 with Pillow, and AwesomeWM. Rust dependencies are isolated in
`overlay/Cargo.toml`; the MCP has no new JS dependencies.

For a Codex stdio connection, launch `bun` with argument
`/workspace/mcp-computer-use/server.coffee`, working directory
`/workspace/mcp-computer-use`. Inherit the desktop's DISPLAY/XAUTHORITY and
D-Bus session environment. The harness must permit the MCP process to reach the
X server and AwesomeWM. No Codex configuration has been installed by this change.

## Behavior

- Drawing is provided by the optional shared `agent-cursor.service`; its renderer
  starts on the first move. See [socket setup/protocol](../docs/AGENT_CURSOR_PROTOCOL.md).
- Stays visible between moves until idle expiry or service shutdown; MCP disconnects
  do not stop the shared arrow. Curved, varied travel with
  smooth acceleration/deceleration ends exactly at the action's coordinate.
- Click waits for the overlay's arrival; overlay startup allows the compositor
  time to display its first frame. Typing preserves the last pointer target and
  turns the arrow amber while input is being sent.
- The visible window is shaped to the arrow/outline; its **input shape is empty**.
  Override-redirect prevents AwesomeWM from managing or focusing it. No rectangular
  background. Frame/shadow hints suppress Picom's rectangular shadow without
  changing the user's compositor configuration.
- Screenshots crop the root framebuffer, including the real overlay. Coordinates
  are handled internally. Agents choose observation-scoped targets, never pixels.
  Native helper coordinates remain client-relative.
- Screenshot refreshes the last agent position. If that position is outside the
  captured window, the arrow is naturally outside the image too.
- XTEST input uses a short-lived private master pointer/keyboard pair and the
  helper connection's client pointer. Zen accepts these as trusted input.
  Plain XSendEvent clicks were experimentally ignored by Zen and are not used.
- The click helper checks which window is actually under its private pointer
  before pressing; an obscured target fails rather than clicking another app.
- No fallback ever moves the human pointer. Missing input helper is a tool error;
  missing/crashed drawing service is optional and input continues.
- Overlay exits on EOF, quit, SIGINT or SIGTERM. A separate watcher removes the
  click's master pair even after SIGKILL. A subsequent click also reaps stale
  pairs whose owner process no longer exists. User input devices are never
  attached to these pairs.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CUA_CURSOR` | `on` | `off` disables drawing, retaining independent input |
| `AGENT_CURSOR_SOCKET` | `$XDG_RUNTIME_DIR/agent-cursor.sock` | Shared notification endpoint |
| `CUA_CURSOR_COLOR` | `4F86F7` | Six-digit RGB, optional leading `#` |
| `CUA_CURSOR_IDLE_MS` | `180000` | Hide after three minutes without movement; zero stays visible |
| `CUA_CURSOR_FADE_MS` | `2500` | Optional coverage fade during the final portion of idle time |
| `CUA_CURSOR_BINARY` | `overlay/target/release/cua-overlay` | Helper executable override |

Set renderer color/idle/fade/binary variables on the shared service.
Idle/fade environment values accept 0–3600000 ms. Coverage fade is compatible with bare X11.
Screenshot refreshes and typing alone do not reset the timer or reveal a hidden
cursor. An explicit action move reveals it again, including at the same position.
The renderer requires no compositor or background sampling. Persistent idle draws
no new frames unless exposed, but periodically reasserts stacking order.

## Native protocol

`cua-overlay serve` reads one command per line. Stdout starts with `ready WINDOW`;
commands reply `ok` or `error ...`. Diagnostics go to stderr. Wait for each reply
before the next command. `move` replies after the final frame reaches X11.

```text
show GLOBAL_X GLOBAL_Y
move GLOBAL_X GLOBAL_Y
fade MILLISECONDS
typing 0|1
quit
```

`cua-overlay click WINDOW CLIENT_X CLIENT_Y BUTTON [COUNT]` injects buttons 1–3 using the
private pointer and reports injection coordinates. `wheel` uses the same private
pointer for buttons 4–7; repeated events share one input transaction. It does not activate the window;
the MCP activates it first. `geometry WINDOW` reports the exact client origin/size;
`capture-geometry WINDOW` additionally requires a fully visible framebuffer rectangle.
`devices` lists XInput devices for diagnostics. `watch PID` is internal cleanup IPC.

## Tests and evidence

```sh
bun test test/*.test.mjs
cargo test --manifest-path overlay/Cargo.toml
cargo clippy --manifest-path overlay/Cargo.toml -- -D warnings
# Authorized desktop only:
CUA_OVERLAY_X=1 cargo test --manifest-path overlay/Cargo.toml --test x11 -- --ignored --test-threads=1
```

Open `file:///workspace/mcp-computer-use/test/cursor-page.html` in Zen. These
opt-in scripts require that page active and take the Zen X11 window ID:

```sh
CUA_OVERLAY_X=1 bun test/desktop-smoke.mjs WINDOW_ID
CUA_OVERLAY_X=1 bun test/lifecycle-smoke.mjs WINDOW_ID
CUA_OVERLAY_X=1 bun test/motion-demo.mjs WINDOW_ID
```

For the target-based MCP smoke test, serve `test/` over localhost, open
`target-page.html` in Zen, and keep the mouse idle during the test:

```sh
python3 -m http.server 18991 --bind 127.0.0.1 --directory test
# Open http://127.0.0.1:18991/target-page.html, then in another terminal:
CUA_OVERLAY_X=1 node test/mcp-smoke.mjs WINDOW_ID
```

This checks DOM typing, hidden/ambiguous/stale references, automatic offscreen
reveal and click, crop, double-click, native scroll, full-page capture, H2O scoring,
and human pointer preservation. It needs the OCR, H2O and mcp-zen services running.

The older native scripts' page-specific click coordinates assume the tested Zen layout (sidebar open,
normal zoom). Inspect the page before running on a different layout. The MCP smoke
clears only the page's test input. The lifecycle smoke intentionally kills a test
helper. Screenshots go to `/tmp/agent-*.png`. `transparency-smoke.mjs` compares a
fixed, quiet crop on the tested desktop; inspect coordinates before reuse.

Native implementation verified on the user's desktop, 2026-10-24
(before the screenshotId API revision; unit tests cover the revised mapping/ordering):

- Zen button count increments and complete typed text is confirmed through page title.
- Human pointer coordinates unchanged across click/type; overlay alone preserves focus.
- Real arrow included in MCP screenshot; hotspot matches client click coordinates.
- Overlay visible on three monitors, absent from AwesomeWM client list.
- Empty input shape, exact silhouette, persistent visibility, opt-in fade, EOF cleanup.
- Overlay SIGKILL/respawn, click helper SIGKILL/device cleanup, missing-overlay fail-open.
- Transparent surround: screenshot changes were exactly blue and outline pixels,
  with no rectangular shadow after compositor hints.

The original plan assumed no compositor; this desktop actually runs Picom. It also
specified imaginary save-under APIs and a glyph input shape; neither is needed.
This implementation uses a small native shaped window and an empty input shape.
Motion is an independent CUA-inspired cubic implementation, not a CUA dependency.

## Limits

Zen is the verified application. Other apps may differ in how they handle extra
XInput master devices, grabs and popups. This version provides clicks and typing,
not drag/scroll. It is X11-only. Input injection success does not itself prove an
application handled the action; inspect subsequent screenshots or app state.
Screenshots show visible desktop pixels, including other windows covering the
requested rectangle; partially offscreen windows are rejected. Compositor frame
scheduling and app rendering are asynchronous, so screenshots are observations,
not acknowledgements that a web page finished processing an action.
