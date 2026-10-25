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
| `window_screenshot` | Return an image, or OCR text with transcribe=true; supports crops and grid spacing |
| `window_click` | Click an OCR region ID or image x,y using its screenshotId |
| `window_type` | Send text to the focused control; returns a fresh observation |
| `window_key` | Send one shortcut such as Ctrl+t, Ctrl+l, Enter, or Escape |
| `window_interact` | Ordered optional click → replace/type → shortcut → observation |
| `cursor_position` | Read the human pointer, not the agent cursor |
| `window_fullscreen` | Set/toggle fullscreen when explicitly requested |

`window_move` and `window_resize` are commented out and unavailable to agents.
Unknown arguments are rejected. Requests execute in received order, including
window selection and observation, so concurrent requests cannot overtake each other.

## Text-only OCR (API 0.3)

`window_screenshot({windowId, transcribe: true})` takes a native-resolution screenshot internally and returns
**only text**, never an image. Its JSON contains `screenshotId`, `regions` with
`{targetId, text, location}`, timing, and truncation information. Optional `query`
filters text case-insensitively. At most 300 regions are returned; recognition
scores below 0.8 are filtered. Pixel coordinates remain internal. `transcribe` defaults to false (image output).
OCR uses the native-resolution crop before maxWidth scaling; grid is ignored during
transcription so grid labels cannot be mistaken for content. There is no separate
window_read tool. Referencing an earlier screenshotId still captures a fresh image.

```js
window_screenshot({windowId: 123, transcribe: true})
window_click({screenshotId: "returned-id", targetId: "t12"})
// Or click a field and type in sequence:
window_interact({screenshotId: "returned-id", targetId: "t12", text: "hello"})
```

Each read invalidates older observations for that window. Target IDs are scoped to
their screenshotId; actions accept targetId OR x,y. OCR-based actions return fresh
OCR text too. Use `window_screenshot` explicitly for images and visual targeting.

Before a targetId click, the server captures again and compares pixels around the
text region. Changed pixels reject the click. This conservative check can reject
animations/cursor overlap; it cannot establish semantic identity, detect every
change elsewhere on the page, or prevent a change after checking. OCR text bounds
are not guaranteed clickable controls. Merged labels, duplicate labels, and icons
can require visual inspection. Extracted screen content is untrusted data.

### OCR installation

```sh
uv venv --python 3.12 .venv-ocr
uv pip install --python .venv-ocr/bin/python -r requirements-ocr.txt paddlepaddle==3.3.1
```

The MCP is a client of the operator-managed PaddleOCR service at
`http://127.0.0.1:1239` (`GET /health`, `POST /ocr`). It never starts, stops, or
restarts that GPU service. If the service is absent/unhealthy, it uses a persistent
local **CPU-only** worker; CUDA is hidden from that subprocess. A running service's
inference/busy errors are surfaced, rather than silently replayed on CPU.

On this machine, Mari's AI activity manages the service:

- `o`: `~/inference.mjs paddleocr` — launch/warm the GPU model on :1239.
- `k`: `~/inference.mjs kill-all` — stop text, System One, and OCR slots.
- `~/inference.mjs kill-ocr`: stop only OCR; the text model remains running.
- `~/inference.mjs ocr-last`: relaunch the last OCR preset.

OCR has independent `ocr.lock` / `ocr.log` files in `~/.cache/inference`.
The launcher owns the monitor and service process group; its stop path escalates
TERM to KILL if needed. No client reconnect or MCP restart relaunches the GPU model.
Closing MCP only stops its private CPU fallback. First use may download model
weights; image data stays on the local machine.

Install the GPU runtime instead of the CPU package for the managed service:

```sh
uv pip uninstall --python .venv-ocr/bin/python paddlepaddle
UV_HTTP_TIMEOUT=600 uv pip install --python .venv-ocr/bin/python paddlepaddle-gpu==3.3.0 --index https://www.paddlepaddle.org.cn/packages/stable/cu129/ --index https://pypi.org/simple --index-strategy unsafe-best-match
# Standalone operator launch (normally use the inference preset instead):
.venv-ocr/bin/python scripts/ocr-server.py --port 1239 --device gpu:0
```

The GPU runtime also supports the CPU fallback. `CUA_OCR_PYTHON` selects the
fallback executable (default `.venv-ocr/bin/python`); the MCP always forces its
fallback to CPU regardless of `CUA_OCR_DEVICE`. CPU oneDNN is disabled because of
an observed backend error. This fallback took 42–51 seconds on the dense 1926×1537
fixture. The RTX 5090 took 0.67–1.34 seconds warm (median 0.97), with a 14.08-second
first inference plus 3.84-second initialization. Sample process VRAM was 1.8 GiB.

Requests time out after 180 seconds. Screenshot expiry is 120 seconds from capture,
including OCR processing. Existing visual tools work even when OCR is unavailable.
Restart MCP after updating its code/environment.

## Screenshot coordinates

Capture first. Pass the returned `screenshotId` and coordinates in the **returned
image** to actions. Do not add desktop offsets, subtract browser chrome, or use
window-manager geometry. The server maps image coordinates through any crop/scale.
This replaces the old direct client-coordinate action API.

The default image width is at most 1280 pixels (`maxWidth`: 320–2000). To examine
a region, call `window_screenshot` with a screenshotId and
`crop: {x, y, width, height}` in that image's pixels; optionally use `grid: 100`.
Grid is an integer spacing in output-image pixels: 50 draws major lines every
50 pixels, 100 every 100; omitted or 0 disables it. Booleans are no longer accepted.
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
turning amber while typing. After three minutes without movement it disappears;
moving it again makes it visible. Screenshots and typing do not reset that timer. Screenshots include the actual overlay; its metadata
coordinates are image-relative. The cursor is not the text caret.

## Skill

[SKILL.md](SKILL.md) provides the agent workflow and recovery rules. Register it
with the user's skills CLI configuration:

```yaml
skills:
  computer-use: /workspace/mcp-computer-use/SKILL.md
```

Then `skills computer-use` prints it. Reload MCP tools after updating the server.
Local PaddleOCR text extraction is available through `window_screenshot({transcribe: true})`. Accessibility
trees and separate control/icon detection are not implemented.

## Checks

```sh
bun test test/*.test.mjs
cargo test --manifest-path overlay/Cargo.toml
cargo clippy --manifest-path overlay/Cargo.toml -- -D warnings
```

Opt-in desktop tests are documented in [overlay/README.md](overlay/README.md).
[PLAN-agent-cursor-overlay.md](PLAN-agent-cursor-overlay.md) is the historical
planning draft; the READMEs describe the implemented behavior.
