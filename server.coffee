#!/usr/bin/env bun
# Computer-use MCP: AwesomeWM windows + X11 screenshot/type/click.
import { runMcpStdioServer, textResult } from './shared/mcp-stdio.mjs'
import { createAwesome } from './lib/awesome.mjs'
import { createAgentX11 } from './lib/agent-x11.mjs'
import { createInteraction, instructions } from './lib/interaction.mjs'

awesome = createAwesome()
x11 = createAgentX11()
interaction = createInteraction { x11, awesome }
shuttingDown = false
shutdown = ->
  return if shuttingDown
  shuttingDown = true
  await x11.stop()
process.once 'SIGTERM', -> shutdown().finally -> process.exit 0
process.once 'SIGINT', -> shutdown().finally -> process.exit 0

fmtWindow = (w) ->
  "id=#{w.windowId} class=#{w.class} title=#{JSON.stringify w.title} frameGeom=#{w.x},#{w.y} #{w.width}x#{w.height} screen=#{w.screen} fullscreen=#{w.fullscreen} focused=#{w.focused}"

fmtScreen = (s) ->
  "screen=#{s.index} geom=#{s.x},#{s.y} #{s.width}x#{s.height} workarea=#{s.workarea.x},#{s.workarea.y} #{s.workarea.width}x#{s.workarea.height}"

selectorProps =
  windowId:
    type: 'integer'
    description: 'X11 window id from window_list (preferred).'
  class:
    type: 'string'
    description: 'Window class, e.g. zen. Matches AwesomeWM client.class.'
  title:
    type: 'string'
    description: 'Substring of the window title.'
  focused:
    type: 'boolean'
    description: 'If true, use the focused window. Default when no other selector is given.'

select = (args) ->
  sel =
    windowId: args.windowId
    class: args.class
    title: args.title
    focused: args.focused
  if sel.windowId? or sel.class or sel.title or sel.focused is true
    return sel
  { focused: true }

schema = (properties, required = []) -> { type: 'object', additionalProperties: false, properties, required }
snapshotProp = { type: 'string', minLength: 1, description: 'Exact screenshotId from the latest observation/action result. IDs expire after 120 seconds or any action on that window.' }
pixelProp = { type: 'integer', minimum: 0, description: 'Pixel coordinate in the referenced IMAGE; no offsets.' }
keyProp = { type: 'string', minLength: 1, maxLength: 64, description: 'One chord, e.g. Ctrl+t, Ctrl+l, Ctrl+a, Enter, Tab, Escape.' }
actionProps =
  screenshotId: snapshotProp
  waitMs: { type: 'integer', minimum: 0, maximum: 2000, default: 300, description: 'Pause before observing; does not guarantee the app finished rendering.' }
clickProps =
  x: pixelProp
  y: pixelProp
  button: { type: 'integer', enum: [1, 2, 3], default: 1 }
textProps =
  text: { type: 'string', minLength: 1, maxLength: 4000 }
  replace: { type: 'boolean', default: false, description: 'Ctrl+a before typing; use only after targeting a text field.' }
  delayMs: { type: 'integer', minimum: 0, maximum: 100, default: 12 }

