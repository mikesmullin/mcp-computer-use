import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const worker=fileURLToPath(new URL('../scripts/ocr-worker.py',import.meta.url));
const defaultPython=fileURLToPath(new URL('../.venv-ocr/bin/python',import.meta.url));
export function createOcr({url="http://127.0.0.1:1239",fetchImpl=fetch,python=process.env.CUA_OCR_PYTHON||defaultPython,timeoutMs=180000}={}) {
  let child,pending,chain=Promise.resolve(),stopped=false;
  function fail(error){if(pending){const p=pending;pending=null;clearTimeout(p.timer);p.reject(error);}}
  function start(){
    if(child)return;
    const proc=spawn(python,[worker],{stdio:['pipe','pipe','pipe'],env:{...process.env,CUA_OCR_DEVICE:'cpu',CUDA_VISIBLE_DEVICES:''}});child=proc;
    proc.stderr.on('data',d=>process.stderr.write(`ocr: ${d.toString().slice(0,4000)}`));
    proc.stdin.on('error',e=>{if(child===proc)fail(e);});
    proc.on('error',e=>{if(child===proc){fail(new Error(`OCR unavailable: ${e.message}. Install requirements-ocr.txt in .venv-ocr or set CUA_OCR_PYTHON.`));child=null;}});
    proc.on('exit',()=>{if(child===proc){fail(new Error('OCR worker exited'));child=null;}});
    createInterface({input:proc.stdout}).on('line',line=>{
      if(child!==proc||!pending)return;
      try {const r=JSON.parse(line);const p=pending;pending=null;clearTimeout(p.timer);r.ok?p.resolve(r):p.reject(new Error(r.error));}
      catch(e){fail(e);proc.kill('SIGKILL');}
    });
  }
  function cpuRequest(shot,options){
    const work=async()=>{
      if(stopped)throw new Error('OCR worker stopped');
      const dir=await mkdtemp(join(tmpdir(),'cua-ocr-'));
      try {
        const path=join(dir,'screen.png');await writeFile(path,shot.bytes);start();
        return await new Promise((resolve,reject)=>{
          const proc=child;
          const timer=setTimeout(()=>{fail(new Error('OCR timed out. Capture again; no input was sent by window_screenshot.'));proc.kill('SIGKILL');if(child===proc)child=null;},timeoutMs);
          pending={resolve,reject,timer};proc.stdin.write(JSON.stringify({...options,path})+'\n');
        });
      } finally {await rm(dir,{recursive:true,force:true});}
    };
    const result=chain.then(work);chain=result.catch(()=>{});return result;
  }
  async function request(shot,options){
    if(stopped)throw new Error('OCR client stopped');
    let healthy=false;
    try {const health=await fetchImpl(`${url}/health`,{signal:AbortSignal.timeout(1500)});healthy=health.ok;}
    catch { /* GPU service absent; operator controls its lifecycle. */ }
    if(!healthy)return cpuRequest(shot,options);
    try {
      const response=await fetchImpl(`${url}/ocr`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...options,image:shot.bytes.toString('base64')}),signal:AbortSignal.timeout(timeoutMs)});
      const result=await response.json();
      if(!response.ok||!result.ok)throw new Error(result.error||`OCR HTTP ${response.status}`);
      return result;
    } catch(error){
      // Do not hide a running server's inference/busy errors behind a slow retry.
      // Only a refused connection (e.g. operator stopped it after /health) falls back.
      if(error.cause?.code==='ECONNREFUSED'||error.code==='ECONNREFUSED')return cpuRequest(shot,options);
      throw error;
    }
  }
  return {
    read:(shot,options={})=>request(shot,{op:'read',...options}),
    check:(shot,target)=>request(shot,{op:'check',bounds:target.bounds,fingerprint:target.fingerprint}).then(r=>r.unchanged),
    stop:async()=>{stopped=true;const proc=child;if(proc){fail(new Error('OCR worker stopped'));proc.kill('SIGKILL');child=null;}await chain;}
  };
}
