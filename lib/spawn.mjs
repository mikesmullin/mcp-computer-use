import { spawn as _spawn } from 'node:child_process';

export function spawn(cmd, args = [], { timeoutMs = 8000, env } = {}) {
  const result = { cmd: [cmd, ...args].join(' '), code: null, stdout: '', stderr: '' };
  const proc = _spawn(cmd, args.map(String), { stdio: 'pipe', env: env ? { ...process.env, ...env } : process.env });
  result.proc = proc;
  proc.stdout.on('data', (d) => { result.stdout += d; });
  proc.stderr.on('data', (d) => { result.stderr += d; });
  result.promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      result.code = -1;
      result.stderr += ' (timeout)';
      resolve(result);
    }, timeoutMs);
    proc.on('close', (code) => { clearTimeout(timer); result.code = code; resolve(result); });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
  return result;
}

export async function runCmd(cmd, args, opts) {
  try {
    const child = spawn(cmd, args, opts);
    await child.promise;
    return { ok: child.code === 0, out: (child.stdout + child.stderr).trim(), stdout: child.stdout, stderr: child.stderr, code: child.code };
  } catch (e) {
    return { ok: false, out: `${cmd}: ${e.message}` };
  }
}
