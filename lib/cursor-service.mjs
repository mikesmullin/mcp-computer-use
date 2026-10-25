import net from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createCursorProcess } from "./cursor-process.mjs";
import { cursorSocketPath } from "./cursor-overlay.mjs";
const moves = new Set([
  "move",
  "show",
  "before_click",
  "before_type",
  "before_select",
  "before_hover",
  "before_scroll",
]);
const events = new Set([
  ...moves,
  "typing_start",
  "typing_end",
  "refresh",
  "status",
]);
export async function startCursorService({
  socketPath = cursorSocketPath(),
  overlay = createCursorProcess(),
  now = Date.now,
} = {}) {
  let queue = Promise.resolve(),
    pending = 0,
    closing = false,
    typingTimer,
    lastEvent;
  const sockets = new Set(),
    seen = new Map();
  const typing = async (active) => {
    clearTimeout(typingTimer);
    await overlay.typing(active);
    if (active) {
      typingTimer = setTimeout(() => overlay.typing(false), 5000);
      typingTimer.unref();
    }
  };
  function validate(m) {
    if (
      !m ||
      m.version !== 1 ||
      typeof m.requestId !== "string" ||
      m.requestId.length < 1 ||
      m.requestId.length > 100 ||
      !events.has(m.event)
    )
      throw Error("invalid_request");
    if (
      !Number.isFinite(m.expiresAt) ||
      m.expiresAt <= now() ||
      m.expiresAt > now() + 10000
    )
      throw Error("expired");
    if (
      moves.has(m.event) &&
      (!m.position ||
        m.position.space !== "screen-device-pixels" ||
        ![m.position.x, m.position.y].every(
          (n) => Number.isInteger(n) && n >= -32768 && n <= 32767,
        ))
    )
      throw Error("invalid_position");
  }
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(2500, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "",
      received = false;
    socket.on("data", (bytes) => {
      if (received) return;
      buffer += bytes;
      if (buffer.length > 4096) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      received = true;
      let m;
      try {
        m = JSON.parse(buffer.slice(0, end));
        validate(m);
      } catch (e) {
        socket.end(
          JSON.stringify({
            version: 1,
            requestId: m?.requestId,
            ok: false,
            status: e.message,
          }) + "\n",
        );
        return;
      }
      const reply = (r) => {
        if (!socket.destroyed)
          socket.end(
            JSON.stringify({ version: 1, requestId: m.requestId, ...r }) + "\n",
          );
      };
      if (pending >= 8 || closing) {
        reply({ ok: false, status: "busy" });
        return;
      }
      pending++;
      const work = queue.then(async () => {
        if (socket.destroyed || m.expiresAt <= now())
          return { ok: false, status: "expired" };
        if (seen.has(m.requestId)) return seen.get(m.requestId);
        if (moves.has(m.event) && m.expiresAt - now() < 900)
          return { ok: false, status: "expired" };
        let ok = true;
        if (moves.has(m.event)) {
          await typing(false);
          ok = await overlay[m.event === "show" ? "show" : "move"](
            m.position.x,
            m.position.y,
          );
          if (ok && m.event === "before_type") await typing(true);
        } else if (m.event === "typing_start" || m.event === "typing_end")
          await typing(m.event === "typing_start");
        else if (m.event === "refresh") ok = await overlay.refresh();
        if (m.event !== "status" && ok !== false)
          lastEvent = { event: m.event, requestId: m.requestId, at: now() };
        const result = {
          ok: ok !== false,
          status: ok === false ? "unavailable" : "done",
          position: overlay.position() || null,
          lastEvent,
          overlayPid: overlay.pid?.(),
        };
        seen.set(m.requestId, result);
        while (seen.size > 256) seen.delete(seen.keys().next().value);
        return result;
      });
      queue = work.catch(() => {});
      work
        .then(reply, () => reply({ ok: false, status: "unavailable" }))
        .finally(() => pending--);
    });
  });
  // Only reclaim an owned stale socket. Never unlink a listening peer's socket.
  try {
    const s = await lstat(socketPath);
    if (!s.isSocket() || s.uid !== process.getuid())
      throw Error("Socket path is not an owned Unix socket");
    const live = await new Promise((resolve) => {
      const c = net.createConnection(socketPath);
      c.once("connect", () => {
        c.destroy();
        resolve(true);
      });
      c.once("error", (e) =>
        resolve(!["ECONNREFUSED", "ENOENT"].includes(e.code)),
      );
    });
    if (live) throw Error("Cursor service already running");
    const check = await lstat(socketPath);
    if (check.ino !== s.ino) throw Error("Socket changed during startup");
    await unlink(socketPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return {
    socketPath,
    async stop() {
      closing = true;
      clearTimeout(typingTimer);
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
      await queue;
      clearTimeout(typingTimer);
      await overlay.stop();
    },
  };
}
