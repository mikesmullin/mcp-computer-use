/** Thin client for the operator-managed OCR service owned by mcp-vision. */
export function createOcr({url=process.env.VISION_OCR_URL||'http://127.0.0.1:1239',fetchImpl=fetch,timeoutMs=180000}={}){
 let stopped=false;
 async function request(shot,options){
  if(stopped)throw new Error('OCR client stopped');
  try{
   let health;try{health=await fetchImpl(`${url}/health`,{signal:AbortSignal.timeout(1500)});}catch{throw new Error('OCR unavailable; start the paddleocr inference profile');}
   if(!health.ok)throw new Error('OCR unavailable; start the paddleocr inference profile');
   const r=await fetchImpl(`${url}/ocr`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...options,image:shot.bytes.toString('base64')}),signal:AbortSignal.timeout(timeoutMs)});
   const result=await r.json();if(!r.ok||!result.ok)throw new Error(result.error||`OCR HTTP ${r.status}`);return result;
  }catch(e){if(e.cause?.code==='ECONNREFUSED'||e.message==='fetch failed')throw new Error('OCR unavailable; start the paddleocr inference profile');throw e;}
 }
 return {read:(shot,options={})=>request(shot,{op:'read',...options}),check:(shot,target)=>request(shot,{op:'check',bounds:target.bounds,fingerprint:target.fingerprint}).then(r=>r.unchanged),stop:async()=>{stopped=true;}};
}
