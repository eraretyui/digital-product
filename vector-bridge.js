import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rename,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

const PROJECT=path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE=PROJECT;
const DEFAULT_PYTHON=process.platform==='win32'?'python':'python3';
const queues=new Map();
function inside(root,p){const rel=path.relative(root,p);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
function bound(p){const resolved=path.resolve(p);if(!inside(WORKSPACE,resolved)||resolved===path.join(PROJECT,'.deps')||inside(path.join(PROJECT,'.deps'),resolved))throw Error('Vector dataDir must be inside workspace and outside .deps');return resolved;}
async function safeDirectory(p){bound(p);let existing=p;while(true){try{const resolved=await realpath(existing);if(resolved!==WORKSPACE)bound(resolved);break;}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(existing);if(parent===existing)throw e;existing=parent;}}await mkdir(p,{recursive:true});bound(await realpath(p));for(const name of ['snapshot.json','index.faiss','index-meta.json']){try{bound(await realpath(path.join(p,name)));}catch(e){if(e.code!=='ENOENT')throw e;}}}
function validateVector(v,dimension){if(!Array.isArray(v)||!v.length||v.length>65536||v.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1e30)||dimension!==undefined&&v.length!==dimension||Math.hypot(...v)===0)throw Error('Expected finite nonzero numeric vectors of equal dimension');}
function normal(v){const n=Math.hypot(...v);return v.map(x=>x/n);}
function worker(request,{pythonPath,timeoutMs}){return new Promise((resolve,reject)=>{const child=spawn(pythonPath,[path.join(PROJECT,'vector-worker.py')],{cwd:PROJECT,shell:false,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',TEMP:path.join(PROJECT,'.tmp'),TMP:path.join(PROJECT,'.tmp')}});let stdout='',stderr='',done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};const timer=setTimeout(()=>{child.kill();finish(Error('FAISS worker timeout'));},timeoutMs);child.on('error',e=>finish(e));child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>{stdout+=s;if(stdout.length>32*1024*1024){child.kill();finish(Error('FAISS response too large'));}});child.stderr.on('data',s=>{stderr=(stderr+s).slice(-2000);});child.on('close',code=>{try{const result=JSON.parse(stdout);if(code!==0||!result.ok)throw Error(result.error||stderr||'FAISS worker failed');delete result.ok;finish(null,result);}catch(e){finish(e);}});child.stdin.on('error',e=>finish(e));child.stdin.end(JSON.stringify(request));});}

/** Ready numeric vectors only. Caller owns chunking and embedding/model provenance. */
export function createVectorStore({dataDir,pythonPath=process.env.VECTOR_PYTHON||DEFAULT_PYTHON,timeoutMs=20000,forceFallback=false}={}){
 if(typeof dataDir!=='string')throw Error('dataDir required');const directory=bound(path.join(bound(dataDir),'vector-index'));
 const options={pythonPath,timeoutMs:Math.max(500,Math.min(timeoutMs,60000))};let last=null;
 const serial=fn=>{const previous=queues.get(directory)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);queues.set(directory,next);return next.finally(()=>{if(queues.get(directory)===next)queues.delete(directory);});};
 const load=async()=>{await safeDirectory(directory);return JSON.parse(await readFile(path.join(directory,'snapshot.json'),'utf8'));};
 const fallback=reason=>({engine:'js-cosine-fallback',fallback:true,reason:String(reason?.message||reason||'FAISS unavailable')});
 return {
  directory,
  async status(){try{await safeDirectory(directory);if(forceFallback)throw Error('Explicit fallback requested');const result=await worker({op:'probe'},options);return {...result,...(last||{})};}catch(e){return fallback(e);}},
  build({vectors,metadata,fingerprint:callerFingerprint=null}){return serial(async()=>{
   if(!Array.isArray(vectors)||!Array.isArray(metadata)||vectors.length!==metadata.length||vectors.length>20000)throw Error('Vectors and metadata must have matching counts <=20000');
   const dimension=vectors[0]?.length||0;vectors.forEach(v=>validateVector(v,dimension));
   const fingerprint=createHash('sha256').update(JSON.stringify({vectors,metadata,callerFingerprint})).digest('hex');await safeDirectory(directory);
   let previous;try{previous=await load();}catch(e){if(e.code!=='ENOENT')throw e;}
   const snapshot={fingerprint,count:vectors.length,dimension,metadata,vectors:vectors.map(normal)};
   if(previous?.fingerprint!==fingerprint){const temporary=path.join(directory,'snapshot-'+randomUUID()+'.tmp');await writeFile(temporary,JSON.stringify(snapshot),'utf8');await rename(temporary,path.join(directory,'snapshot.json'));}
   let result;try{if(forceFallback)throw Error('Explicit fallback requested');if(!vectors.length)result=await worker({op:'probe'},options);else{let valid=false;if(previous?.fingerprint===fingerprint){try{const meta=JSON.parse(await readFile(path.join(directory,'index-meta.json'),'utf8'));valid=meta.fingerprint===fingerprint&&meta.indexSha256===createHash('sha256').update(await readFile(path.join(directory,'index.faiss'))).digest('hex');}catch{}}result=valid?await worker({op:'probe'},options):await worker({op:'build',directory,vectors,metadata,fingerprint},options);}}catch(e){result=fallback(e);}
   return last={...result,count:vectors.length,dimension,fingerprint};
  });},
  query({vector,k=4}){return serial(async()=>{const snapshot=await load();if(!snapshot.count)return {...(last||fallback('Empty corpus')),count:0,dimension:0,hits:[]};validateVector(vector,snapshot.dimension);if(!Number.isInteger(k)||k<1||k>100)throw Error('k must be an integer from 1 to 100');let result;try{if(forceFallback)throw Error('Explicit fallback requested');result=await worker({op:'query',directory,vector,k,fingerprint:snapshot.fingerprint},options);}catch(e){const query=normal(vector);result={...fallback(e),count:snapshot.count,dimension:snapshot.dimension,hits:snapshot.vectors.map((v,index)=>({index,score:v.reduce((s,x,j)=>s+x*query[j],0),metadata:snapshot.metadata[index]})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,k)};}last={engine:result.engine,fallback:result.fallback,reason:result.reason,count:result.count,dimension:result.dimension};return {...result,hits:result.hits.map(h=>({...h.metadata,...h}))};});}
 };
}
