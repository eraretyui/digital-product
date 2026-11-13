import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createVectorStore} from './vector-bridge.js';
const project=path.dirname(fileURLToPath(import.meta.url));
const vectors=[[3,0,0],[0,2,0],[-1,0,0],[1,1,0]];
const metadata=['sugar','quality','negative','mixed'].map((id,i)=>({id,sourceId:'fixture:'+id,revision:1,paragraph:i+1,text:'Проверочный фрагмент '+id}));
async function isolated(t){const dir=await mkdtemp(path.join(project,'.tmp/vector-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('actual FAISS CPU persists IndexFlatIP and retrieves after process/store restart',async t=>{
 const probe=await createVectorStore({dataDir:path.join(project,'.tmp/probe')}).status();if(probe.fallback){t.skip('Optional Python/FAISS unavailable: '+probe.reason);return;}
 const dataDir=await isolated(t);const store=createVectorStore({dataDir});const built=await store.build({vectors,metadata});
 assert.equal(built.engine,'faiss-cpu',built.reason);assert.equal(built.fallback,false);assert.equal(built.dimension,3);
 const bytes=await readFile(path.join(dataDir,'vector-index/index.faiss'));assert.ok(bytes.length>20);
 const diskMeta=JSON.parse(await readFile(path.join(dataDir,'vector-index/index-meta.json'),'utf8'));assert.deepEqual(diskMeta.metadata,metadata);
 const restarted=createVectorStore({dataDir});const found=await restarted.query({vector:[8,0,0],k:3});
 assert.equal(found.engine,'faiss-cpu',found.reason);assert.deepEqual(found.hits.map(h=>h.id),['sugar','mixed','quality']);assert.ok(Math.abs(found.hits[0].score-1)<1e-6);assert.equal(found.hits[0].metadata.sourceId,'fixture:sugar');
 const rebuilt=await restarted.build({vectors:[[0,0,2]],metadata:[{id:'new'}]});assert.equal(rebuilt.count,1);const latest=await createVectorStore({dataDir}).query({vector:[0,0,1]});assert.equal(latest.hits[0].id,'new');
});
test('unavailable FAISS is explicitly exact JS cosine fallback and persists',async t=>{
 const dataDir=await isolated(t);const store=createVectorStore({dataDir,pythonPath:path.join(dataDir,'missing-python.exe')});
 const built=await store.build({vectors,metadata});assert.equal(built.engine,'js-cosine-fallback');assert.equal(built.fallback,true);
 const found=await createVectorStore({dataDir,forceFallback:true}).query({vector:[2,0,0],k:4});assert.deepEqual(found.hits.map(h=>h.id),['sugar','mixed','quality','negative']);assert.equal(found.hits[3].score,-1);
});
test('rejects invalid dimensions, zero/nonfinite vectors and paths outside scope',async t=>{
 const dataDir=await isolated(t);const store=createVectorStore({dataDir});
 await assert.rejects(store.build({vectors:[[0,0]],metadata:[{}]}),/nonzero/);
 await assert.rejects(store.build({vectors:[[1,0],[1]],metadata:[{},{}]}),/dimension/);
 await assert.rejects(store.build({vectors:[[NaN,1]],metadata:[{}]}),/finite/);
 assert.throws(()=>createVectorStore({dataDir:'C:/outside-workspace'}),/workspace/);
 assert.throws(()=>createVectorStore({dataDir:path.join(project,'.deps/faiss')}),/outside .deps/);
 await store.build({vectors,metadata});await assert.rejects(store.query({vector:[1,0]}),/dimension/);await assert.rejects(store.query({vector:[1,0,0],k:-1}),/k must/);
});
test('corrupted disk index is detected before native deserialization and repaired by build',async t=>{
 const probe=await createVectorStore({dataDir:path.join(project,'.tmp/probe-corruption')}).status();if(probe.fallback){t.skip('Optional Python/FAISS unavailable: '+probe.reason);return;}
 const dataDir=await isolated(t);const store=createVectorStore({dataDir});await store.build({vectors,metadata});
 await writeFile(path.join(dataDir,'vector-index/index.faiss'),'corrupted');
 const result=await store.query({vector:[1,0,0]});assert.equal(result.engine,'js-cosine-fallback');assert.match(result.reason,/checksum/);assert.equal(result.hits[0].id,'sugar');
 const repaired=await store.build({vectors,metadata});assert.equal(repaired.engine,'faiss-cpu',repaired.reason);assert.equal((await store.query({vector:[1,0,0]})).engine,'faiss-cpu');
});
