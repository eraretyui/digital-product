import {physicalInput} from './domain.js';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const deny=m=>{throw Object.assign(Error(m),{status:403});};
// Демо-роли проверяют маршрут; они не являются системой аутентификации.
export function validateChanges(before,after,role='rd'){
 const roles=['rd','technologist','quality','chief','viewer'];
 if(!roles.includes(role))deny('Неизвестная демонстрационная роль');
 if(role==='viewer'&&!same(before,after))deny('Наблюдатель не может изменять данные');
 for(const p of after.products.filter(x=>!before.products.some(p=>p.id===x.id)))for(const r of p.revisions){
  if(!['preparation',undefined].includes(r.approval?.status)||r.approval?.recipe||r.approval?.quality)deny('Импортированные продукты должны проходить собственный маршрут');
 }
 for(const p of before.products){
  const next=after.products.find(x=>x.id===p.id);if(!next)deny('Удаление существующих продуктов не поддерживается');
  for(const fresh of next.revisions.filter(x=>!p.revisions.some(r=>r.id===x.id))){
   if(!['preparation',undefined].includes(fresh.approval?.status)||fresh.approval?.recipe||fresh.approval?.quality)deny('Новая редакция должна проходить собственный маршрут');
  }
  for(const r of p.revisions){
   const n=next.revisions.find(x=>x.id===r.id);if(!n)deny('Удаление исходных редакций не поддерживается');
   if(!same(physicalInput(r),physicalInput(n))||!same(r.ingredients,n.ingredients)||r.description!==n.description)deny('Состав, спецификации и технология сохранённой редакции неизменяемы. Создайте новую редакцию.');
   const a=r.approval||{status:'preparation'},b=n.approval||{status:'preparation'};
   if(['review','final','approved'].includes(a.status)){
    const {approval:omitA,...snapshotA}=r,{approval:omitB,...snapshotB}=n;
    if(!same(snapshotA,snapshotB))deny('Доказательства отправленного пакета неизменяемы. Создайте новую редакцию.');
    if(!same(before.documents.filter(d=>d.revisionId===r.id),after.documents.filter(d=>d.revisionId===r.id)))deny('Документы отправленного пакета неизменяемы');
   }
   if((a.history||[]).some((h,i)=>!same(h,b.history?.[i])))deny('История решений неизменяема');
   if(same(a,b))continue;
   const old=a.status||'preparation',now=b.status||'preparation';
   if(old==='approved')deny('Зафиксированное решение нельзя изменить');
   const restarting=(old==='returned'&&now==='review')||now==='returned';
   if(!same(a.recipe,b.recipe)&&!restarting){if(old!=='review'||role!=='technologist'||!b.recipe||a.recipe)deny('Проверка рецептуры доступна технологу на этапе проверки');}
   if(!same(a.quality,b.quality)&&!restarting){if(old!=='review'||role!=='quality'||!b.quality||a.quality)deny('Проверка качества доступна специалисту качества на этапе проверки');}
   if(now==='returned'){
    if(!['review','final'].includes(old)||!['technologist','quality','chief'].includes(role))deny('Возврат недоступен в этом состоянии');
    const last=b.history?.at(-1);if(!String(last?.reason||last?.comment||'').trim())deny('Для возврата требуется причина');
   }else if(old!==now){
    if(['preparation','returned'].includes(old)&&now==='review'){
     if(!['rd','technologist'].includes(role))deny('Отправка доступна R&D или технологу');
     if(!b.packageSnapshot||!b.packageHash||!b.runId)deny('Для отправки нужен снимок пакета');
    }else if(old==='review'&&now==='final'){
     if(!b.recipe||!b.quality||b.recipe.decision!=='approved'||b.quality.decision!=='approved')deny('Нужны положительные решения обеих проверок');
    }else if(old==='final'&&now==='approved'){
     if(role!=='chief'||a.recipe?.decision!=='approved'||a.quality?.decision!=='approved')deny('Итоговое решение доступно главному технологу после двух проверок');
     if(!b.approvedAt||next.approvedRevisionId!==r.id)deny('Фиксация должна сохранять дату и утверждённую редакцию');
    }else deny('Недопустимый переход маршрута');
   }
   if(['review','final'].includes(old)&&now!=='returned'&&(!same(a.packageSnapshot,b.packageSnapshot)||a.packageHash!==b.packageHash||a.runId!==b.runId))deny('Пакет текущего маршрута неизменяем');
  }
 }
}
