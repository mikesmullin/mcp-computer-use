import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createInteraction} from '../lib/interaction.mjs';
const geometry={x:100,y:200,width:2000,height:1000};
function setup(){
 const calls=[];let g=geometry;
 const x11={geometry:async()=>g,screenshot:async()=>({geometry:g,bytes:Buffer.alloc(0),agentCursor:{x:1100,y:700}}),click:async(id,p)=>calls.push(['click',p.x,p.y]),key:async(id,key)=>calls.push(['key',key]),typeText:async(id,text)=>calls.push(['text',text])};
 const awesome={one:async()=>({windowId:7,title:'test'})};
 const render=async(shot,crop,maxWidth)=>({width:Math.min(crop.width,maxWidth),height:Math.round(crop.height*Math.min(crop.width,maxWidth)/crop.width),bytes:Buffer.from('test')});
 return {ui:createInteraction({x11,awesome,render,wait:async()=>{}}),calls,x11,move:()=>g={...g,x:g.x+1}};
}
test('compound action maps click, orders input, and returns a fresh screenshot',async()=>{
 const {ui,calls}=setup();const first=await ui.screenshot({windowId:7,maxWidth:1000});
 assert.deepEqual(first.structuredContent.agentCursor,{x:500,y:250});
 const result=await ui.action('interact',{screenshotId:first.structuredContent.screenshotId,x:250,y:100,text:'hello',replace:true,keys:'Enter'});
 assert.deepEqual(calls,[['click',500,200],['key','Ctrl+a'],['text','hello'],['key','Enter']]);
 assert.equal(result.structuredContent.status,'input_sent');assert.equal(result.structuredContent.applicationOutcome,'not verified');
 assert.notEqual(result.structuredContent.screenshotId,first.structuredContent.screenshotId);
 await assert.rejects(ui.action('click',{screenshotId:first.structuredContent.screenshotId,x:1,y:1}),/Stale/);
});
test('invalid compound key and changed geometry cause no input',async()=>{
 const {ui,calls,move}=setup();const s=(await ui.screenshot({windowId:7})).structuredContent.screenshotId;
 await assert.rejects(ui.action('interact',{screenshotId:s,x:1,y:1,text:'hello',keys:'INVALID'}));assert.deepEqual(calls,[]);
 move();await assert.rejects(ui.action('click',{screenshotId:s,x:1,y:1}),/geometry/);assert.deepEqual(calls,[]);
});
test('failed observation reports already-sent input without encouraging replay',async()=>{
 const {ui,x11}=setup();const s=(await ui.screenshot({windowId:7})).structuredContent.screenshotId;
 x11.screenshot=async()=>{throw new Error('capture failed');};
 const r=await ui.action('click',{screenshotId:s,x:1,y:1});assert.equal(r.isError,true);assert.match(r.content[0].text,/Input was sent/);
});
test('crop returns its own local coordinates and action target',async()=>{
 const {ui,calls}=setup();const first=await ui.screenshot({windowId:7,maxWidth:1000});
 const crop=await ui.screenshot({screenshotId:first.structuredContent.screenshotId,crop:{x:100,y:50,width:300,height:200}});
 assert.equal(crop.structuredContent.width,600); // native crop, no enlargement
 await ui.action('click',{screenshotId:crop.structuredContent.screenshotId,x:100,y:100});
 assert.deepEqual(calls,[['click',300,200]]);
});
