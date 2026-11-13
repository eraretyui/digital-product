import http from 'node:http';
import {readFile,writeFile,mkdir,rename,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createSeedState} from './seeds.js';
import {validateRevision} from './domain.js';
import {validateChanges} from './state-validation.js';
import {createWorkflowApi} from './workflow-api.js';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=path.resolve(ROOT,process.env.APP_DATA_DIR||'data');
if(!DATA.startsWith(ROOT+path.sep))throw Error('Данные должны оставаться внутри папки приложения');
await mkdir(path.join(DATA,'attachments'),{recursive:true});
const statePath=path.join(DATA,'state.json');
let state;
try{state=JSON.parse(await readFile(statePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;state=createSeedState();await writeFile(statePath,JSON.stringify(state,null,2));}
let mutation=Promise.resolve();
function serial(fn){const result=mutation.then(fn);mutation=result.catch(()=>{});return result;}
function fail(message,status=422){return Object.assign(Error(message),{status});}
function validate(s){
 if(!s||s.schemaVersion!==1||!Array.isArray(s.products)||!Array.isArray(s.documents)||!s.settings)throw fail('Неверная структура локальной базы');
 if(s.products.length>1000)throw fail('Не более 1000 продуктов');
 const ids=new Set(),codes=new Set(),rids=new Set();
 for(const p of s.products){
  if(!p.id||!p.code||typeof p.title!=='string'||!p.title.trim()||!Array.isArray(p.tags)||!Array.isArray(p.revisions)||!p.revisions.length)throw fail('Продукт должен иметь ID, код, название, теги и редакции');
  if(ids.has(p.id)||codes.has(p.code))throw fail('Повторяющийся ID или код продукта');ids.add(p.id);codes.add(p.code);
  for(const r of p.revisions){if(!r.id||rids.has(r.id))throw fail('Повторяющийся или пустой ID редакции');rids.add(r.id);const errors=validateRevision(r);if(errors.length)throw fail(errors.join('; '));}
 }
 for(const d of s.documents){if(!ids.has(d.productId)||!s.products.find(p=>p.id===d.productId)?.revisions.some(r=>r.id===d.revisionId))throw fail('Документ ссылается на неизвестную редакцию');}
}
async function body(req){let chunks=[],size=0;for await(const c of req){size+=c.length;if(size>16*1024*1024)throw fail('Размер запроса превышает 16 МБ',413);chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('Неверный JSON',400);}}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png'};
const PUBLIC=new Set(['index.html','app.js','style.css','domain.js','seeds.js','scene.js','data-source.js','workflow-ui.js']);
async function commitState(next,expectedVersion,role='rd'){
 if(expectedVersion!==state.version)throw fail('База изменена в другом окне. Обновите данные.',409);
 validate(next);validateChanges(state,next,role);
 next={...next,version:state.version+1};await copyFile(statePath,path.join(DATA,'state.previous.json'));
 await writeFile(statePath+'.tmp',JSON.stringify(next,null,2));await rename(statePath+'.tmp',statePath);state=next;return state;
}
const workflow=await createWorkflowApi({dataDir:DATA,getState:()=>state,commitState,serial});
export const server=http.createServer(async(req,res)=>{
 try{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'");
  const host=req.headers.host||'';if(!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))throw fail('Недопустимый адрес сервера',403);
  if(['PUT','POST','DELETE'].includes(req.method)&&req.headers.origin&&req.headers.origin!==`http://${host}`)throw fail('Разрешены только локальные действия приложения',403);
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/api/health')return json(res,200,{ok:true,source:'local',schemaVersion:1});
  if(/^\/api\/(agent|imports|evaluations|feedback)(\/|$)/.test(url.pathname)){
   const result=await workflow({url,method:req.method,input:req.method==='POST'?await body(req):undefined});
   if(result!==undefined)return json(res,200,result);
  }
  if(url.pathname==='/api/shutdown'&&req.method==='POST'){
   json(res,200,{message:'Локальный сервер остановлен'});
   await mutation;server.close(()=>process.exit(0));return;
  }
  if(url.pathname==='/api/state'&&req.method==='GET')return json(res,200,state);
  if(url.pathname==='/api/state'&&req.method==='PUT'){
   const input=await body(req);
   return await serial(async()=>{
    if(input.expectedVersion!==state.version)return json(res,409,{message:'База изменена в другом окне. Обновите страницу перед сохранением.',version:state.version});
    validate(input.state);
    validateChanges(state,input.state,req.headers['x-demo-role']||'rd');
    const next={...input.state,version:state.version+1};
    await copyFile(statePath,path.join(DATA,'state.previous.json'));
    await writeFile(statePath+'.tmp',JSON.stringify(next,null,2));await rename(statePath+'.tmp',statePath);state=next;
    return json(res,200,state);
   });
  }
  if(url.pathname==='/api/attachments'&&req.method==='POST'){
   const input=await body(req);
   if(!state.products.find(p=>p.id===input.productId)?.revisions.some(r=>r.id===input.revisionId))throw fail('Редакция вложения не найдена');
   const ext=path.extname(input.name||'').toLowerCase();const allowed={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
   if(!allowed[ext])throw fail('Допустимы PDF, PNG, JPG, TXT, CSV, JSON, DOCX, XLSX');
   if(typeof input.base64!=='string'||!input.base64.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))throw fail('Неверное содержимое файла');
   const bytes=Buffer.from(input.base64,'base64');if(bytes.length>10*1024*1024)throw fail('Файл превышает 10 МБ',413);
   const id=randomUUID(),name=path.basename(input.name).replace(/[\r\n]/g,'');
   const d={id,name,type:allowed[ext],size:bytes.length,productId:input.productId,revisionId:input.revisionId,documentType:String(input.documentType||'Прочее'),createdAt:new Date().toISOString(),sha256:createHash('sha256').update(bytes).digest('hex'),url:'/api/attachments/'+id,status:'Локальное вложение; антивирусная проверка не подключена'};
   await writeFile(path.join(DATA,'attachments',id+'.bin'),bytes);await writeFile(path.join(DATA,'attachments',id+'.json'),JSON.stringify(d));return json(res,201,d);
  }
  if(url.pathname.startsWith('/api/attachments/')&&req.method==='GET'){
   const id=url.pathname.split('/').pop();if(!/^[\da-f-]{36}$/.test(id))throw fail('Вложение не найдено',404);
   let d;try{d=JSON.parse(await readFile(path.join(DATA,'attachments',id+'.json'),'utf8'));}catch{throw fail('Вложение не найдено',404);}
   const bytes=await readFile(path.join(DATA,'attachments',id+'.bin'));
   res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");res.setHeader('Content-Type',d.type);
   res.setHeader('Content-Disposition',`${['application/pdf','image/png','image/jpeg','text/plain'].includes(d.type)?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`);res.writeHead(200);return res.end(bytes);
  }
  if(req.method!=='GET')throw fail('Действие недоступно',405);
  const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!PUBLIC.has(file))throw fail('Страница не найдена',404);
  const bytes=await readFile(path.join(ROOT,file));res.writeHead(200,{'Content-Type':mime[path.extname(file)],'Cache-Control':'no-cache'});res.end(bytes);
 }catch(e){json(res,e.status||500,{message:e.status?e.message:'Ошибка локального хранилища. Подробности в окне сервера.'});if(!e.status)console.error(e);}
});
const port=Number(process.env.PORT||4173);
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Порт ${port} уже занят. Откройте http://127.0.0.1:${port}, если приложение уже запущено, или задайте другой PORT.`:e.message);process.exitCode=1;});
validate(state);
server.listen(port,'127.0.0.1',()=>{
 const address=`http://127.0.0.1:${server.address().port}`;
 console.log(`Цифровой продукт: ${address}\nОстановка: Ctrl+C. Данные: ${DATA}`);
 if(process.argv.includes('--open'))spawn('cmd.exe',['/c','start','',address],{windowsHide:true,stdio:'ignore'}).unref();
});
process.on('SIGINT',()=>{server.close(async()=>{await mutation;process.exit(0);});});
