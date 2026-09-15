# mcp-computer-use

AwesomeWM + X11 computer-use MCP for Ada. Beginning of a desktop-control
surface: window geometry on a multi-monitor Awesome setup, plus screenshot,
type, and click.

Coordinates are **global** (one system across all screens). `screen` is
Awesome's 1-based index so Ada can place a window on a specific monitor.
Fullscreen uses Awesome `client.fullscreen`, not a fake maximize.

Typing uses `xdotool type` (XTEST), the same injection path as
`/workspace/whisper` (pynput XTEST / vk keysyms). GTK4 apps discard XSendEvent.

## Tools

| Tool | Notes |
|---|---|
| `window_list` | screens + windows (`class=zen` for the browser) |
| `window_info` | one window's x,y,w,h,screen,fullscreen |
| `window_move` | global x,y or `screen` + workarea-relative x,y |
| `window_resize` | width/height |
| `window_fullscreen` | `on` true/false or toggle |
| `window_screenshot` | image of that X window |
| `window_type` | type text (max 4000 chars) |
| `window_click` | click x,y relative to the window |

## Run

```
cd /workspace/mcp-computer-use && bun install
bun server.coffee
```

Ada loads this as MCP `computer-use` (`prefix: false`). Requires `awesome-client`,
`xdotool`, `scrot`, and a working `DISPLAY`.
