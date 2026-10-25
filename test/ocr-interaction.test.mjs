import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createInteraction} from '../lib/interaction.mjs';
import {createViews} from '../lib/screenshot-views.mjs';
function setup(){
 const calls=[];const geometry={x:100,y:200,width:1920,height:1080};let unchanged=true;
 const region={text:'Search Amazon',x:800,y:100,bounds:[700,90,900,110],fingerprint:'abc'};
 const x11={geometry:async()=>geometry,screenshot:async()=>({geometry,bytes:Buffer.from('native PNG')}),click:async(id,p)=>calls.push(['click',id,p.x,p.y]),typeText:async(id,text)=>calls.push(['text',text]),key:async()=>{}};
 const ocr={read:async()=>({width:1920,height:1080,regions:[region],inferenceMs:10,device:'cpu'}),check:async()=>unchanged};
 const awesome={one:async()=>({windowId:7,title:'test'})};
 const render=async()=>({width:1280,height:720,bytes:Buffer.from('image')});
 return {ui:createInteraction({x11,awesome,ocr,render,wait:async()=>{}}),calls,ocr,changed:()=>unchanged=false};
}
test('transcribed screenshot is text-only; target click uses original client pixels and stays text-only',async()=>{
 const {ui,calls}=setup();const r=await ui.screenshot({transcribe:true,windowId:7});const m=r.structuredContent;
 assert.deepEqual(r.content.map(c=>c.type),['text']);
 assert.deepEqual(m.regions,[{targetId:'t1',text:'Search Amazon',location:'top center'}]);
 assert.equal('x' in m.regions[0],false);
 const after=await ui.action('interact',{screenshotId:m.screenshotId,targetId:'t1',text:'hello'});
 assert.deepEqual(calls,[['click',7,800,100],['text','hello']]);
 assert.deepEqual(after.content.map(c=>c.type),['text']);assert.equal(after.structuredContent.status,'input_sent');
 await assert.rejects(ui.action('click',{screenshotId:m.screenshotId,targetId:'t1'}),/Stale/);
});
test('rejects mixed, unknown and missing targets without sending input',async()=>{
 const {ui,calls}=setup();const {screenshotId}= (await ui.screenshot({transcribe:true,windowId:7})).structuredContent;
 for(const args of [{targetId:'t1',x:1,y:2},{targetId:'t2'},{},{x:1}])await assert.rejects(ui.action('click',{screenshotId,...args}));
 assert.deepEqual(calls,[]);
});
test('changed text pixels reject target click',async()=>{
 const {ui,calls,changed}=setup();const {screenshotId}= (await ui.screenshot({transcribe:true,windowId:7})).structuredContent;changed();
 await assert.rejects(ui.action('click',{screenshotId,targetId:'t1'}),/changed since OCR/);assert.deepEqual(calls,[]);
});
test('new read invalidates old regions and query can return no matches',async()=>{
 const {ui}=setup();const a=(await ui.screenshot({transcribe:true,windowId:7})).structuredContent;
 const b=(await ui.screenshot({transcribe:true,windowId:7,query:'missing'})).structuredContent;assert.deepEqual(b.regions,[]);
 await assert.rejects(ui.action('click',{screenshotId:a.screenshotId,targetId:'t1'}),/Stale/);
 await assert.rejects(ui.action('click',{screenshotId:b.screenshotId,targetId:'t1'}),/Unknown/);
});
test('OCR failure after input preserves already-sent warning',async()=>{
 const {ui,ocr}=setup();const {screenshotId}=(await ui.screenshot({transcribe:true,windowId:7})).structuredContent;
 ocr.read=async()=>{throw new Error('worker failed');};
 const r=await ui.action('click',{screenshotId,targetId:'t1'});assert.equal(r.isError,true);assert.match(r.content[0].text,/Input was sent/);
});
test('view lifetime starts at capture, not completion of slow OCR',()=>{
 const views=createViews({now:()=>130000});const v=views.add({windowId:7,observedAt:0});assert.throws(()=>views.get(v.id),/Stale/);
});
test('transcription crops in native pixels, ignores grid, and target clicks retain native coordinates',async()=>{
 const {ui,ocr,calls}=setup();
 const first=await ui.screenshot({windowId:7,maxWidth:1280});
 const baseRead=ocr.read;
 ocr.read=async(shot,options)=>{assert.deepEqual(options.crop,{x:600,y:60,width:450,height:300});return baseRead();};
 const r=await ui.screenshot({screenshotId:first.structuredContent.screenshotId,transcribe:true,grid:50,crop:{x:400,y:40,width:300,height:200}});
 assert.deepEqual(r.content.map(c=>c.type),['text']);assert.equal(r.structuredContent.width,450);
 ocr.read=baseRead;
 await ui.action('click',{screenshotId:r.structuredContent.screenshotId,targetId:'t1'});
 assert.deepEqual(calls,[['click',7,800,100]]);
});
test('transcribe defaults off even when referencing an OCR observation',async()=>{
 const {ui}=setup();const a=await ui.screenshot({windowId:7,transcribe:true});
 const b=await ui.screenshot({screenshotId:a.structuredContent.screenshotId});
 assert.deepEqual(b.content.map(c=>c.type),['text','image']);
 await assert.rejects(ui.screenshot({windowId:7,query:'Search'}),/requires transcribe/);
});
