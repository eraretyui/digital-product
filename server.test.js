import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('.',import.meta.url));
test('Локальный сервер: сохранение, конфликт, вложения, перезапуск и границы',async t=>{
 const dir='qa/storage-'+Date.now();let child,url;
 async function start(){
  child=spawn(process.execPath,['server.mjs'],{cwd,env:{...process.env,PORT:'0',APP_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});
  let out='';url=await new Promise((resolve,reject)=>{child.stdout.on('data',c=>{out+=c;const match=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});child.stderr.on('data',c=>reject(Error(String(c))));child.on('exit',code=>reject(Error('exit '+code)));});
 }
 async function stop(){const p=once(child,'exit');child.kill();await p;}
 const req=(p,method='GET',body,role='rd')=>fetch(url+p,{method,headers:{'Content-Type':'application/json','X-Demo-Role':role},body:body?JSON.stringify(body):undefined});
 await start();t.after(async()=>{if(child.exitCode===null)await stop();});
 let state=await(await req('/api/state')).json();assert.equal(state.products.length,3);
 const original=structuredClone(state);state.settings.testMarker='сохранено';
 let response=await req('/api/state','PUT',{expectedVersion:state.version,state});assert.equal(response.status,200);state=await response.json();
 assert.equal((await req('/api/state','PUT',{expectedVersion:original.version,state:original})).status,409);
 const altered=structuredClone(state);altered.products[0].revisions[0].ingredients[0].name+=' изменено';
 assert.equal((await req('/api/state','PUT',{expectedVersion:state.version,state:altered})).status,403);
 const seen=structuredClone(state);seen.settings.testMarker='изменено';assert.equal((await req('/api/state','PUT',{expectedVersion:state.version,state:seen},'viewer')).status,403);
 const p=state.products[0],r=p.revisions[0];const payload={name:'Протокол.txt',base64:Buffer.from('фактическое вложение').toString('base64'),productId:p.id,revisionId:r.id,documentType:'Протокол'};
 response=await req('/api/attachments','POST',payload);assert.equal(response.status,201);const doc=await response.json();assert.equal(doc.sha256.length,64);
 assert.equal(await(await req(doc.url)).text(),'фактическое вложение');
 assert.equal((await req('/api/attachments','POST',{...payload,name:'script.html'})).status,422);
 assert.equal((await req('/api/attachments','POST',{...payload,revisionId:'unknown'})).status,422);
 state.documents.push(doc);response=await req('/api/state','PUT',{expectedVersion:state.version,state});assert.equal(response.status,200);state=await response.json();
 await stop();await start();const restored=await(await req('/api/state')).json();assert.deepEqual(restored,state);assert.equal(await(await req(doc.url)).text(),'фактическое вложение');
 assert.equal((await req('/data/state.json')).status,404);assert.equal((await req('/server.mjs')).status,404);
 assert.equal((await fetch(url+'/api/state',{method:'PUT',headers:{Origin:'http://elsewhere.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
 const source=await readFile(new URL('./server.mjs',import.meta.url),'utf8');assert.ok(!/https:\/\//.test(source));
 const stopped=once(child,'exit');assert.equal((await req('/api/shutdown','POST')).status,200);await stopped;await start();
 assert.deepEqual(await(await req('/api/state')).json(),state);
});
