import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
test('dispatcher preserves received order across awaits and drains EOF',async()=>{
 const source=`import {runMcpStdioServer,textResult} from './shared/mcp-stdio.mjs';let state=0;await runMcpStdioServer({name:'test',tools:{set:{inputSchema:{type:'object',properties:{},additionalProperties:false},handler:async()=>{await new Promise(r=>setTimeout(r,80));state=1;return textResult('set');}},get:{inputSchema:{type:'object',properties:{},additionalProperties:false},handler:()=>textResult(state)}}});`;
 const p=spawn('bun',['-e',source],{stdio:['pipe','pipe','pipe']});let output='';p.stdout.on('data',b=>output+=b);
 const done=once(p,'exit');
 p.stdin.end([['set',{}],['get',{}],['get',{height:5}]].map(([name,args],i)=>JSON.stringify({jsonrpc:'2.0',id:i+1,method:'tools/call',params:{name,arguments:args}})).join('\n')+'\n');
 assert.equal((await done)[0],0);const replies=output.trim().split('\n').map(JSON.parse);
 assert.equal(replies[1].result.content[0].text,'1');assert.equal(replies[2].result.isError,true);assert.match(replies[2].result.content[0].text,/Unsupported/);
});
