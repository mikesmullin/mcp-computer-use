import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createViews,renderView} from '../lib/screenshot-views.mjs';
import {normalizeKey} from '../lib/keys.mjs';
import {validate} from '../lib/schema.mjs';
const geometry={x:1600,y:1000,width:2000,height:1000};
const setup=()=>{let time=0;const views=createViews({now:()=>time,ttlMs:100});const v=views.add({windowId:10,geometry,crop:{x:200,y:100,width:1000,height:500},width:500,height:250});return {views,v,advance:()=>time=101};};
test('scaled crop maps image center to client pixels without desktop offsets',()=>{
 const {views,v}=setup();assert.deepEqual(views.point(v,250,125),{x:700,y:350});
 assert.deepEqual(views.crop(v,{x:100,y:50,width:200,height:100}),{x:400,y:200,width:400,height:200});
 for(const p of [[500,0],[-1,2],[1.5,1],[0,250]])assert.throws(()=>views.point(v,...p));
});
test('stale, expired, and moved screenshots cannot be used',()=>{
 const {views,v,advance}=setup();assert.throws(()=>views.assertGeometry(v,{...geometry,y:1001}),/geometry changed/);
 views.invalidate(10);assert.throws(()=>views.get(v.id),/Stale/);
 const v2=views.add({...v});advance();assert.throws(()=>views.get(v2.id),/Stale/);
 assert.throws(()=>views.get('bad'),/Unknown/);
});
test('schema rejects wrong types, unknown keys and nested errors',()=>{
 const s={type:'object',additionalProperties:false,required:['crop'],properties:{crop:{type:'object',additionalProperties:false,required:['x'],properties:{x:{type:'integer',minimum:0}}}}};
 validate(s,{crop:{x:1}});
 for(const args of [{},{crop:{x:'1'}},{crop:{x:-1}},{crop:{x:1,y:0}},{crop:{x:1},height:10}])assert.throws(()=>validate(s,args));
});
test('key chords normalize with a constrained vocabulary',()=>{
 assert.equal(normalizeKey('Ctrl+t'),'ctrl+t');assert.equal(normalizeKey('Shift+Tab'),'shift+Tab');assert.equal(normalizeKey('Enter'),'Return');
 for(const key of ['Ctrl+t Return','--window','Ctrl++','Ctrl+Ctrl+a','Meta+q'])assert.throws(()=>normalizeKey(key));
});