tools =
  window_list:
    description: 'List AwesomeWM windows with global x,y,width,height and screen index. ' +
      'The three monitors share one coordinate system (see window_list screens in the result). ' +
      'Does not change focus. Filter with class (zen) or title.'
    inputSchema:
      type: 'object'
      properties: { class: selectorProps.class, title: selectorProps.title }
    handler: (args = {}) ->
      [screens, wins] = await Promise.all [awesome.screens(), awesome.list()]
      shown = awesome.match wins, class: args.class, title: args.title
      text = [
        'screens (global coordinates):'
        screens.map(fmtScreen).join '\n'
        ''
        "#{shown.length} windows:"
        shown.map(fmtWindow).join '\n'
      ].join '\n'
      textResult text

  window_info:
    description: 'Read one window: x,y,w,h, screen index, fullscreen, title. Does not move it. ' +
      'Pass class=zen for the browser, or windowId from window_list.'
    inputSchema:
      type: 'object'
      properties: selectorProps
    handler: (args = {}) ->
      w = await awesome.one select args
      textResult fmtWindow w

  ###
  Move/resize tools disabled at the operator's request. Keep implementation for later.
  window_move:
    description: 'Move a window using AwesomeWM geometry. x,y are global coordinates unless ' +
      'screen is set, in which case x,y are relative to that screen workarea. Does not resize.'
    inputSchema:
      type: 'object'
      properties:
        Object.assign {}, selectorProps,
          x: { type: 'integer', description: 'X coordinate (global, or relative to screen workarea if screen is set).' }
          y: { type: 'integer', description: 'Y coordinate.' }
          screen: { type: 'integer', description: 'Awesome screen index from window_list (1-based).' }
      required: ['x', 'y']
    handler: (args = {}) ->
      w = await awesome.one select args
      screens = await awesome.screens()
      x = Number args.x
      y = Number args.y
      unless Number.isInteger(x) and Number.isInteger(y)
        return textResult 'x and y must be integers', true
      if args.screen?
        s = screens.find (sc) -> sc.index is Number args.screen
        unless s then return textResult "Unknown screen #{args.screen}", true
        x += s.workarea.x
        y += s.workarea.y
        after = await awesome.apply w.windowId, "c:move_to_screen(screen[#{s.index}]); c:geometry({ x = #{x}, y = #{y} })"
      else
        after = await awesome.apply w.windowId, "c:geometry({ x = #{x}, y = #{y} })"
      textResult "moved. #{fmtWindow after}"

  window_resize:
    description: 'Resize a window using AwesomeWM geometry (width/height in pixels). Position unchanged.'
    inputSchema:
      type: 'object'
      properties:
        Object.assign {}, selectorProps,
          width: { type: 'integer', minimum: 50 }
          height: { type: 'integer', minimum: 50 }
      required: ['width', 'height']
    handler: (args = {}) ->
      w = await awesome.one select args
      width = Number args.width
      height = Number args.height
      unless Number.isInteger(width) and Number.isInteger(height) and width >= 50 and height >= 50
        return textResult 'width and height must be integers >= 50', true
      after = await awesome.apply w.windowId, "c:geometry({ width = #{width}, height = #{height} })"
      textResult "resized. #{fmtWindow after}"

  ###

  window_fullscreen:
    description: "Toggle or set AwesomeWM fullscreen (c.fullscreen), not a fake maximize. " +
      "on=true/false, or omit to toggle. This is Awesome's fullscreen."
    inputSchema:
      type: 'object'
      properties:
        Object.assign {}, selectorProps,
          on: { type: 'boolean', description: 'true=fullscreen, false=restore. Omit to toggle.' }
    handler: (args = {}) ->
      w = await awesome.one select args
      body = if args.on is true then 'c.fullscreen = true'
      else if args.on is false then 'c.fullscreen = false'
      else 'c.fullscreen = not c.fullscreen'
      interaction.views.invalidate w.windowId
      after = await awesome.apply w.windowId, body
      textResult "fullscreen=#{after.fullscreen}. #{fmtWindow after}"

  window_screenshot:
    description: 'Observe a window. Returns screenshotId and an image; action x,y are pixels in THAT image, with NO offsets. To zoom, pass screenshotId and crop in that image pixels. grid=true labels every 100 pixels. Does not move/resize the window.'
    inputSchema: schema Object.assign({}, selectorProps,
      screenshotId: snapshotProp
      crop:
        type: 'object'
        additionalProperties: false
        required: ['x', 'y', 'width', 'height']
        properties:
          x: pixelProp
          y: pixelProp
          width: { type: 'integer', minimum: 1 }
          height: { type: 'integer', minimum: 1 }
      maxWidth: { type: 'integer', minimum: 320, maximum: 2000, default: 1280 }
      grid: { type: 'boolean', default: false }
    )
    handler: (args = {}) -> interaction.screenshot args

  window_type:
    description: 'Send literal text to the currently focused control in the screenshot window. Does not locate or focus a text field. Prefer window_interact to click a field and type in order. Returns a fresh screenshot; verify the text appeared.'
    inputSchema: schema Object.assign({}, actionProps, textProps), ['screenshotId', 'text']
    handler: (args = {}) -> interaction.action 'type', args

  window_key:
    description: 'Send one shortcut to the screenshot window and return a fresh screenshot. Examples: Ctrl+t (new tab), Ctrl+l (address bar), Enter, Tab, Escape, Ctrl+a. Use the new screenshotId for the next call.'
    inputSchema: schema Object.assign({}, actionProps, keys: keyProp), ['screenshotId', 'keys']
    handler: (args = {}) -> interaction.action 'key', args

  window_interact:
    description: 'Ordered interaction: optional click at screenshot IMAGE x,y, then optional text (replace=true selects existing text), then optional shortcut, then fresh screenshot. Use for click-and-type. Input delivery is not proof of app success. Never batch a separate click and type in parallel.'
    inputSchema: schema Object.assign({}, actionProps, clickProps, textProps, keys: keyProp), ['screenshotId']
    handler: (args = {}) -> interaction.action 'interact', args

  cursor_position:
    description: 'Read the HUMAN mouse cursor (not the blue agent cursor) in global screen coordinates (same system as window_list). ' +
      'Does not move the pointer. These global human coordinates are NOT window_click coordinates; use a screenshot to target clicks. ' +
      'Also returns the X11 window under the cursor (id, class, title) when available.'
    inputSchema:
      type: 'object'
      properties: {}
    handler: ->
      pos = await x11.cursorPosition()
      screens = await awesome.screens()
      monitor = screens.find (s) -> pos.x >= s.x and pos.y >= s.y and pos.x < s.x + s.width and pos.y < s.y + s.height
      rel = if monitor then " awesome-screen=#{monitor.index} local=#{pos.x - monitor.x},#{pos.y - monitor.y}" else ''
      win = if pos.windowId then " window=#{pos.windowId} class=#{pos.windowClass or '?'} title=#{JSON.stringify pos.windowName}" else ''
      textResult "cursor x=#{pos.x} y=#{pos.y} x11-screen=#{pos.screen}#{rel}#{win}"

  window_click:
    description: 'Click the CENTER of a target in a returned screenshot. Pass its screenshotId and x,y in IMAGE pixels; do not subtract browser/title-bar offsets or add desktop coordinates. Returns a fresh screenshot. After a miss, inspect a crop/grid before retrying.'
    inputSchema: schema Object.assign({}, actionProps, clickProps), ['screenshotId', 'x', 'y']
    handler: (args = {}) -> interaction.action 'click', args

# All exposed schemas reject unknown arguments; dispatch also validates at runtime.
for name, definition of tools
  definition.inputSchema.additionalProperties = false

await runMcpStdioServer
  name: 'computer-use'
  version: '0.2.0'
  instructions: instructions
  tools: tools

await shutdown()
