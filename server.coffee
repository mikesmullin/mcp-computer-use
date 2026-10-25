#!/usr/bin/env bun
# Target-based computer use; all coordinate handling stays inside providers.
import { runMcpStdioServer } from './shared/mcp-stdio.mjs'
import { createAwesome } from './lib/awesome.mjs'
import { createAgentX11 } from './lib/agent-x11.mjs'
import { createOcr } from './lib/ocr.mjs'
import { createZenTargets } from './lib/zen-targets.mjs'
import { createVisionClient } from './lib/vision-client.mjs'
import { createTargetInterface } from './lib/target-interface.mjs'
import { targetTools, instructions } from './lib/target-tools.mjs'

awesome = createAwesome()
x11 = createAgentX11()
ocr = createOcr()
api = createTargetInterface { awesome, x11, ocr, zen: createZenTargets(), vision: createVisionClient() }
shuttingDown = false
shutdown = ->
  return if shuttingDown
  shuttingDown = true
  await api.stop()
  await ocr.stop()
  await x11.stop()
process.once 'SIGTERM', -> shutdown().finally -> process.exit 0
process.once 'SIGINT', -> shutdown().finally -> process.exit 0
await runMcpStdioServer { name: 'computer-use', version: '0.4.0', instructions, tools: targetTools(api) }
await shutdown()
