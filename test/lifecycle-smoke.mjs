import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createCursorProcess as createOverlay, binaryPath } from '../lib/cursor-process.mjs';
import { createAwesome } from '../lib/awesome.mjs';
import { runCmd } from '../lib/spawn.mjs';
if(process.env.CUA_OVERLAY_X!=='1')throw new Error('Set CUA_OVERLAY_X=1');
const id=Number(process.argv[2]);
const cmd=async(c,a)=>{const r=await runCmd(c,a);assert.ok(r.ok,r.out);return r.stdout.trim();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const o=createOverlay();
try {
 const before=await cmd('xdotool',['getactivewindow','getmouselocation','--shell']);
 for(const s of await createAwesome().screens()) {
   const x=s.x+Math.floor(s.width/2),y=s.y+Math.floor(s.height/2);
   assert.equal(await o.move(x,y),true);
   await sleep(100);
   await cmd('scrot',['-a',`${x-3},${y-3},36,36`,'-z','-o','-F',`/tmp/agent-screen-${s.index}.png`]);
 }
 assert.equal(await cmd('xdotool',['getactivewindow','getmouselocation','--shell']),before,'Overlay changed focus or pointer');
 assert.ok(!(await createAwesome().list()).some(w=>w.class==='_CUA_OVERLAY'));
 const old=o.pid();process.kill(old,'SIGKILL');await sleep(100);
 assert.equal(await o.show(100,100),true);assert.notEqual(o.pid(),old);
 console.log('PASS multi-monitor overlay, focus/pointer preservation, WM exclusion, respawn');
} finally {await o.stop();}
// Abort a click during its private-pointer lifetime; watcher must remove it.
const title=await cmd('xdotool',['getwindowname',id]);assert.match(title,/Agent cursor test:/);
const proc=spawn(binaryPath,['click',String(id),'450','365','1'],{stdio:['ignore','pipe','pipe']});
const exited=new Promise(r=>proc.once('exit',r));
let observed=false;
for(let i=0;i<25;i++) {
 const d=await cmd(binaryPath,['devices']);
 if(d.includes(`cua-agent-${proc.pid} pointer`)){observed=true;proc.kill('SIGKILL');break;}
 await sleep(2);
}
await exited;assert.ok(observed,'Could not observe private pointer before click finished');
await sleep(400);
assert.ok(!(await cmd(binaryPath,['devices'])).includes(`cua-agent-${proc.pid} pointer`),'Crash leaked master');
console.log('PASS SIGKILL click-helper cleanup via independent watcher');
