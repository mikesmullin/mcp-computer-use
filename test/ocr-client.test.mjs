import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOcr} from '../lib/ocr.mjs';
test('healthy reserved service handles OCR; client stop never stops service',async()=>{
 const requests=[];
 const fetchImpl=async(url,options)=>{requests.push([url,options]);return {ok:true,json:async()=>({ok:true,regions:[],device:'gpu:0'})};};
 const ocr=createOcr({fetchImpl,python:'/must-not-launch'});
 const result=await ocr.read({bytes:Buffer.from('image')},{crop:{x:1,y:2,width:3,height:4}});
 assert.equal(result.device,'gpu:0');await ocr.stop();
 assert.deepEqual(requests.map(r=>r[0]),['http://127.0.0.1:1239/health','http://127.0.0.1:1239/ocr']);
 const body=JSON.parse(requests[1][1].body);assert.equal(body.image,Buffer.from('image').toString('base64'));assert.equal(body.crop.x,1);
});
test('running service errors are not silently retried on CPU',async()=>{
 const ocr=createOcr({python:'/must-not-launch',fetchImpl:async url=>url.endsWith('/health')?{ok:true}:{ok:false,status:503,json:async()=>({error:'busy'})}});
 await assert.rejects(ocr.read({bytes:Buffer.from('image')}),/busy/);await ocr.stop();
});
test('absent service reports unavailable without loading a CPU worker',async()=>{
 const ocr=createOcr({python:'/nonexistent/ocr-python',fetchImpl:async()=>{throw new Error('connection refused');}});
 await assert.rejects(ocr.read({bytes:Buffer.from('image')}),/OCR unavailable/);await ocr.stop();
});
