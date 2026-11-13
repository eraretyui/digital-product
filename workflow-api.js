import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {runAgent,revisionHash} from './agent-workflow.js';
import {providerStatus} from './llm-provider.js';
import {sanitize,injectionDetected} from './llm-provider.js';
import {normalizeElmaExport,mergeImported} from './import-elma.js';
import {createRevision,validateRevision} from './domain.js';
import {evaluateSuite} from './evals.js';
import {createVectorStore} from './vector-bridge.js';
const error=(m,status=422)=>Object.assign(Error(m),{status});
export async function createWorkflowApi({dataDir,getState,commitState,serial}){
 const dir=path.join(dataDir,'agent');await mkdir(dir,{recursive:true});
 const vectorStore=createVectorStore({dataDir});
 let agentQueue=Promise.resolve();
 const file=path.join(dir,'runs.json');let runs=[];try{runs=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 // A stopped local process cannot leave an apparently running model job.
 for(const r of runs)if(r.status==='running'){r.status='interrupted';r.error='Процесс остановлен до завершения. Запустите анализ повторно.';}
 let diskQueue=Promise.resolve();
 function saveRuns(){diskQueue=diskQueue.then(async()=>{await writeFile(file+'.tmp',JSON.stringify(runs,null,2));await rename(file+'.tmp',file);});return diskQueue;}
 await saveRuns();
 const feedbackFile=path.join(dir,'feedback.jsonl');
 async function feedback(record){const {appendFile}=await import('node:fs/promises');await appendFile(feedbackFile,JSON.stringify(sanitize({...record,id:randomUUID(),at:new Date().toISOString(),status:'requires_review'}))+'\n');}
 const reviewedFile=path.join(dir,'reviewed-feedback.json');
 async function reviewed(){try{return JSON.parse(await readFile(reviewedFile,'utf8'));}catch{return [];}}
 async function acceptedKnowledge(){const last=new Map();for(const item of await reviewed())last.set(item.id,item);return [...last.values()].filter(x=>x.decision==='accept').map(x=>({sourceId:'operator-feedback:'+x.id,revision:x.at,verified:true,text:x.text,paragraph:1}));}
 async function feedbackRows(){try{return (await readFile(feedbackFile,'utf8')).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));}catch{return [];}}
 async function runEvaluation(judge=false){
  const golden=await readFile(new URL('./evaluation/golden.json',import.meta.url),'utf8'),corpus=await readFile(new URL('./knowledge/project-corpus.json',import.meta.url),'utf8');let cases;if(judge)cases=JSON.parse(golden).slice(0,1);
  const result=await evaluateSuite({judge,cases}),target=path.join(dir,judge?'judge-latest.json':'evaluation-latest.json');
  let previous;try{previous=JSON.parse(await readFile(target,'utf8'));}catch{}
  const sourceHash=createHash('sha256').update(golden+corpus).digest('hex'),regressions=(result.results||[]).filter(r=>!r.passed&&previous?.results?.some(p=>p.id===r.id&&p.passed)).map(r=>r.id);
  result.drift={status:!previous?'baseline':regressions.length?'regression':'stable',regressions,dataChanged:previous?.sourceHash?previous.sourceHash!==sourceHash:null,explanation:'Контроль изменений входного корпуса и регрессий на эталонном наборе. Не статистическое доказательство отсутствия concept drift.'};result.sourceHash=sourceHash;
  await writeFile(path.join(dir,'evaluation-'+result.id+'.json'),JSON.stringify(result,null,2));await writeFile(target,JSON.stringify(result,null,2));return result;
 }
 // Cheap regression repeats while the local app runs; no model calls on this timer.
 const regressionTimer=setInterval(()=>runEvaluation(false).catch(()=>{}),60*60*1000);regressionTimer.unref();
 const current=(productId,revisionId)=>{const product=getState().products.find(p=>p.id===productId),revision=product?.revisions.find(r=>r.id===revisionId);if(!product||!revision)throw error('Продукт или редакция не найдены',404);return {product,revision};};
 return async function workflow({url,method,input}){
  if(url.pathname==='/api/agent/status'&&method==='GET'){
   const calls=runs.filter(r=>r.mode==='local-llm'||r.metrics?.providerErrorCount>0),errors=calls.reduce((s,r)=>s+(r.metrics?.providerErrorCount||0),0),tokens=runs.filter(r=>r.metrics?.inputTokens!=null);
   return {provider:await providerStatus(),vector:await vectorStore.status(),source:'file-export-only',hitl:true,pending:runs.filter(r=>r.status==='running').length,monitoring:{runs:runs.length,plannerCalls:calls.length,plannerErrors:errors,plannerErrorRate:calls.length?errors/calls.length:null,inputTokens:tokens.length?tokens.reduce((s,r)=>s+r.metrics.inputTokens,0):null,outputTokens:tokens.length?tokens.reduce((s,r)=>s+(r.metrics.outputTokens||0),0):null,scope:'Локальные вызовы планировщика; embedding-запросы учитываются отдельно в журнале.'}};
  }
  if(url.pathname==='/api/agent/runs'&&method==='GET')return runs.filter(r=>(!url.searchParams.get('revisionId')||r.revisionId===url.searchParams.get('revisionId'))&&(!url.searchParams.get('productId')||r.productId===url.searchParams.get('productId'))).slice().reverse();
  if(url.pathname==='/api/agent/runs'&&method==='POST'){
   const {product,revision}=current(input.productId,input.revisionId);
   if(typeof input.query!=='string'||!input.query.trim()||input.query.length>4000)throw error('Введите запрос длиной от 1 до 4000 символов');
   if(runs.some(r=>r.status==='running'&&r.revisionId===revision.id))throw error('Анализ этой редакции уже выполняется',409);
   const id=randomUUID(),job={id,productId:product.id,revisionId:revision.id,status:'running',createdAt:new Date().toISOString()};runs.push(job);await saveRuns();
   const snapshot=structuredClone({product,revision});
   // Analysis may propose; this background operation never commits recipe state.
   const task=async()=>runAgent({...snapshot,query:input.query,knowledgeDocuments:await acceptedKnowledge(),options:{llm:input.useLLM!==false}}, {vectorStore});
   const operation=agentQueue.then(task);agentQueue=operation.catch(()=>{});
   operation.then(async result=>{
    Object.assign(job,result,{id,productId:product.id,revisionId:revision.id,completedAt:new Date().toISOString()});
    if(job.candidate){job.candidate.id=job.candidate.id||randomUUID();job.candidate.status='pending';}
    await saveRuns();
   }).catch(async e=>{job.status='error';job.error=String(e.message).slice(0,1000);await saveRuns();});
   return job;
  }
  const match=url.pathname.match(/^\/api\/agent\/runs\/([\da-f-]+)$/);
  if(match&&method==='GET'){const r=runs.find(r=>r.id===match[1]);if(!r)throw error('Задание не найдено',404);return r;}
  const decision=url.pathname.match(/^\/api\/agent\/candidates\/([^/]+)\/decision$/);
  if(decision&&method==='POST')return serial(async()=>{
   const run=runs.find(r=>r.candidate?.id===decision[1]);if(!run)throw error('Предложение не найдено',404);
   const c=run.candidate;
   const prior=getState().products.flatMap(p=>p.revisions).find(r=>r.agentOrigin?.candidateId===c.id);if(prior)return {state:getState(),revisionId:prior.id,alreadyApplied:true};
   if(c.status==='approved')return {state:getState(),revisionId:c.appliedRevisionId,alreadyApplied:true};
   if(c.status!=='pending')throw error('Предложение уже рассмотрено',409);
   if(!['approve','reject','correct'].includes(input.action))throw error('Неизвестное решение');
   if(input.action==='reject'){c.status='rejected';c.comment=String(input.comment||'').slice(0,1000);await feedback({runId:run.id,candidateId:c.id,action:'reject',comment:c.comment});await saveRuns();return {state:getState(),rejected:true};}
   if(input.expectedVersion!==getState().version)throw error('База изменилась. Обновите данные и повторите проверку предложения.',409);
   const {product,revision}=current(run.productId,run.revisionId);
   if(product.revisions.at(-1).id!==revision.id||revisionHash(revision)!==c.baseInputHash)throw error('Основание предложения устарело. Запустите анализ актуальной редакции.',409);
   const draft=input.action==='correct'?input.draft:c.draft;
   if(!draft)throw error('Не передан исправленный состав');const errors=validateRevision(draft);if(errors.length)throw error(errors.join('; '));
   const next=structuredClone(getState()),p=next.products.find(p=>p.id===product.id),r=createRevision(p,draft,input.comment||'Предложение агента');r.agentOrigin={runId:run.id,candidateId:c.id,decision:input.action};p.revisions.push(r);p.stage='Рецептура';
   const state=await commitState(next,input.expectedVersion,'rd');c.status='approved';c.appliedRevisionId=r.id;
   await feedback({runId:run.id,candidateId:c.id,action:input.action,comment:String(input.comment||'').slice(0,1000),revisionId:r.id,corrected:input.action==='correct'?draft:null});await saveRuns();return {state,revisionId:r.id};
  });
  if(url.pathname==='/api/imports/preview'&&method==='POST')return normalizeElmaExport(input.data,{recipeId:input.recipeId,fileName:input.fileName});
  if(url.pathname==='/api/imports/apply'&&method==='POST')return serial(async()=>{
   const result=normalizeElmaExport(input.data,{recipeId:input.recipeId,fileName:input.fileName}),next=mergeImported(getState(),result);
   return {state:await commitState(next,input.expectedVersion,'rd'),warnings:result.warnings,incomingDossiers:result.incomingDossiers};
  });
  const complete=url.pathname.match(/^\/api\/imports\/dossiers\/([^/]+)\/complete$/);
  if(complete&&method==='POST')return serial(async()=>{
   const old=getState(),incoming=old.incomingDossiers?.find(d=>d.id===complete[1]);if(!incoming)throw error('Входящее досье не найдено',404);
   const errors=validateRevision(input.draft);if(errors.length)throw error(errors.join('; '));
   const next=structuredClone(old);let p=next.products.find(p=>p.id===incoming.productId);
   if(!p){p={id:incoming.productId,code:incoming.code,title:incoming.title,tags:['Импорт ELMA'],stage:'Рецептура',revisions:[],source:incoming.source};next.products.push(p);}
   const draft={...input.draft,source:incoming.source,origin:incoming.origin};const r=createRevision(p,draft,'Уточнение входящего досье оператором');r.source=incoming.source;p.revisions.push(r);
   next.incomingDossiers=next.incomingDossiers.filter(d=>d.id!==incoming.id);
   return {state:await commitState(next,input.expectedVersion,'rd'),productId:p.id,revisionId:r.id};
  });
  if(url.pathname==='/api/evaluations'&&method==='POST'){
   return runEvaluation(input?.judge===true);
  }
  if(url.pathname==='/api/evaluations'&&method==='GET'){try{return JSON.parse(await readFile(path.join(dir,'evaluation-latest.json'),'utf8'));}catch{return {status:'not_run'};}}
  if(url.pathname==='/api/feedback'&&method==='GET')return {items:await feedbackRows(),reviewed:await reviewed()};
  if(url.pathname==='/api/feedback/review'&&method==='POST')return serial(async()=>{
   const item=(await feedbackRows()).find(x=>x.id===input.id);if(!item)throw error('Исправление не найдено',404);
   if(!['accept','reject'].includes(input.decision)||!String(input.text||'').trim())throw error('Укажите решение и проверенное пояснение');
   if(injectionDetected(input.text))throw error('Пояснение содержит управляющие инструкции; сохраните только проверенные сведения');
   const records=await reviewed(),record=sanitize({id:item.id,decision:input.decision,text:String(input.text).slice(0,3000),at:new Date().toISOString(),origin:item.runId});
   records.push(record);await writeFile(reviewedFile,JSON.stringify(records,null,2));return record;
  });
  return undefined;
 };
}
