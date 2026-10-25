import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCursorService } from "../lib/cursor-service.mjs";
import { cursorRequest, createOverlay } from "../lib/cursor-overlay.mjs";
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cursor-test-")),
    socketPath = path.join(dir, "cursor.sock"),
    calls = [];
  let position;
  const overlay = {
    move: async (x, y) => {
      calls.push(["move", x, y]);
      position = { x, y };
      return true;
    },
    show: async (x, y) => {
      position = { x, y };
      return true;
    },
    typing: async (active) => {
      calls.push(["typing", active]);
      return true;
    },
    refresh: async () => true,
    position: () => position,
    stop: async () => calls.push(["stop"]),
  };
  const server = await startCursorService({ socketPath, overlay });
  t.after(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });
  const send = (event, extra = {}) =>
    cursorRequest(
      {
        version: 1,
        requestId: Math.random().toString(),
        event,
        expiresAt: Date.now() + 1800,
        ...extra,
      },
      { socketPath },
    );
  return { send, calls, socketPath, overlay };
}
test("one private listener serves multiple clients and client stop does not kill shared cursor", async (t) => {
  const { socketPath, calls, send } = await fixture(t);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  const a = createOverlay({ socketPath }),
    b = createOverlay({ socketPath });
  assert.equal(await a.move(100, 200), true);
  await a.stop();
  assert.equal(await b.move(300, 400), true);
  assert.deepEqual((await send("status")).position, { x: 300, y: 400 });
  assert.equal(calls.filter((c) => c[0] === "move").length, 2);
  assert.ok(!calls.some((c) => c[0] === "stop"));
  await assert.rejects(startCursorService({ socketPath }), /already running/);
});
test("expired, malformed and duplicate events cannot animate extra movements", async (t) => {
  const { send, calls } = await fixture(t);
  assert.equal(
    (await send("before_click", { expiresAt: Date.now() - 1 })).status,
    "expired",
  );
  assert.equal(
    (
      await send("before_click", {
        position: { space: "css-pixels", x: 1, y: 2 },
      })
    ).status,
    "invalid_position",
  );
  const extra = {
    requestId: "same",
    position: { space: "screen-device-pixels", x: 40, y: 50 },
  };
  assert.equal((await send("before_click", extra)).ok, true);
  assert.equal((await send("before_click", extra)).ok, true);
  assert.equal(calls.filter((c) => c[0] === "move").length, 1);
  assert.equal((await send("execute_click", extra)).status, "invalid_request");
});
test("typing moves first and supports ending its amber highlight", async (t) => {
  const { send, calls } = await fixture(t);
  await send("before_type", {
    position: { space: "screen-device-pixels", x: 10, y: 20 },
  });
  await send("typing_end");
  assert.deepEqual(calls, [
    ["typing", false],
    ["move", 10, 20],
    ["typing", true],
    ["typing", false],
  ]);
});
test("unavailable and disabled clients fail open without spawning private overlays", async () => {
  const a = createOverlay({ socketPath: "/nonexistent/agent-cursor.sock" });
  assert.equal(await a.move(1, 2), false);
  const b = createOverlay({ enabled: false });
  assert.equal(await b.move(1, 2), false);
  assert.equal(b.pid(), undefined);
  await a.stop();
  await b.stop();
});
