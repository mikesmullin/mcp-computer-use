import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { runCmd } from '../lib/spawn.mjs';
if(process.env.CUA_OVERLAY_X!=='1')throw new Error('Set CUA_OVERLAY_X=1');
const id=Number(process.argv[2]);
const p=spawn('bun',['server.coffee'],{stdio:['pipe','pipe','inherit']});
let seq=0;const requests=new Map();
createInterface({input:p.stdout}).on('line',line=>{const msg=JSON.parse(line);requests.get(msg.id)?.(msg.result);requests.delete(msg.id);});
const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error(`timeout ${method}`)),8000);requests.set(id,r=>{clearTimeout(timer);resolve(r);});p.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
const call=async(name,args={})=>{const r=await rpc('tools/call',{name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r;};
try {
 assert.equal((await rpc('initialize',{protocolVersion:'2024-11-05'})).serverInfo.name,'computer-use');
 const names=(await rpc('tools/list')).tools.map(t=>t.name);
 assert.equal(names.length,9);assert.ok(!names.includes('window_move'));assert.ok(!names.includes('window_resize'));assert.ok(names.includes('window_interact'));assert.ok(names.includes('window_key'));
 const info=await call('window_info',{windowId:id});assert.match(info.content[0].text,/Agent cursor test:/);
 const before=(await call('cursor_position')).content[0].text.match(/cursor x=\d+ y=\d+/)[0];
 const geometry=await runCmd(new URL('../overlay/target/release/cua-overlay',import.meta.url).pathname,['geometry',String(id)]);
 assert.ok(geometry.ok,geometry.out);
 const [,,nativeWidth,nativeHeight]=geometry.stdout.trim().split(/\s+/).map(Number);
 const initial=await call('window_screenshot',{windowId:id});
 const meta=initial.structuredContent;
 const x=Math.round(700*meta.width/nativeWidth),y=Math.round(365*meta.height/nativeHeight);
 const result=await call('window_interact',{screenshotId:meta.screenshotId,x,y,text:'agent-input-ok',replace:true,delayMs:12});
 assert.equal(result.structuredContent.status,'input_sent');
 assert.ok(Math.abs(result.structuredContent.agentCursor.x-x)<=1);
 assert.ok(Math.abs(result.structuredContent.agentCursor.y-y)<=1);
 const stale=await rpc('tools/call',{name:'window_click',arguments:{screenshotId:meta.screenshotId,x,y}});
 assert.equal(stale.isError,true);assert.match(stale.content[0].text,/Stale/);
 let typed=false;
 for(let i=0;i<20;i++){if((await call('window_info',{windowId:id})).content[0].text.includes('input=agent-input-ok')){typed=true;break;}await new Promise(r=>setTimeout(r,100));}
 assert.ok(typed,'Zen did not confirm the complete typed text');
 const after=(await call('cursor_position')).content[0].text.match(/cursor x=\d+ y=\d+/)[0];assert.equal(after,before);
 const shot=await call('window_screenshot',{windowId:id});
 assert.ok(shot.structuredContent.screenshotId);
 await writeFile('/tmp/agent-mcp-screenshot.png',Buffer.from(shot.content[1].data,'base64'));
 console.log('PASS stdio initialize, tools, click, type, pointer preservation, screenshot');
 console.log(JSON.stringify(shot.structuredContent));
} finally {
 p.stdin.end();
 const timer=setTimeout(()=>p.kill('SIGKILL'),3000);
 await new Promise(r=>p.once('exit',r));clearTimeout(timer);
}
