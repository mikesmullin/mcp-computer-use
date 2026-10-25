// Serve test/ on localhost:18992 before running this opt-in headed fixture.
if (process.env.CUA_OVERLAY_X !== "1")
  throw Error(
    "Set CUA_OVERLAY_X=1; this opens and interacts with a local test tab",
  );
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cursorRequest, createOverlay } from "../lib/cursor-overlay.mjs";
import { createX11 } from "../lib/x11.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
const c = new Client({ name: "cursor-integration-test", version: "1" });
await c.connect(
  new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8791/mcp")),
);
const call = async (name, args = {}) => {
  const r = await c.callTool({ name: "zen_browser_" + name, arguments: args });
  if (r.isError) throw Error(r.content[0].text);
  return r.structuredContent.response.data;
};
const status = () =>
  cursorRequest({
    version: 1,
    requestId: randomUUID(),
    event: "status",
    expiresAt: Date.now() + 1800,
  });
let fixture;
try {
  fixture = await call("tab_new", {
    url: "http://127.0.0.1:18992/cursor-notifications.html",
  });
  const snapshot = await call("snapshot", { interactive: true });
  const ref = (name) => {
    const entry = Object.entries(snapshot.refs).find(
      ([, v]) => v.name === name,
    );
    assert.ok(entry, name);
    return entry[0];
  };
  const left = ref("Cursor left button"),
    text = ref("Cursor fixture text"),
    choice = ref("Cursor fixture choice");
  const before = await createX11().cursorPosition();
  await call("click", { selector: left });
  let state = await status();
  assert.equal(state.ok, true);
  assert.equal(state.lastEvent.event, "before_click");
  const pid = state.overlayPid;
  assert.ok(pid);
  let events = (await call("eval", { script: "window.events" })).result;
  assert.equal(events.length, 1);
  assert.ok(events[0].at >= state.lastEvent.at);
  const first = { ...state.position };
  await call("find", {
    locator: "text",
    value: "Cursor right button",
    action: "click",
  });
  state = await status();
  assert.equal(state.lastEvent.event, "before_click");
  assert.notDeepEqual(state.position, first);
  assert.equal(state.overlayPid, pid);
  events = (await call("eval", { script: "window.events" })).result;
  assert.deepEqual(
    events.map((e) => e.action),
    ["left", "right"],
  );
  assert.ok(events[1].at >= state.lastEvent.at);
  await call("fill", { selector: text, text: "shared cursor verified" });
  assert.equal(
    (await call("get_value", { selector: text })).value,
    "shared cursor verified",
  );
  state = await status();
  assert.equal(state.lastEvent.event, "typing_end");
  await call("select", { selector: choice, values: ["two"] });
  state = await status();
  assert.equal(state.lastEvent.event, "before_select");
  assert.equal((await call("get_value", { selector: choice })).value, "two");
  const a = createOverlay(),
    b = createOverlay();
  await a.move(first.x, first.y);
  await a.stop();
  await b.move(state.position.x, state.position.y);
  await b.stop();
  assert.equal((await status()).overlayPid, pid);
  const after = await createX11().cursorPosition();
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "direct DOM click",
        "find click",
        "typing",
        "dropdown",
        "animation completed before clicks",
        "one shared overlay PID",
        "client disconnect preserves cursor",
        "human pointer unchanged",
      ],
      overlayPid: pid,
      finalPosition: state.position,
    }),
  );
} finally {
  if (fixture) {
    const tabs = await call("tab_list");
    if (tabs.tabs.find((t) => t.current)?.targetId === fixture.targetId)
      await call("tab_close", { tab: fixture.targetId });
  }
  await c.close();
}
