// Opt-in test: open test/target-page.html through a localhost HTTP server in Zen.
// CUA_OVERLAY_X=1 node test/mcp-smoke.mjs WINDOW_ID
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";
import { createX11 } from "../lib/x11.mjs";
if (process.env.CUA_OVERLAY_X !== "1")
  throw Error("Set CUA_OVERLAY_X=1 for live desktop input");
const windowId = process.argv[2];
if (!/^[1-9][0-9]*$/.test(windowId))
  throw Error("Pass the fixture X11 window ID");
const c = new Client({ name: "target-smoke", version: "1" }),
  z = new Client({ name: "target-check", version: "1" });
await c.connect(
  new StdioClientTransport({
    command: "bun",
    args: ["server.coffee"],
    cwd: new URL("..", import.meta.url).pathname,
    env: process.env,
    stderr: "inherit",
  }),
);
await z.connect(
  new StreamableHTTPClientTransport(
    new URL(process.env.MCP_ZEN_URL || "http://127.0.0.1:8791/mcp"),
  ),
);
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, {
    timeout: 120000,
  });
  assert.ok(!r.isError, r.content[0]?.text);
  return JSON.parse(r.content.find((x) => x.type === "text").text);
};
const inspect = async (script) => {
  const r = await z.callTool({
    name: "zen_browser_eval",
    arguments: { script },
  });
  assert.ok(r.structuredContent.response.success);
  return r.structuredContent.response.data.result;
};
const before = await createX11().cursorPosition();
try {
  const names = (await c.listTools()).tools.map((t) => t.name);
  assert.equal(names.length, 11);
  assert.ok(!names.includes("cursor_position"));
  assert.ok(!names.includes("window_screenshot"));
  const win = (await call("window_list")).find((w) => w.windowId === windowId);
  assert.equal(win?.title, "Computer use target fixture — Zen Browser");
  let o = await call("browser_page_find", {
    windowId,
    filter: "Fixture name",
    scope: "loaded_document",
  });
  assert.equal(o.targets.length, 1);
  let r = await call("window_type", {
    observationId: o.observationId,
    target: { id: o.targets[0].id },
    text: "verified native typing",
  });
  assert.equal(r.status, "input_sent");
  assert.equal(r.verification, "focus_verified");
  assert.equal(
    await inspect('document.querySelector("#name").value'),
    "verified native typing",
  );
  o = await call("browser_page_find", { windowId, filter: "Duplicate" });
  r = await call("window_click", {
    observationId: o.observationId,
    target: { label: "Duplicate" },
  });
  assert.equal(r.status, "rejected");
  assert.match(r.reason, /Ambiguous/);
  o = await call("browser_page_find", {
    windowId,
    filter: "Hidden fixture",
    scope: "loaded_document",
  });
  assert.equal(o.targets.length, 0);
  o = await call("browser_page_find", {
    windowId,
    filter: "Bottom fixture",
    scope: "loaded_document",
  });
  assert.equal(o.targets[0].visibility, "offscreen");
  const old = o;
  r = await call("window_click", {
    observationId: o.observationId,
    target: { id: o.targets[0].id },
  });
  assert.equal(r.status, "input_sent");
  assert.equal(
    await inspect('document.querySelector("#status").textContent'),
    "Clicked bottom",
  );
  r = await call("window_click", {
    observationId: old.observationId,
    target: { id: old.targets[0].id },
  });
  assert.equal(r.status, "rejected");
  assert.ok(r.observation);
  o = await call("browser_page_find", { windowId, filter: "Bottom confirmed" });
  const crop = await call("image_crop", {
    observationId: o.observationId,
    target: { id: o.targets[0].id },
  });
  assert.ok(crop.imageId);
  r = await call("window_click", {
    observationId: o.observationId,
    target: { id: o.targets[0].id },
    count: 2,
  });
  assert.equal(r.status, "input_sent");
  r = await call("window_scroll", {
    windowId,
    direction: "up",
    amount: "small",
  });
  assert.equal(r.status, "input_sent");
  const screenshot = await call("browser_screenshot", {
    windowId,
    scope: "full_page",
  });
  assert.equal(screenshot.truncated, false);
  r = await call("decide", {
    system_prompt: "The button label is Bottom confirmed.",
    question: { type: "boolean", prompt: "Does the label contain confirmed?" },
  });
  assert.equal(r.answer.type, "boolean");
  const after = await createX11().cursorPosition();
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  console.log(
    "PASS: 11-tool stdio API, DOM typing/value, hidden/ambiguous/stale targets, offscreen native click, crop, double click, native scroll, full-page capture, H2O decision, unchanged human pointer",
  );
} finally {
  await c.close();
  await z.close();
}
