import { createViews, renderView } from './screenshot-views.mjs';
import { normalizeKey } from './keys.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const instructions='Use window_screenshot first. Click x,y are pixels in its returned image: pass screenshotId; never add/subtract title-bar, desktop, browser, or cursor offsets. Prefer window_interact to click then type in order. Actions return a fresh screenshot; inspect it before claiming success. After a miss, request a crop/grid, not window movement. Read skills computer-use for the workflow.';
export function createInteraction({x11,awesome,views=createViews(),render=renderView,wait=sleep}={}) {
  const select=args=>args.windowId||args.class||args.title||args.focused?{windowId:args.windowId,class:args.class,title:args.title,focused:args.focused}:{focused:true};
  const fresh=async id=>{
    const v=views.get(id);views.assertGeometry(v,await x11.geometry(v.windowId));
    const w=await awesome.one({windowId:v.windowId});
    if(w.title!==v.title)throw new Error('Window title/tab changed since screenshot. Capture again; no action sent.');
    return v;
  };
  const observe=async(windowId,{crop,maxWidth=1280,grid=false,status='observation',sent=[]}={})=>{
    const shot=await x11.screenshot({windowId});
    crop=crop||{x:0,y:0,width:shot.geometry.width,height:shot.geometry.height};
    const image=await render(shot,crop,maxWidth,grid);
    const w=await awesome.one({windowId});
    views.assertGeometry({geometry:shot.geometry},await x11.geometry(windowId));
    const v=views.add({windowId,geometry:shot.geometry,crop,width:image.width,height:image.height,title:w.title,maxWidth,grid});
    const p=shot.agentCursor;
    let cursor=null;
    if(p){const x=(p.x-shot.geometry.x-crop.x)*v.width/crop.width,y=(p.y-shot.geometry.y-crop.y)*v.height/crop.height;
      if(x>=0&&y>=0&&x<v.width&&y<v.height)cursor={x:Math.round(x),y:Math.round(y)};
    }
    const metadata={screenshotId:v.id,windowId,width:v.width,height:v.height,coordinateSpace:'image pixels; top-left is (0,0)',agentCursor:cursor,title:w.title,status,sent,applicationOutcome:'not verified',expiresInSeconds:120};
    const note='Use this screenshotId and image x,y for the NEXT action. Do not apply any offsets. The image includes browser chrome. Inspect the result; input delivery does not prove the intended element handled it.';
    return {content:[{type:'text',text:JSON.stringify(metadata)+'\n'+note},{type:'image',mimeType:'image/png',data:image.bytes.toString('base64')}],structuredContent:metadata};
  };
  const screenshot=async args=>{
    if(args.screenshotId){
      if(['windowId','class','title','focused'].some(k=>args[k]!==undefined))throw new Error('Use screenshotId OR a window selector, not both.');
      const v=await fresh(args.screenshotId);
      return observe(v.windowId,{crop:views.crop(v,args.crop),maxWidth:args.maxWidth??v.maxWidth,grid:args.grid??v.grid});
    }
    if(args.crop)throw new Error('To crop, provide screenshotId and crop coordinates from that image.');
    const w=await awesome.one(select(args));
    return observe(w.windowId,args);
  };
  const action=async(kind,args)=>{
    // Validate the entire compound action before sending any input.
    if(args.keys!==undefined)normalizeKey(args.keys);
    if(args.text!==undefined&&(typeof args.text!=='string'||!args.text.length||args.text.length>4000))throw new Error('text must contain 1–4000 characters');
    if(kind==='interact'&&((args.x===undefined)!==(args.y===undefined)))throw new Error('Provide both x and y for the click.');
    if(args.button!==undefined&&args.x===undefined)throw new Error('button requires click x and y');
    if(args.replace&&args.text===undefined)throw new Error('replace requires text');
    if(kind==='interact'&&args.x===undefined&&args.text===undefined&&args.keys===undefined)throw new Error('Provide a click, text, or keys');
    const v=await fresh(args.screenshotId), sent=[];
    const point=args.x!==undefined?views.point(v,args.x,args.y):null;
    views.invalidate(v.windowId);
    const expectedGeometry=v.geometry;
    try {
      if(point){await x11.click(v.windowId,{...point,button:args.button??1,expectedGeometry});sent.push('click');await wait(100);}
      if(args.text!==undefined){
        if(args.replace){await x11.key(v.windowId,'Ctrl+a',{expectedGeometry});sent.push('select_all');}
        await x11.typeText(v.windowId,args.text,{delayMs:args.delayMs??12,expectedGeometry});sent.push('text');
      }
      if(args.keys!==undefined){await x11.key(v.windowId,args.keys,{expectedGeometry});sent.push('keys');}
      await wait(args.waitMs??300);
    } catch(error){throw new Error(`${error.message} Completed steps: ${sent.join(', ')||'none'}. The failing step may be partial. Capture before retrying; do not repeat the whole action blindly.`);}
    // Full-window result makes navigation/new dialogs visible even after a crop click.
    try {return await observe(v.windowId,{maxWidth:v.maxWidth,grid:v.grid,status:'input_sent',sent});}
    catch(error){return {isError:true,content:[{type:'text',text:`Input was sent (${sent.join(', ')}), but observation failed: ${error.message}. Do not repeat input; capture again.`}]};}
  };
  return {screenshot,action,views,observe};
}
