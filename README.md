# mcp-computer-use

CoffeeScript/Bun MCP server for the user's AwesomeWM/X11 desktop. A Rust helper
provides an independent agent pointer and a persistent, transparent cursor overlay.
The human mouse pointer stays put. Zen is the tested browser.

## Run

Requires Bun, Rust, Python 3 with Pillow, `awesome-client`, `xdotool`, `scrot`, and
an authorized X11 desktop session with XInput2, XTEST and SHAPE.

```sh
cd /workspace/mcp-computer-use
bun install
cargo build --release --manifest-path overlay/Cargo.toml
bun server.coffee
```

Configure the MCP as stdio, launching `bun server.coffee` with this repository as
its working directory. Inherit `DISPLAY`, `XAUTHORITY`, and the desktop D-Bus session.
See [overlay/README.md](overlay/README.md) for native setup and configuration.

## Tools

| Tool | Purpose |
|---|---|
| `window_list` | Find windows by class/title; returns window IDs and frame geometry |
| `window_info` | Inspect a window's title, frame geometry, screen and focus |
| `window_screenshot` | Observe a window; optionally crop a prior image or add a coordinate grid |
| `window_click` | Click at image x,y using its screenshotId; returns a new screenshot |
| `window_type` | Send text to the focused control; returns a new screenshot |
| `window_key` | Send one shortcut such as Ctrl+t, Ctrl+l, Enter, or Escape |
| `window_interact` | Ordered optional click → replace/type → shortcut → observation |
| `cursor_position` | Read the human pointer, not the agent cursor |
| `window_fullscreen` | Set/toggle fullscreen when explicitly requested |

`window_move` and `window_resize` are commented out and unavailable to agents.
Unknown arguments are rejected. Requests execute in received order, including
window selection and observation, so concurrent requests cannot overtake each other.

## Screenshot coordinates (API 0.2)

Capture first. Pass the returned `screenshotId` and coordinates in the **returned
image** to actions. Do not add desktop offsets, subtract browser chrome, or use
window-manager geometry. The server maps image coordinates through any crop/scale.
This replaces the old direct client-coordinate action API.

The default image width is at most 1280 pixels (`maxWidth`: 320–2000). To examine
a region, call `window_screenshot` with a screenshotId and
`crop: {x, y, width, height}` in that image's pixels; optionally use `grid: true`.
The cropped image has a new screenshotId and local coordinates starting at (0,0).

Actions invalidate older screenshots for that window. IDs expire after 120 seconds;
changed window geometry/title is rejected. These checks do not detect every page
content change. Use the latest image and inspect the expected result.

Every successful action reports `input_sent`, not verified application success,
and returns a fresh image. If observation fails after input was sent, the error
states that input already occurred so an agent does not blindly replay it.
`window_interact` accepts optional `x`, `y`, `text`, `replace`, and `keys` along with
`screenshotId`. Its steps run in that order. `replace` means Ctrl+a before typing
and should only be used after targeting a text field.

The blue cursor follows curved paths and remains at its last target during typing,
turning amber while typing. Screenshots include the actual overlay; its metadata
coordinates are image-relative. The cursor is not the text caret.

## Skill

[SKILL.md](SKILL.md) provides the agent workflow and recovery rules. Register it
with the user's skills CLI configuration:

```yaml
skills:
  computer-use: /workspace/mcp-computer-use/SKILL.md
```

Then `skills computer-use` prints it. Reload MCP tools after updating the server.
No accessibility tree, OCR, or separate visual target detector is implemented yet.

## Checks

```sh
bun test test/*.test.mjs
cargo test --manifest-path overlay/Cargo.toml
cargo clippy --manifest-path overlay/Cargo.toml -- -D warnings
```

Opt-in desktop tests are documented in [overlay/README.md](overlay/README.md).
[PLAN-agent-cursor-overlay.md](PLAN-agent-cursor-overlay.md) is the historical
planning draft; the READMEs describe the implemented behavior.
