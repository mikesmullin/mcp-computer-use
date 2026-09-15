import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCmd } from './spawn.mjs';

export function createX11(run = runCmd) {
  const activate = async (windowId) => {
    const res = await run('xdotool', ['windowactivate', '--sync', String(windowId)]);
    if (!res.ok) throw new Error(`Could not focus window ${windowId}: ${res.out}`);
  };

  const click = async (windowId, { x, y, button = 1 }) => {
    if (![1, 2, 3].includes(Number(button))) throw new Error('button must be 1 (left), 2 (middle), or 3 (right)');
    const rx = Number(x), ry = Number(y);
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx < 0 || ry < 0) throw new Error('click x,y must be >= 0, relative to the window');
    await activate(windowId);
    const res = await run('xdotool', ['mousemove', '--window', String(windowId), String(Math.round(rx)), String(Math.round(ry)), 'click', String(button)]);
    if (!res.ok) throw new Error(`click failed: ${res.out}`);
    return { clicked: true, windowId: Number(windowId), x: Math.round(rx), y: Math.round(ry), button: Number(button) };
  };

  const typeText = async (windowId, text, { delayMs = 12 } = {}) => {
    const str = String(text ?? '');
    if (!str) throw new Error('text is required');
    if (str.length > 4000) throw new Error('text longer than 4000 characters');
    await activate(windowId);
    const delay = Math.min(100, Math.max(0, Number(delayMs) || 0));
    // xdotool type uses XTEST (same path whisper forces for GTK4). -- clears options.
    const res = await run('xdotool', ['type', '--window', String(windowId), '--clearmodifiers', '--delay', String(delay), '--', str]);
    if (!res.ok) throw new Error(`type failed: ${res.out}`);
    return { typed: true, windowId: Number(windowId), chars: str.length };
  };

  const screenshot = async (win, { format = 'png' } = {}) => {
    const windowId = Number(win.windowId ?? win);
    if (!Number.isInteger(windowId) || windowId <= 0) throw new Error('windowId required for screenshot');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-computer-use-'));
    const file = path.join(dir, `window.${format === 'jpeg' ? 'jpg' : 'png'}`);
    try {
      const res = await run('scrot', ['-w', String(windowId), '-o', '-F', file]);
      if (!res.ok) throw new Error(`screenshot failed: ${res.out}`);
      const bytes = await readFile(file);
      if (bytes.length > 10 * 1024 * 1024) throw new Error('screenshot larger than 10MB');
      return { bytes, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  return { activate, click, typeText, screenshot };
}
