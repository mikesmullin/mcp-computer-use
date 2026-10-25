import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('grid draws at requested output pixel interval and rejects booleans',()=>{
 execFileSync('python3',['-c',`
import json, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image
with tempfile.TemporaryDirectory() as d:
 src=Path(d)/'source.png'; Image.new('RGB',(400,400),'black').save(src)
 for spacing in (0,50,100):
  out=Path(d)/f'{spacing}.png'
  o=dict(x=0,y=0,width=400,height=400,sourceWidth=400,sourceHeight=400,maxWidth=400,grid=spacing)
  subprocess.run([sys.executable,sys.argv[1],str(src),str(out),json.dumps(o)],check=True,stdout=subprocess.DEVNULL)
  im=Image.open(out)
  assert (im.getpixel((50,175))!=(0,0,0)) == (spacing==50)
  assert (im.getpixel((100,175))!=(0,0,0)) == (spacing>0)
 o['grid']=True
 r=subprocess.run([sys.executable,sys.argv[1],str(src),str(out),json.dumps(o)],capture_output=True)
 assert r.returncode!=0
`,fileURLToPath(new URL('../scripts/screenshot-view.py',import.meta.url))]);
});
