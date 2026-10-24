# Plan: Agent Second Cursor Overlay for mcp-computer-use

## 1. Context and goal

`/workspace/mcp-computer-use` is a coffee-script/Bun MCP server (stdio) that gives AI agents
desktop control on the user's Arch + AwesomeWM (bare X11, no compositor) multi-monitor setup.
Current tools: `window_list`, `window_info`, `window_move`, `window_resize`,
`window_fullscreen`, `window_screenshot`, `window_type`, `cursor_position`, `window_click`.
It drives windows via `awesome-client` (Lua), input via `xdotool` (XTEST/XSendEvent-family),
and captures via `scrot -w`.

Problem: when the agent acts, the human has no visual feedback about *what the agent did*
(only that the real pointer moved, which is indistinguishable from human motion, and
which is actually *wrong* — xdotool `--window` moves the pointer for clicks/types).

Reference architecture: trycua/cua driver (`libs/cua-driver`) in `tmp/trycua-cua`
(referenced, git-ignored, NOT a dependency). Its Linux X11 overlay
(`rust/crates/platform-linux/src/overlay.rs` + `rust/crates/cursor-overlay/*`) is the
proven recipe for an always-on-top, click-through agent cursor on bare X11.

Goal: the agent gets a **separate visible cursor** (a small animated glyph distinct from
the user's pointer) that appears at the point of each agent action and fades out. The
user's real pointer, focus, and windows are not disturbed by the overlay.

## 2. Non-goals (explicit)

- NOT a Rust rewrite of the MCP server. The MCP stays coffee-script/Bun.
- NOT embedding/adopting trycua/cua as a dependency (license/maintenance coupling,
  macOS-centric, no awesome-client support). Its X11 overlay source is reference material
  only.
- NOT Wayland support (user's WM is awesomewm/X11; pure-Wayland is explicitly a TODO
  in CUA's own code).
- NOT transparency/alpha blending in v1 (see Risks §6.2) — opaque glyph with halo.
- NOT the full CUA motion system. Motion is a simple ease-in-out arc; upgradeable later.
- NOT AGPL-perception features (OmniParser icon detection).

## 3. Architecture

Two processes:

```
pi/claude/etc.
   │  stdio MCP (JSON-RPC, NDI)
   ▼
mcp-computer-use (bun, coffee)        ←  unchanged surface, 11 small additions
   │  spawns once at first action
   │  line protocol on its stdin:  show|moves|click|type|screen|fade|quit\n
   ▼
cua-overlay (rust, single binary)     ←  NEW: X11 override-redirect overlay
   • full-virtual-screen window, ARGB visual (XComposite)
   • 60 Hz render thread; per-frame tile upload via XPutImage
   • XShape mask = cursor glyph silhouette  → click-through
   • XRaiseWindow every 80 ms
   • never moves/steals the X pointer, never takes focus
```

Why a sidecar rather than in-process (coffee) or in-process (rust): coffee/bun has no
X11 FFI (and spawning a small native per action would be slow and would leak if the
MCP dies — a long-lived child with a kill hook is the right failure mode). A Rust sidecar
matches the language the X11 overlay code should be written in, and it is a *new file*,
so it cannot regress the working MCP.

## 4. Rust overlay — design

### 4.1 Crate layout

```
mcp-computer-use/
├── server.coffee                 # existing
├── lib/  shared/  package.json   # existing
├── overlay/
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs        # arg parsing, X connection setup, loop
│       ├── ops.rs         # line-protocol parser (stdin)
│       ├── window.rs      # X11: connection, ARGB visual, shape, raise timer
│       ├── compositor.rs  # save-under + tile compositing
│       └── glyph.rs       # glyph geometry + simple motion easing
│   └── tests/             # glyph/motion unit tests (pure fn, no X)
```

### 4.2 Op protocol (stdin, one op per line)

```
show <x> <y>              # place agent cursor at global (x,y); start fade timer
move <x> <y>              # move active cursor (for motion path)
type <x> <y> <chars>      # show at window's text-entry point; (v1 same as show)
screen <sx> <sy> <w> <h>  # optional: reposition window to a new full-screen geometry
                           # (v1 instead: main.rs re-queries XRoot every N frames)
fade <ms>                # set fade duration (default 2500)
blink                  # toggle high-visibility blink for error state (optional, v2)
quit                   # exit
```

Global coords are X *virtual screen* coords (same as `cursor_position`/`window_list`
report — 0,0 is the top-left of the virtual screen, spanning all 3 monitors).
The MCP computes these from its existing `awesome.mjs` screen data, so the overlay needs
to know nothing about AwesomeWM.

Semantics:
- `show`/`move` re-arm the fade timer (cursor stays visible while the agent is acting).
- Idle timeout (default 5s after last op, configurable) fades out.
- While faded out, the overlay window stays mapped-but-invisible (alpha 0 / zero-shape)
  to avoid flicker on next action; `quit` unmaps and exits.

### 4.3 X11 window (v1)

Follow CUA `platform-linux/src/overlay.rs` as the reference (read the file comments
in `tmp/trycua-cua/libs/cua-driver/rust/crates/platform-linux/src/overlay.rs` before
implementing):

1. Connect to `$DISPLAY` (must be set; fail loudly with a useful message if not).
2. Request an **ARGB 32-bit visual** via `XComposite`/`XRender`
   (`XRenderFindDefaultVisual` with RGBA components) so the overlay can be alpha-cut.
3. Create a full-virtual-screen window at (0,0) — size = `XRootWindowGeometry`
   (query `DisplayWidth/Height` of root, not the primary monitor; re-query on
   `ConfigureNotify` or every second and re-create on RandR change).
4. Set `override-redirect` hint: `_NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_OVERRIDE_REDIRECT`
   and a private class e.g. `_CUA_OVERLAY`. awesomewm does not client-manage
   override-redirect windows → it will not move/focus it.
5. **XShape**:
   - `XShapeSelectInput(shape_window, x11, 0)` — SHAPE_INPUT: input events clip to the
     glyph silhouette and fall through to windows below (user's pointer/clicks are
     unaffected).
   - Shape mask = current glyph alpha mask (0..255). Update mask only when the glyph
     silhouette changes (position + glyph type), not per-frame.
6. **No focus ever**:
   - Window type: `OverrideRedirect` (WM won't focus it).
   - Never grab pointer/keyboard, never take input focus.
   - `_CUA_OVERLAY` window class so the user can identify it in tools.
   - Verify in tests: `xdotool getmouselocation` before/after ops shows the *same*
     global pointer position (the overlay never calls XTestPointerReset/Grab etc.).

### 4.4 Rendering — v1 (opaque glyph + halo)

- Glyph: a 24 px "agent arrow" (classic pointer arrow, 45° rotated, pointing at the
  click point — or a small dot+ring; pick one and keep it distinct from the OS cursor
  shape). Colors: CUA blue `#4F86F7` fill (or `#0F80FF`), dark halo `#00000099`-style
  → for v1 draw an opaque 2 px dark halo (black 40%-darker, i.e. a slightly darker
  black ring) around the arrow so it is legible on both light and dark backgrounds.
- Rendering is **per-frame tile compositing** (not a whole-window blit):
  - Divide the glyph bounding box (e.g. 64×64 px around the agent cursor) into small
    tiles (8×8 or 16×16).
  - For each tile: `XGetSaveUnderWindow` (via XRender) → real desktop pixels.
  - Composite glyph alpha on top in CPU (Rust) into an RGBA tile buffer.
  - `XPutImage` the tile to the overlay window.
  - This is what CUA does and is required on bare X11 because the X server will not
    blend alpha without a compositor. (With a compositor present, this path is still
    correct, just slightly slower — fine at 64×64.)
- **Frame budget**: only the glyph's bounding-box tiles (64×64 / 16×16 = 16 tiles) are
  redrawn per frame, ~60 Hz ≈ 1000 small `XPutImage`+`XGetSaveUnderWindow` calls/sec.
  This is trivial for a desktop X server.
- Motion (v1): `move from → to` animates over `duration = clamp(150 + 8*dist_px, 250, 800)`
  ms with ease-in-out-quad (or cubic). 120 Hz sampled path, `sample_at(t)` → hotspot.
  Clicks fire on `arrival_t` — i.e. the MCP should send `show`/`move` *before* the
  actual `xdotool click` so the click visually lands as the arrow arrives. (MCP
  orchestration detail, §5.)

### 4.5 No-compositor (bare awesomewm) specifics — the crux

Per CUA's `overlay.rs` doc-comment:
- Without a compositor, the X server **never blends alpha** on the overlay. Our
  `XGetSaveUnderWindow` read + software-composite solve this: we read what's under the
  tile, draw the glyph (opaque in v1) on top, and upload the composite. The visible
  shape = the glyph silhouette (shape mask), and it is opaque — acceptable.
- "Painted-pixel bookkeeping": we must distinguish tiles we painted from real desktop
  pixels on subsequent reads. Maintain a hash table:
  for each painted rect → (desktop copy read at paint time, painted rgba). A re-read of
  a painted rect is "still our paint" iff the read-back equals the painted rgba (modulo
  save-under stability). If not trusted (RandR change / compositor arrival — detected by
  `XRenderQueryRenderFeatures` or just re-querying `SaveUnderWindow` availability),
  blank the overlay for ~300 ms so windows below repaint before we read again.
  *v1 simplification allowed*: on RandR change, just re-query root geometry, re-create
  window, and assume desktop is clean. The full bookkeeping is a v2 polish.

### 4.6 Crash & lifecycle hygiene

- `quit` / SIGTERM / SIGINT → unmap window, restore shape, close X connection, exit 0.
- The overlay process must *not* exit if X drops (reconnect loop, 3 tries, backoff 1 s)
  — on X loss, log to stderr and exit non-zero so the MCP can warn the agent.
- If the X connection fails at startup, exit 1 with `no X display` message (the MCP
  treats this as a soft failure: tools continue to work, cursor just off).
- The MCP kills the overlay on shutdown (SIGTERM → SIGKILL after 2 s).

### 4.7 Tests (Rust)

- **Unit (no X, no network):**
  - `glyph.rs`: glyph alpha mask generation is deterministic, centered, within bounds.
  - Motion: `ease_in_out_quad(t)` properties (monotonic, f(0)=0, f(1)=1, symmetric);
    `plan_move` produces a path that starts at `from`, ends at `to`, and `sample_at(arrival_t)`
    == target; `arrival_t <= duration`; duration clamped to [150, 800] ms.
  - Op parser: parse `show 1 2`, reject garbage, handle CRLF, empty lines.
- **Integration (requires X session — user runs locally, not in CI):**
  - Run `overlay serve` (interactive test mode), send `show 100 100` / `move 900 500` /
    `quit`, capture with `scrot` and assert the arrow is present (pixel check or manual
    eyeball for v1; note in README that no headless X test can verify visual content).
  - Pointer-preservation assertion: `xdotool getmouselocation` before and after each op;
    assert global x,y unchanged (within 1 px).
  - Click-through assertion: while overlay cursor is visible, drive `xdotool click`
    at a browser button, assert it fired (e.g., navigate to a known URL and read the
    title back via `xdotool getwindowname`).
- **CI**: no CI X session (assume no xvfb display available). CI runs cargo
  `build` + `test` (unit) + clippy. Mark integration tests `#[ignore]`-gated by env
  `CUA_OVERLAY_X=1`.

## 5. CoffeeScript MCP integration

Changes (all additive; tool names/behavior unchanged):

1. **`cursor-overlay` module** (`lib/cursor-overlay.coffee` or `.mjs`):
   - `start(pathToBinary)`: spawn `overlay/target/release/cua-overlay` (or `cargo
     run` in dev), capture stderr to a rotating log file
     `/tmp/cua-overlay-<pid>.log` (gitignored, tmp/ or /tmp).
   - Keep the stdin handle open; `send(op)` writes a line.
   - `stop()`: write `quit`, wait 2 s, kill(-15) then kill(-9) on timeout.
   - Expose: `overlay.show(x, y)`, `overlay.move(from, to)`, `overlay.fade(ms)`.
   - Lazy start: on first `window_click`/`window_type`/`window_move` call, if not already
     running, spawn. Fail-open: if the binary is missing or spawn fails, log a one-line
     warning to the MCP stderr (MCP server stderr → pi logs) and continue serving.
   - Config via env:
     - `CUA_CURSOR=off` → never spawn (default `on`? — see decision below)
     - `CUA_CURSOR_COLOR`, `CUA_CURSOR_FADE_MS` (default 2500), `CUA_CURSOR_IDLE_MS` (default 5000)
   - **Decision needed from user (see §9)**: default on or off?

2. **Wire ops into existing handlers** (in `server.coffee`):
   - `window_click`: before `xdotool click`, send `show`/`move` to the click point
     (global coords computed the same way the click is computed: window geom +
     `x,y` relative, in `screen` global frame).
   - `window_type`: send `move` to the top-left of the target window (or center of its
     title bar area) so the user knows which window the text is going into; do *not*
     move the real pointer (xdotool `--window` does not move the global pointer —
     verify: `windowtype` currently uses `xdotool type --window` which does *not*
     move the pointer; only `windowclick` moves it. So `type` = `show` at window
     top-left).
   - `window_move`: send `move` to the window's new center (user sees the window travel
     with the agent cursor). *Optional, v2.*
   - `window_fullscreen`: no cursor op needed (the window itself is the feedback).
   - `window_screenshot`: *v2 idea* — flash a thin border around the captured window
     for 300 ms so the user sees which window the agent "saw." (Not in v1 scope.)
   - `cursor_position`: no op.
   - On MCP shutdown (stdin `end` event), call `overlay.stop()`.

3. **Tool surface**: no new MCP tools in v1 (the cursor is side-effect of existing
   tools). v2: add a `cursor` tool (get/set state, enable/disable at runtime) —
   not required.

4. **Error contract**: overlay failures must never cause tool errors. If spawn/ops fail
   the click/type still succeeds; the user just won't see the cursor. Log to MCP
   stderr.

## 6. Risks and known gotchas

1. **Override-redirect + awesomeWM**: awesomewm does not manage override-redirect
   windows (they don't appear as clients). Verify on first run with `window_list`
   (the overlay must NOT appear in the MCP's `window_list` — it should not, since
   awesome-client filters them out; if it does, add a `class != '_CUA_OVERLAY'`
   filter).
2. **No compositor alpha** (the crux). v1 draws an opaque glyph + dark halo. This
   is visible on any background (we choose halo color to be ~80% black, glyph ~70%
   blue, so it reads on both light and dark). The "opaque on screen" limitation
   from CUA's doc (you can't read through a resting cursor) does not matter for us
   because the overlay never needs to read the area under the *agent* cursor — it
   only reads *other* tiles, and the glyph silhouette is small. If the user's real
   pointer rests on the agent cursor while idle, that area is opaque for 5 s;
   acceptable.
3. **Pointer must not move**. The overlay draws only; it never calls XTestPointerMove,
   XTestPointerButton, or any XTEST. The real pointer is never touched by the overlay.
   (The MCP's `window_click` *does* move the real pointer via xdotool `--window` —
   that's existing behavior and intentional: the agent's "click" is a real X11
   click. The overlay arrow is *additional* visual feedback, not the click path.)
4. **Focus must not steal**. OverrideRedirect window type + no focus-grabbing events
   ensures the user's focused window stays focused. Verify with `xdotool getactivewindow`
   before and after ops.
5. **Multi-monitor / RandR**. The overlay window spans the virtual screen (0,0 →
   root width × height). Monitor add/remove changes root geometry; re-query every
   2 s and re-create the window on change (simplest correct behavior; v1 does not
   need to be live).
6. **Z-order over the user's windows**. `XRaiseWindow` every 80 ms keeps it on top.
   Risk: if awesomewm or a fullscreen app does something aggressive, the overlay could
   dip for ~80 ms. Acceptable. (CUA's `cursor-overlay/rust/crates/cursor-overlay/src/z_order.rs`
   solves the same problem — read it.)
7. **Security**: the overlay is read-only (draw-only, click-through, never grabs). It
   cannot read the user's pointer position, cannot type, cannot move anything. It is
   a pure drawing window. The only trust assumption is that it runs as the user (same
   as the MCP itself).
8. **Performance**: 16 small `XGetSaveUnderWindow` + `XPutImage` per frame ≈ 1000 calls
   /s at 60 Hz. On a modern X server + CPU this is ~1–3% of a core during an active
   move; negligible. When idle (faded, shape = empty), the loop idles at 1 Hz (no
   draw work).
9. **Killing the process**: the MCP must SIGTERM the overlay on shutdown. If the
   agent process is killed hard (SIGKILL), the overlay becomes an orphan. Mitigation:
   the overlay has its own idle-exit (quit after 10 s of no ops, `CUA_OVERLAY_IDLE`
   env, default 100000 ms) and a "no ops for 60 s" hard-quit. So worst case it
   self-exits.

## 7. Deliverables (milestones)

**M1 — Rust overlay binary, standalone (no MCP change)**
- [ ] `overlay/` crate: `cargo build --release` produces `cua-overlay`
- [ ] `cua-overlay` reads ops from stdin, draws glyph at given (x,y) globally, fades
- [ ] Ops: `show x y`, `move x y`, `fade ms`, `quit`
- [ ] Pointer-preservation + click-through + awesomeWM-compatibility smoke tests
  (integration test script, run by user, `CUA_OVERLAY_X=1`)
- [ ] README in `overlay/` documenting ops protocol and the bare-X11 limitations

**M2 — Wire into the CoffeeScript MCP**
- [ ] `lib/cursor-overlay.coffee`: spawn/ops/stop
- [ ] `window_click` → `move` to click point
- [ ] `window_type` → `show` at window top-left
- [ ] Fail-open contract (overlay failures never fail a tool)
- [ ] Env config: `CUA_CURSOR` (on/off), `CUA_CURSOR_FADE_MS`, `CUA_CURSOR_IDLE_MS`
- [ ] Default `CUA_CURSOR=on` (user decision §9)
- [ ] Shutdown cleanup

**M3 — Polish (optional, v2)**
- [ ] Motion easing (already in M1 — `ease-in-out-quad` on `move`)
- [ ] Screenshot border-flash (`window_screenshot` → flash border of the window)
- [ ] Full save-under bookkeeping (randr-safe compositing without v1 simplifications)
- [ ] `cursor` MCP tool (runtime enable/disable)
- [ ] Unit test for motion `sample_at`

## 8. Acceptance criteria (end-to-end, user verifies on their desktop)

1. `pi mcp list` shows `computer-use` connected (unchanged).
2. Run the MCP; do `window_click` on the zen browser at a known location
   (e.g., the "Star" button). The user sees:
   - a small blue arrow with dark halo fly to that point, click fires, star count
     changes (or the button does its thing).
   - their real mouse pointer did *not* move during the click.
3. `window_type` into a text field shows the arrow at the window's top-left, text
     appears, real pointer unmoved.
4. After ~5 s of no agent action, the arrow fades out and nothing else changes
   (windows, focus, pointer all unchanged).
5. `cursor_position` still reports the user's real pointer correctly.
6. `window_list` does not list the overlay as a window (if it does, add the
   filter in M2).
7. Overlay process is present (visible via `ps aux | grep cua-overlay`) and is
   killed when the pi session ends.
8. `CUA_CURSOR=off` → no overlay process, all tools work identically.
9. Multi-monitor: `window_click` into a window on screen 1 and screen 3 both
   show the arrow at the right global location (on the correct physical monitor).
10. Kill the overlay process mid-run (user does it) → MCP logs a warning, clicks
    still work, and (on next action) the overlay respawns.

## 9. Decisions needed from user before M2

1. **Default on or off?** (`CUA_CURSOR=on` vs `off`.) Recommendation: on.
2. **Glyph style**: (a) classic pointer arrow (blue, dark halo), (b) dot + ring,
    (c) dot + ring + tiny "A" letter. (a) recommended — most legible, matches
    "second cursor" mental model.
3. **Color**: CUA blue `#4F86F7` recommended (distinct from OS cursor and from
    any app content).
4. **Fade duration**: 2500 ms recommended (long enough to read, short enough to
   get out of the way).
5. **Should `window_move`/`window_resize` also emit cursor ops?** (v1: no.
    v2: `window_move` → `move` to new center.)
6. **Should `window_screenshot` flash a border around the captured window?**
    (v1: no. v2: yes — this is the "I saw this window" feedback and I think it's
    valuable.)

## 10. Files the implementation must NOT touch (guardrails)

- `server.coffee` tool *names* and *descriptions* (unchanged; only handler bodies gain
  overlay ops)
- `lib/awesome.mjs`, `lib/x11.mjs` (unchanged; new ops are additive)
- `package.json` (no new deps for the MCP; the overlay is a separate `cargo` project)
- `~/.pi/agent/mcp.json` (unchanged — the overlay is not a new MCP tool, it's a
  process the existing server manages)
- `tmp/` (reference clones only; the overlay crate is *not* here)

## 11. Reference sources (in `tmp/trycua-cua`)

- `libs/cua-driver/rust/crates/platform-linux/src/overlay.rs` — the X11 overlay
  architecture (read the whole doc-comment block at the top first).
- `libs/cua-driver/rust/crates/platform-linux/src/x11/*` — X11 connection helpers
  (XGetSaveUnderWindow, ARGB visual, XComposite usage).
- `libs/cua-driver/rust/crates/cursor-overlay/src/*` — glyph rendering, theme
  artifacts (v1 simplifies: hard-code one glyph + color).
- `libs/cua-driver/rust/crates/cua-cursor-motion/src/*` — motion math if the user
  later wants fancier trajectories.
- `libs/cua-driver/docs/action-support.md`, `docs/linux-desktop-validation.md`
  — platform behavior expectations.

## 12. Out of scope for this plan (v2+)

- Wayland overlay (CUA's own `wayland/` path; user's WM is X11).
- Perception / semantic windows (AT-SPI, OmniParser) — AGPL concerns, not needed.
- Multi-agent cursor (two different-colored cursors, e.g. Ada + pi) — fun v3,
  the design (per-agent color + per-agent ops channel) already supports it.
- macOS / Windows (not relevant to the user's setup).
- Full CUA motion library integration (v1 uses a hand-rolled ease-in-out-quad).
