import {validateRevision} from './domain.js';
// Единственная граница источника данных. Реализован только локальный источник.
// Будущий адаптер должен возвращать тот же нормализованный контракт.
async function request(url,options={}){
 let response;
 try{response=await fetch(url,{...options,headers:{'Content-Type':'application/json',...options.headers}});}catch{throw Error('Локальный сервер недоступен. Запустите приложение и повторите действие.');}
 const result=await response.json();
 if(!response.ok)throw Object.assign(Error(result.message||'Не удалось выполнить действие'),{status:response.status});
 return result;
}
export const localSource={
 kind:'local',
 loadState:()=>request('/api/state'),
 saveState:(state,role='rd')=>request('/api/state',{method:'PUT',headers:{'X-Demo-Role':role},body:JSON.stringify({expectedVersion:state.version,state})}),
 uploadAttachment:payload=>request('/api/attachments',{method:'POST',body:JSON.stringify(payload)})
};
export const loadState=(...args)=>localSource.loadState(...args);
export const saveState=(...args)=>localSource.saveState(...args);
export const uploadAttachment=(...args)=>localSource.uploadAttachment(...args);
export function importProducts(state,input){
 if(!input||input.schemaVersion!==1||!Array.isArray(input.products)||!input.products.length)throw Error('Ожидается JSON {schemaVersion:1, products:[...]}. Экспортируйте библиотеку для образца.');
 const next=structuredClone(state),ids=new Set(next.products.map(p=>p.id)),codes=new Set(next.products.map(p=>p.code)),rids=new Set(next.products.flatMap(p=>p.revisions.map(r=>r.id)));
 for(const p of input.products){
  if(!p.id||!p.code||typeof p.title!=='string'||!p.title.trim()||!Array.isArray(p.tags)||!Array.isArray(p.revisions)||!p.revisions.length)throw Error('Каждому продукту нужны id, code, title, tags и непустые revisions.');
  if(ids.has(p.id)){
   const existing=next.products.find(x=>x.id===p.id);
   if(JSON.stringify(existing)===JSON.stringify(p))continue;
   throw Error('ID '+p.id+' уже существует с другим содержимым. Для нового продукта задайте уникальные id и code.');
  }
  if(codes.has(p.code))throw Error('Код '+p.code+' уже используется.');
  for(const r of p.revisions){const errors=validateRevision(r);if(errors.length)throw Error(p.title+': '+errors.join('; '));if(!r.id||rids.has(r.id))throw Error('Редакции должны иметь уникальные ID.');rids.add(r.id);if(r.approval?.status&&!['preparation'].includes(r.approval.status))throw Error('Импортировать можно только редакции в подготовке. Решения не переносятся из JSON.');}
  next.products.push(structuredClone(p));ids.add(p.id);codes.add(p.code);
 }
 return next;
}
