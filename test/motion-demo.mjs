// Draw-only demonstration. Does not focus, click, or move the human pointer.
import { createOverlay } from '../lib/cursor-overlay.mjs';
import { runCmd } from '../lib/spawn.mjs';
import { binaryPath } from '../lib/cursor-overlay.mjs';
if(process.env.CUA_OVERLAY_X!=='1')throw new Error('Set CUA_OVERLAY_X=1');
const r=await runCmd(binaryPath,['geometry',process.argv[2]]);
if(!r.ok)throw new Error(r.out);
const [x,y]=r.stdout.trim().split(/\s+/).map(Number);
const overlay=createOverlay();
try {
 for(const [dx,dy] of [[450,365],[1100,600],[650,700],[1200,300],[450,365]]){
  await overlay.move(x+dx,y+dy);await new Promise(r=>setTimeout(r,500));
 }
 console.log('Resting visibly for 7 seconds');
 await new Promise(r=>setTimeout(r,7000));
}finally{await overlay.stop();}
