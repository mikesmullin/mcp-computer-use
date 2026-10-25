import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from './spawn.mjs';
const script = fileURLToPath(new URL('../scripts/screenshot-view.py', import.meta.url));
export const sameGeometry = (a,b) => ['x','y','width','height'].every(k => a[k] === b[k]);

export async function renderView(shot, crop, maxWidth, grid) {
  const dir = await mkdtemp(join(tmpdir(),'agent-view-'));
  try {
    const source=join(dir,'source.png'), output=join(dir,'view.png');
    await writeFile(source,shot.bytes);
    const options={...crop,maxWidth,grid,sourceWidth:shot.geometry.width,sourceHeight:shot.geometry.height};
    const r=await runCmd('python3',[script,source,output,JSON.stringify(options)]);
    if (!r.ok) throw new Error(`Screenshot rendering failed (requires Python Pillow): ${r.out}`);
    const dimensions=JSON.parse(r.stdout);
    return {...dimensions,bytes:await readFile(output)};
  } finally {await rm(dir,{recursive:true,force:true});}
}
export function createViews({now=Date.now, ttlMs=120000, limit=32}={}) {
  const views=new Map(), versions=new Map();
  const version=id=>versions.get(id)||0;
  const add=view=>{
    const id=randomUUID();
    views.set(id,{...view,id,version:version(view.windowId),time:view.observedAt??now()});
    while(views.size>limit)views.delete(views.keys().next().value);
    return views.get(id);
  };
  const get=id=>{
    const s=views.get(id);
    if(!s)throw new Error('Unknown screenshotId. Call window_screenshot and use its returned ID.');
    if(now()-s.time>ttlMs||s.version!==version(s.windowId))throw new Error('Stale screenshotId. Use the latest returned screenshot or capture again.');
    return s;
  };
  const assertGeometry=(s,g)=>{if(!sameGeometry(s.geometry,g))throw new Error('Window geometry changed since screenshot. Capture again; no action sent.');};
  const point=(s,x,y)=>{
    if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=s.width||y>=s.height)throw new Error(`Point outside ${s.width}x${s.height} screenshot. Use image pixels, not desktop coordinates.`);
    return {x:s.crop.x+Math.min(s.crop.width-1,Math.floor(x*s.crop.width/s.width)),y:s.crop.y+Math.min(s.crop.height-1,Math.floor(y*s.crop.height/s.height))};
  };
  const crop=(s,r)=>{
    if(!r)return {...s.crop};
    if(![r.x,r.y,r.width,r.height].every(Number.isInteger)||r.width<1||r.height<1||r.x<0||r.y<0||r.x+r.width>s.width||r.y+r.height>s.height)throw new Error('Crop must be inside the referenced image, in image pixels.');
    const a=point(s,r.x,r.y);
    return {x:a.x,y:a.y,width:Math.min(s.crop.x+s.crop.width,Math.ceil(s.crop.x+(r.x+r.width)*s.crop.width/s.width))-a.x,height:Math.min(s.crop.y+s.crop.height,Math.ceil(s.crop.y+(r.y+r.height)*s.crop.height/s.height))-a.y};
  };
  return {add,get,point,crop,assertGeometry,invalidate:id=>versions.set(id,version(id)+1)};
}
