import {mkdir,readdir,stat,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
const directory=join(process.env.XDG_CACHE_HOME||join(homedir(),'.cache'),'mcp-computer-use','captures');
export async function saveCapture(bytes){
 await mkdir(directory,{recursive:true,mode:0o700});
 const files=await readdir(directory);const rows=[];
 for(const name of files.filter(n=>/^capture-[0-9a-f-]+\.png$/.test(n))){try{const path=join(directory,name);rows.push({path,mtime:(await stat(path)).mtimeMs});}catch{}}
 rows.sort((a,b)=>b.mtime-a.mtime);
 await Promise.all(rows.filter((r,i)=>i>=63||Date.now()-r.mtime>3600000).map(r=>unlink(r.path).catch(()=>{})));
 const path=join(directory,`capture-${randomUUID()}.png`);await writeFile(path,bytes,{mode:0o600});return path;
}
