import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createX11 } from './x11.mjs';
import { runCmd } from './spawn.mjs';
import { createOverlay, binaryPath } from './cursor-overlay.mjs';
import { sameGeometry } from './screenshot-views.mjs';
import { normalizeKey } from './keys.mjs';

export function createAgentX11({ run = runCmd, base = createX11(run), overlay = createOverlay(), binary = binaryPath } = {}) {
  let queue = Promise.resolve();
  const serial = fn => (...args) => {
    const result = queue.then(() => fn(...args)); queue = result.catch(() => {}); return result;
  };
  const native = async args => {
    const result = await run(binary, args);
    if (!result.ok) throw new Error(`Agent input helper failed: ${result.out}. Build overlay with cargo build --release --manifest-path overlay/Cargo.toml.`);
    return result.stdout.trim();
  };
  const geometry = async (id, capture = false) => {
    const numbers = (await native([capture ? 'capture-geometry' : 'geometry', String(id)])).split(/\s+/).map(Number);
    if (numbers.length !== 4 || !numbers.every(Number.isInteger)) throw new Error('Invalid X11 geometry');
    const [x,y,width,height] = numbers;
    return { x,y,width,height };
  };
  const click = serial(async (id, { x, y, button = 1, expectedGeometry }) => {
    if (!Number.isInteger(id) || id <= 0) throw new Error('windowId must be a positive integer');
    if (![x,y].every(n => Number.isInteger(n) && n >= 0 && n <= 32767) || ![1,2,3].includes(button)) throw new Error('Invalid click coordinates or button');
    await base.activate(id);
    const g = await geometry(id);
    if (expectedGeometry && !sameGeometry(expectedGeometry,g)) throw new Error('Window geometry changed; capture again. No click sent.');
    if (x >= g.width || y >= g.height) throw new Error('Click outside target window');
    await overlay.move(g.x+x,g.y+y);
    if (!sameGeometry(g,await geometry(id))) throw new Error('Window moved during cursor travel; capture again. No click sent.');
    // There is deliberately no fallback to the existing pointer-moving click.
    const delivery = await native(['click',String(id),String(x),String(y),String(button)]);
    return { clicked:true, windowId:id, x,y,button,delivery };
  });
  const check = async (id, expected) => {
    await base.activate(id);
    if (expected && !sameGeometry(expected,await geometry(id))) throw new Error('Window geometry changed; capture again. No input sent.');
  };
  const typeText = serial(async (id, text, options = {}) => {
    if (typeof text !== 'string' || !text.length || text.length > 4000) throw new Error('text must contain 1–4000 characters');
    await check(id, options.expectedGeometry);
    // Keep the hotspot at its last target. Amber fill signals typing, not a new position.
    await overlay.typing?.(true);
    try { return await base.typeText(id,text,options); }
    finally { await overlay.typing?.(false); }
  });
  const key = serial(async (id, keys, {expectedGeometry} = {}) => {
    const chord=normalizeKey(keys);
    await check(id,expectedGeometry);
    const result=await run('xdotool',['key','--window',String(id),'--clearmodifiers',chord]);
    if(!result.ok)throw new Error(`Keyboard shortcut failed: ${result.out}`);
    return {keys:chord};
  });
  const screenshot = serial(async win => {
    const id = Number(win.windowId ?? win);
    const g = await geometry(id, true);
    // Root framebuffer crop includes the real overlay, including after its idle fade.
    await overlay.refresh();
    // XSync confirms server processing, not a compositor repaint. Allow a frame
    // to reach the root capture, including the overlay's first appearance.
    await new Promise(resolve => setTimeout(resolve, 100));
    const dir = await mkdtemp(path.join(os.tmpdir(),'agent-screen-'));
    try {
      const file = path.join(dir,'window.png');
      const result = await run('scrot',['-a',`${g.x},${g.y},${g.width},${g.height}`,'-z','-o','-F',file]);
      if (!result.ok) throw new Error(`Screenshot failed: ${result.out}`);
      if (!sameGeometry(g,await geometry(id, true))) throw new Error('Window moved during capture. Capture again.');
      const bytes = await readFile(file);
      if (bytes.length > 10*1024*1024) throw new Error('Screenshot larger than 10MB');
      return { bytes,mimeType:'image/png',geometry:g,agentCursor:overlay.position() };
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  return { ...base,geometry,click,typeText,key,screenshot,stop:async()=>{await queue;await overlay.stop();} };
}
