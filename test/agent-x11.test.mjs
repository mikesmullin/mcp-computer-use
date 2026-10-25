import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentX11 } from '../lib/agent-x11.mjs';
import { createOverlay } from '../lib/cursor-overlay.mjs';
import { createCursorProcess } from '../lib/cursor-process.mjs';

test('invalid coordinates never activate or inject', async () => {
 const calls=[];
 const x=createAgentX11({base:{activate:async()=>calls.push('focus')},overlay:{stop:async()=>{}},run:async()=>{throw new Error('unexpected');}});
 for(const point of [{x:-1,y:0},{x:1.5,y:0},{x:1,y:0,button:4}]) await assert.rejects(x.click(123,point));
 assert.deepEqual(calls,[]);
});
test('overlay failure still delivers independent input; no pointer-moving fallback',async()=>{
 const calls=[];
 const x=createAgentX11({binary:'helper',base:{activate:async()=>calls.push('focus'),click:()=>{throw new Error('unsafe fallback');}},
 overlay:{move:async(x,y)=>{calls.push([x,y]);return false;},stop:async()=>{}},
 run:async(cmd,args)=>{calls.push(args[0]);return {ok:true,stdout:args[0]==='geometry'?'100 200 800 600':'injected'};}});
 assert.equal((await x.click(123,{x:5,y:7})).clicked,true);
 assert.deepEqual(calls,['focus','geometry',[105,207],'geometry','click']);
});
test('input helper errors propagate instead of reporting success',async()=>{
 const x=createAgentX11({base:{activate:async()=>{}},overlay:{move:async()=>true},run:async(cmd,args)=>args[0]==='geometry'?{ok:true,stdout:'0 0 800 600'}:{ok:false,out:'occluded'}});
 await assert.rejects(x.click(123,{x:1,y:2}),/occluded/);
});
test('missing overlay fails open and disabled overlay never starts',async()=>{
 const missing=createCursorProcess({binary:'/nonexistent/cua-overlay',timeoutMs:100});
 assert.equal(await missing.show(1,2),false);await missing.stop();
 const off=createOverlay({enabled:false});assert.equal(await off.show(1,2),false);assert.equal(off.pid(),undefined);await off.stop();
});

test('double clicks and wheel ticks use one independent helper invocation, with late validation',async()=>{
 const calls=[];
 const x=createAgentX11({binary:'helper',base:{activate:async()=>{}},overlay:{move:async()=>{},stop:async()=>{}},run:async(cmd,args)=>{calls.push(args);return {ok:true,stdout:args[0]==='geometry'?'0 0 800 600':'injected'};}});
 await x.click(123,{x:5,y:7,count:2,validateTarget:async()=>calls.push(['validated'])});
 assert.deepEqual(calls.slice(-2),[['validated'],['click','123','5','7','1','2']]);
 await x.scroll(123,{x:5,y:7,direction:'down',amount:'page'});
 assert.deepEqual(calls.at(-1),['wheel','123','5','7','5','10']);
 const count=calls.length;
 await assert.rejects(x.click(123,{x:5,y:7,count:3}));
 assert.equal(calls.length,count);
 await assert.rejects(x.click(123,{x:5,y:7,validateTarget:async()=>{throw Error('moved');}}),/moved/);
 assert.notEqual(calls.at(-1)[0],'click');
});
