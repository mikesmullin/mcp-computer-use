// Explicitly opt in: CUA_OVERLAY_X=1 bun test/desktop-smoke.mjs WINDOW_ID.
// Requires the supplied local cursor-page.html to be the active Zen tab.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createAgentX11 } from '../lib/agent-x11.mjs';
import { createOverlay } from '../lib/cursor-overlay.mjs';
import { runCmd } from '../lib/spawn.mjs';
if (process.env.CUA_OVERLAY_X !== '1') throw new Error('Set CUA_OVERLAY_X=1 for desktop experiments');
const id=Number(process.argv[2]);
const command = async (cmd,args) => { const r=await runCmd(cmd,args);assert.ok(r.ok,r.out);return r.stdout.trim(); };
const title=await command('xdotool',['getwindowname',id]);
assert.match(title,/Agent cursor test: \d+ clicks/,'Open cursor-page.html in the selected window first');
const oldCount=Number(/test: (\d+)/.exec(title)[1]);
const overlay=createOverlay();
const x=createAgentX11({overlay});
const pointer=async()=> (await command('xdotool',['getmouselocation','--shell'])).split('\n').filter(s=>/^X=|^Y=/.test(s)).join(' ');
try {
 const before=await pointer();
 const result=await x.click(id,{x:450,y:365});
 console.log(result.delivery);
 await new Promise(r=>setTimeout(r,200));
 assert.match(await command('xdotool',['getwindowname',id]),new RegExp(`test: ${oldCount+1} clicks`));
 assert.equal(await pointer(),before,'Human pointer changed during click');
 const shot=await x.screenshot({windowId:id});
 await writeFile('/tmp/agent-cursor-visible.png',shot.bytes);
 console.log('capture',shot.geometry,shot.agentCursor);
 const clients=await command('awesome-client',['return #client.get()']);
 console.log('awesome clients',clients);
 const devices=await command(new URL('../overlay/target/release/cua-overlay',import.meta.url).pathname,['devices']);
 assert.ok(!devices.includes('cua-agent-'),'Virtual pointer leaked after click');
 console.log('PASS Zen click, pointer preservation, device cleanup; screenshot saved');
} finally {await x.stop();}
