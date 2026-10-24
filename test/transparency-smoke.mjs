import { createOverlay } from '../lib/cursor-overlay.mjs';
import { runCmd } from '../lib/spawn.mjs';
import assert from 'node:assert/strict';
if(process.env.CUA_OVERLAY_X!=='1')throw new Error('Set CUA_OVERLAY_X=1');
const shot=async name=>{const r=await runCmd('scrot',['-a','2690,1480,80,80','-z','-o','-F',`/tmp/cursor-${name}.png`]);assert.ok(r.ok,r.out);};
await shot('background');
const o=createOverlay();
try{assert.ok(await o.show(2710,1500));await new Promise(r=>setTimeout(r,500));await shot('transparent');}
finally{await o.stop();}
