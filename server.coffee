#!/usr/bin/env bun
# Computer-use MCP: AwesomeWM windows + X11 screenshot/type/click.
import { runMcpStdioServer, textResult } from './shared/mcp-stdio.mjs'
import { createAwesome } from './lib/awesome.mjs'
import { createX11 } from './lib/x11.mjs'

awesome = createAwesome()
x11 = createX11()

fmtWindow = (w) ->
  "id=#{w.windowId} class=#{w.class} title=#{JSON.stringify w.title} geom=#{w.x},#{w.y} #{w.width}x#{w.height} screen=#{w.screen} fullscreen=#{w.fullscreen} focused=#{w.focused}"

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
      after = await awesome.apply w.windowId, body
      textResult "fullscreen=#{after.fullscreen}. #{fmtWindow after}"

  window_screenshot:
    description: 'Capture a window from the X11 framebuffer (visible pixels). Returns an image. ' +
      'Does not switch tabs inside the app; uses the window rectangle.'
    inputSchema:
      type: 'object'
      properties: selectorProps
    handler: (args = {}) ->
      w = await awesome.one select args
      shot = await x11.screenshot w
      {
        content: [
          { type: 'text', text: "screenshot #{w.width}x#{w.height} #{fmtWindow w}" }
          { type: 'image', mimeType: shot.mimeType, data: shot.bytes.toString 'base64' }
        ]
      }

  window_type:
    description: 'Type text into a window via xdotool XTEST (same mechanism as the whisper voice keyboard). ' +
      'Focuses the window first. Not for passwords. Max 4000 characters.'
    inputSchema:
      type: 'object'
      properties:
        Object.assign {}, selectorProps,
          text: { type: 'string', minLength: 1, maxLength: 4000 }
          delayMs: { type: 'integer', minimum: 0, maximum: 100, default: 12 }
      required: ['text']
    handler: (args = {}) ->
      w = await awesome.one select args
      result = await x11.typeText w.windowId, args.text, delayMs: args.delayMs
      textResult "typed #{result.chars} chars into #{w.class} id=#{w.windowId} title=#{JSON.stringify w.title}"

  window_click:
    description: 'Left/middle/right click at x,y relative to the window top-left (window coordinates, not a CSS selector). Focuses the window first.'
    inputSchema:
      type: 'object'
      properties:
        Object.assign {}, selectorProps,
          x: { type: 'integer', minimum: 0 }
          y: { type: 'integer', minimum: 0 }
          button: { type: 'integer', enum: [1, 2, 3], default: 1 }
      required: ['x', 'y']
    handler: (args = {}) ->
      w = await awesome.one select args
      result = await x11.click w.windowId, x: args.x, y: args.y, button: args.button ? 1
      textResult "clicked button #{result.button} at #{result.x},#{result.y} in #{w.class} id=#{w.windowId}"

await runMcpStdioServer
  name: 'computer-use'
  version: '0.1.0'
  tools: tools
