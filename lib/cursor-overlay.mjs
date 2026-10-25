import net from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
export const binaryPath =
  process.env.CUA_CURSOR_BINARY ||
  fileURLToPath(
    new URL("../overlay/target/release/cua-overlay", import.meta.url),
  );
export const cursorSocketPath = () =>
  process.env.AGENT_CURSOR_SOCKET ||
  `${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`}/agent-cursor.sock`;
export function cursorRequest(
  message,
  { socketPath = cursorSocketPath(), timeoutMs = 1800 } = {},
) {
  return new Promise((resolve) => {
    let done = false,
      buffer = "";
    const socket = net.createConnection(socketPath);
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish({ ok: false, status: "timeout" }),
      timeoutMs,
    );
    socket.on("error", () => finish({ ok: false, status: "unavailable" }));
    socket.on("close", () => finish({ ok: false, status: "disconnected" }));
    socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
    socket.on("data", (bytes) => {
      buffer += bytes;
      if (buffer.length > 8192)
        return finish({ ok: false, status: "invalid_reply" });
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        const r = JSON.parse(buffer.slice(0, end));
        finish(
          r.requestId === message.requestId
            ? r
            : { ok: false, status: "invalid_reply" },
        );
      } catch {
        finish({ ok: false, status: "invalid_reply" });
      }
    });
  });
}
// Every MCP process uses the same optional drawing service. Never owns/kills it.
export function createOverlay({
  enabled = process.env.CUA_CURSOR !== "off",
  socketPath = cursorSocketPath(),
  timeoutMs = 1800,
} = {}) {
  let last,
    stopped = false;
  async function send(event, position) {
    if (!enabled || stopped) return false;
    const r = await cursorRequest(
      {
        version: 1,
        requestId: randomUUID(),
        event,
        expiresAt: Date.now() + timeoutMs,
        ...(position
          ? { position: { space: "screen-device-pixels", ...position } }
          : {}),
      },
      { socketPath, timeoutMs },
    );
    if (r.position) last = { x: r.position.x, y: r.position.y };
    return r.ok === true;
  }
  const point = (event, x, y) =>
    Number.isInteger(x) && Number.isInteger(y)
      ? send(event, { x, y })
      : Promise.resolve(false);
  return {
    show: (x, y) => point("show", x, y),
    move: (x, y) => point("move", x, y),
    typing: (active) => send(active ? "typing_start" : "typing_end"),
    refresh: () => send("refresh"),
    stop: async () => {
      stopped = true;
    },
    position: () => last,
    pid: () => undefined,
  };
}
