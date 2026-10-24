import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
export const binaryPath = process.env.CUA_CURSOR_BINARY || fileURLToPath(new URL('../overlay/target/release/cua-overlay', import.meta.url));

// Serial command/reply protocol; stdout never reaches MCP stdout.
export function createOverlay({ binary = binaryPath, enabled = process.env.CUA_CURSOR !== 'off', timeoutMs = 2000 } = {}) {
  let child, pending, ready, chain = Promise.resolve(), last, stopped = false, firstPaint = false;
  const warn = message => process.stderr.write(`cursor overlay: ${message}\n`);
  const fail = error => { if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.reject(error); } };
  const expect = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { fail(new Error('response timeout')); child?.kill('SIGTERM'); }, timeoutMs);
    pending = { resolve, reject, timer };
  });
  const start = async () => {
    if (child) return ready;
    const proc = spawn(binary, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    firstPaint = true;
    ready = expect();
    createInterface({ input: proc.stdout }).on('line', line => {
      if (child !== proc || !pending) return;
      const p = pending; pending = null; clearTimeout(p.timer);
      if (line === 'ok' || line.startsWith('ready ')) p.resolve(line);
      else p.reject(new Error(line));
    });
    proc.stderr.on('data', data => warn(data.toString().slice(0, 2048).trim()));
    proc.stdin.on('error', error => { if (child === proc) fail(error); });
    proc.on('error', error => { if (child === proc) { fail(error); child = undefined; } });
    proc.on('exit', (code, signal) => {
      if (child === proc) { fail(new Error(`exited (${code ?? signal})`)); child = undefined; }
    });
    return ready;
  };
  const send = line => {
    const work = async () => {
      if (!enabled || stopped) return false;
      try {
        await start();
        const response = expect();
        child.stdin.write(`${line}\n`);
        await response;
        return true;
      } catch (error) { warn(error.message); return false; }
    };
    const result = chain.then(work); chain = result.catch(() => {}); return result;
  };
  const point = async (op, x, y) => {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    const ok = await send(`${op} ${x} ${y}`);
    if (ok) {
      last = { x, y };
      // A compositor may animate initial mapping after the X server has drawn.
      // Only the first placement needs this settling period.
      if (firstPaint) { firstPaint = false; await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    return ok;
  };
  const stop = async () => {
    stopped = true;
    await chain;
    const proc = child;
    if (!proc) return;
    const exited = new Promise(resolve => proc.once('exit', resolve));
    proc.stdin.end('quit\n');
    const term = setTimeout(() => proc.kill('SIGTERM'), 1000);
    const kill = setTimeout(() => proc.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(term); clearTimeout(kill);
  };
  return { show: (x,y) => point('show',x,y), move: (x,y) => point('move',x,y),
    typing: active => last ? send(`typing ${active ? 1 : 0}`) : Promise.resolve(false),
    refresh: () => last ? point('show',last.x,last.y) : Promise.resolve(false), stop,
    position: () => last, pid: () => child?.pid };
}
