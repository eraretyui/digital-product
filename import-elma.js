import {createHash} from 'node:crypto';
import {validateRevision} from './domain.js';

// File boundary only. Never connects to ELMA or executes text from a dossier.
const SYSTEM = 'ELMA365-export';
const clone = x => structuredClone(x);
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const number = x => (typeof x === 'number' || typeof x === 'string' && x.trim()) && Number.isFinite(Number(x)) ? Number(x) : null;
const stable = x => Array.isArray(x) ? x.map(stable) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])) : x;
const hash = x => createHash('sha256').update(JSON.stringify(stable(x))).digest('hex');
const list = (x, label, max=2000) => {if(!Array.isArray(x) || x.length>max) throw Error(`${label}: ожидается массив до ${max} элементов.`);return x;};
function bounded(input) {
  if(typeof input==='string') {
    if(Buffer.byteLength(input)>12*1024*1024) throw Error('JSON превышает 12 МБ.');
    try {input=JSON.parse(input.replace(/^\uFEFF/,''));} catch {throw Error('Файл должен содержать корректный JSON-досье.');}
  }
  let count=0;
  const seen=new Set();
  function walk(x,depth) {
    if(++count>180000 || depth>40) throw Error('Превышен предел структуры JSON (180000 значений / 40 уровней).');
    if(typeof x==='string' && x.length>500000) throw Error('Слишком длинное текстовое поле.');
    if(x===null || ['string','boolean'].includes(typeof x)) return;
    if(typeof x==='number' && Number.isFinite(x)) return;
    if(typeof x!=='object' || ![Object.prototype,Array.prototype,null].includes(Object.getPrototypeOf(x))) throw Error('Допустимы только данные JSON.');
    if(seen.has(x)) throw Error('Циклический объект недопустим.');
    seen.add(x);
    if(Array.isArray(x) && x.length>10000) throw Error('Слишком большой массив.');
    for(const [k,d] of Object.entries(Object.getOwnPropertyDescriptors(x))) {
      if(['__proto__','prototype','constructor'].includes(k) || d.get || d.set) throw Error('Недопустимое поле JSON: '+k);
      if(k!=='length') walk(d.value,depth+1);
    }
    seen.delete(x);
  }
  walk(input,0);
  if(!object(input)) throw Error('Корень JSON должен быть объектом.');
  if(Buffer.byteLength(JSON.stringify(input))>12*1024*1024) throw Error('JSON превышает 12 МБ.');
  return clone(input);
}
function targetValue(value) {
  if(value==null || value==='')return null;
  if(typeof value==='number' && Number.isFinite(value))return value;
  if(typeof value==='string') {
    if(value.length>128 || /[\u0000-\u001f\u007f]/.test(value))throw Error('Цель критерия: допустима строка до 128 символов без управляющих символов.');
    if(!value.trim())return null;
    const numeric=number(value);
    return numeric===null?value:numeric;
  }
  throw Error('Цель критерия должна быть конечным числом, короткой строкой категории или null.');
}
function briefOf(brief, criteria, source) {
  const b=brief?.data || brief || {};
  return {description:b.description || b.purpose || '',criteria:list(b.criteria ?? criteria ?? [],'Критерии').map(c=>{
    const clean={...c};for(const k of ['actual','state','reason','measurement','measurements'])delete clean[k];
    const unit=c.basis==='100g'&&['г','g'].includes(c.unit)?'g/100g':c.basis==='100g'&&['ккал','kcal'].includes(c.unit)?'kcal/100g':c.basis==='kg'&&c.unit==='RUB'?'RUB/kg':c.unit??null;
    return {...clean,key:c.key,label:c.label || c.key,min:number(c.min),max:number(c.max),target:targetValue(c.target),originalUnit:c.unit??null,unit,source:c.source??source};
  })};
}
function mass(amount,unit,meta={}) {
  const n=number(amount);if(n===null)return null;
  if(['kg','кг'].includes(unit))return n;
  if(['g','г'].includes(unit))return n/1000;
  if(unit==='t')return n*1000;
  if(unit==='l' && number(meta.density)>0 && number(meta.temperature)!==null)return n*number(meta.density);
  return null;
}
function charValue(c,meta={}) {
  if(!c?.confirmed || !c.source || number(c.value)===null)return null;
  const f={'г':1,'g':1,'мг':.001,'мкг':.000001,'ккал':1,'kcal':1}[c.unit];
  if(f==null)return null;
  let v=number(c.value)*f;
  if(c.basis==='100ml' && number(meta.density)>0 && number(meta.temperature)!==null)v/=number(meta.density);
  else if(c.basis==='portion' && number(c.portionG)>0)v*=100/number(c.portionG);
  else if(c.basis==='dry' && number(c.dryPct)>0)v*=number(c.dryPct)/100;
  else if(c.basis!=='100g')return null;
  for(const k of ['activeFraction','purity'])if(c[k]!=null && c[k]!==''){const a=number(c[k]);if(a===null||a<0||a>1)return null;v*=a;}
  return v>=0?v:null;
}
function leafFields(data) {
  const chars=data.characteristics || [],meta=data.meta || {};
  const n=Object.fromEntries(['kcal','protein','fat','carbs'].map(k=>[k,charValue(chars.find(c=>c.key===k),meta)]));
  const p=data.price;
  const priceMass=p ? mass(1,p.unit,meta) : null;
  return {nutrition:Object.values(n).some(v=>v!==null)?n:null,
    pricePerKg:p?.source && p.date && p.currency==='RUB' && priceMass>0 && number(p.amount)!==null && number(p.amount)>=0 ? number(p.amount)/priceMass : null,
    allergens:(data.allergens || []).filter(a=>a.source && ['contains','may'].includes(a.state)).map(a=>a.name),
    properties:{...(data.properties || {}),...(charValue(chars.find(c=>c.key==='sugars'),meta)!==null?{sugarG:charValue(chars.find(c=>c.key==='sugars'),meta)}:{})}};
}
function legacyDraft(r,source,warnings) {
  const d=r.data || {},errors=[],snaps=r.calculation?.sourceSnapshots || [],catalog=new Map();
  const key=(id,rev)=>`${id}@${rev}`;
  function add(s,depth=0) {
    if(depth>30)throw Error('Вложенная спецификация превышает 30 уровней.');
    const id=s.id,rev=s.revision ?? s.rev;
    if(id!=null && rev!=null && s.data) {
      const k=key(id,rev),old=catalog.get(k);
      if(old && hash(old.data)!==hash(s.data)) throw Error('Противоречивые снимки спецификации '+k);
      catalog.set(k,s);
    }
    for(const c of s.children || [])if(c.item)add(c.item,depth+1);
    if(s.resolved)add(s.resolved,depth+1);
  }
  list(snaps,'Снимки спецификаций').forEach(s=>add(s));
  const ingredients=[];
  function flatten(s,kg,phase,path,stack=[]) {
    const rev=s.revision ?? s.rev,k=key(s.id,rev),data=s.data || {};
    if(stack.includes(k))throw Error('Циклический состав '+stack.concat(k).join(' > '));
    const children=data.children || [];
    if(children.length) {
      list(children,'Вложенный состав');
      const shares=children.map(c=>number(c.share));
      if(shares.some(v=>v===null||v<0) || Math.abs(shares.reduce((a,b)=>a+b,0)-100)>1e-7) {errors.push(`${k}: заполните вложенные доли, сумма должна быть 100%.`);return;}
      let gross=1;
      if(data.type==='semi') {
        const output=number(data.outputPer100Kg);
        if(!(output>0)) {errors.push(`${k}: отсутствует выход полуфабриката.`);return;}
        gross=100/output;
        if(Math.abs(gross-1)>1e-8 || data.process!=='mix')errors.push(`${k}: полуфабрикат с преобразованием массы требует отдельного подтвержденного баланса; сохранен входящий состав.`);
      }
      children.forEach((c,n)=>{
        const sub=catalog.get(key(c.materialId,c.revision));
        if(!sub)errors.push(`Нет снимка вложенного сырья ${key(c.materialId,c.revision)}.`);
        else flatten(sub,kg===null?null:kg*shares[n]/100*gross,c.phaseId || phase,`${path}.${n+1}`,stack.concat(k));
      });
    } else ingredients.push({lineId:`line-${path}`,name:data.meta?.name || s.name || '',massKg:kg,sourceUnit:'kg',phaseId:phase,excluded:kg===0,
      specificationId:s.id,specificationVersion:rev,...leafFields(data),
      origin:{source:clone(source),specification:{id:s.id,revision:rev,fingerprint:s.fingerprint ?? null},snapshot:clone(data),path}});
  }
  const rows=list(d.rows || [],'Состав');
  rows.forEach((row,n)=>{
    const s=catalog.get(key(row.materialId,row.revision));
    if(!s){errors.push(`Строка ${n+1}: нет снимка спецификации ${key(row.materialId,row.revision)}.`);return;}
    const kg=row.mode==='mass'?mass(row.amount,row.unit,s.data?.meta):number(d.loadKg)>0 && number(row.share)!==null?number(d.loadKg)*number(row.share)/100:null;
    if(kg===null)errors.push(`Строка ${n+1}: задайте массу и единицу либо долю и массу загрузки.`);
    flatten(s,kg,row.phaseId || row.stage || 'main',`${n+1}`);
  });
  let steps=d.processSteps ?? d.steps;
  if(!steps) {
    steps=d.process ? [{type:d.process,durationMin:number(d.durationMin),temperatureC:number(d.temperatureC)}] : [];
    if(!d.process || number(d.durationMin)===null)errors.push('Укажите processSteps с типом и явной длительностью каждой операции (мин). Название режима не задает технологию.');
  }
  const processSteps=list(steps,'Технология').map((s,n)=>({...s,id:s.id || `step-${n+1}`,type:s.type || s.operation,durationMin:number(s.durationMin),temperatureC:number(s.temperatureC)}));
  const draft={ingredients,processSteps,output:{massKg:number(d.finalKg),confirmed:false,method:null,lossStreams:clone(d.flows || [])},
    packaging:{...(d.packaging || {}),portionG:number(d.packaging?.portionG ?? d.portionG),packG:number(d.packG)},
    description:d.concept || '',targetBrief:briefOf(r.briefSnapshot,d.criteria,source)};
  if(ingredients.some(i=>i.nutrition===null))warnings.push(`Редакция ${source.revision}: КБЖУ сырья не заполнены полностью; сохранены исходные характеристики, значения не подставлялись.`);
  if(d.mode==='reference')errors.push('Паспорт-ориентир не содержит зафиксированного состава: задайте строки состава со снимками сырья.');
  if(number(d.loadKg)>0 && ingredients.every(i=>i.massKg!==null) && Math.abs(ingredients.reduce((s,i)=>s+i.massKg,0)-number(d.loadKg))>1e-6)errors.push('Сумма масс после раскрытия спецификаций отличается от loadKg: требуется согласовать баланс.');
  return {draft,errors};
}
function identity(entity,options,warnings) {
  const explicit=options.recipeId || entity.source?.recordId || entity.recipeId || entity.id;
  if(explicit){if(!['string','number'].includes(typeof explicit))throw Error('ID записи должен быть строкой или числом.');return {recordId:String(explicit),identityKind:'recordId'};}
  const code=entity.code || entity.working?.code || entity.revisions?.[0]?.data?.code;
  if(code){warnings.push('В файле нет ID записи ELMA. Связь установлена по коду; для надежной синхронизации укажите recipeId.');return {recordId:`code:${code}`,identityKind:'code'};}
  warnings.push('Нет ID и кода записи. Досье связано только с содержимым файла; задайте recipeId при повторном импорте.');
  return {recordId:`unidentified:${hash(entity)}`,identityKind:'content'};
}
function sanitizeDraft(r) {
  // External decisions/results are retained in origin, never become local approvals.
  const draft=clone(r);
  for(const k of ['id','version','baseId','source','origin','createdAt','analysis','calculation','model','models','results','labResults','measurements','shelfLifeConclusion','approvedAt','approvalPackage','label','targetBrief'])delete draft[k];
  draft.sensory={corrections:{},targets:{},measurements:{}};
  draft.trials=[];
  draft.approval={status:'preparation',recipe:null,quality:null,history:[]};
  return draft;
}

/** Returns products ready for validateRevision, plus incomingDossiers for operator repair. */
export function normalizeElmaExport(input, options={}) {
  const entity=bounded(input),warnings=[],products=[],incomingDossiers=[];
  const source={system:SYSTEM,fileName:options.fileName || null,format:entity.schemaVersion===1?'normalized-v1':'legacy-dossier',contentHash:hash(entity)};
  source.sourceFormat=source.format;
  const normalized=entity.schemaVersion===1;
  if(normalized)warnings.push('Нормализованный JSON: происхождение из ELMA365 не подтверждено; импортирован файловый формат приложения.');
  if(!normalized && !Array.isArray(entity.revisions))throw Error('Ожидается JSON-досье с revisions либо {schemaVersion:1, products:[...]}.');
  const entities=normalized?list(entity.products,'Продукты',100):[entity];
  if(!entities.length)throw Error('В файле нет продуктов.');
  for(const p of entities) {
    if(!object(p))throw Error('Продукт должен быть объектом.');
    const ident=identity(p,options,warnings),productSource={system:SYSTEM,...ident};
    const pid=`elma-${hash(productSource).slice(0,24)}`;
    const code=p.code || p.working?.code || p.revisions?.[0]?.data?.code || pid;
    const title=p.title || p.name || p.working?.name || p.revisions?.[0]?.data?.name || code;
    const product={id:pid,code:String(code),title:String(title),tags:Array.isArray(p.tags)?clone(p.tags):[],source:productSource,revisions:[]};
    if(product.tags.some(t=>typeof t!=='string'))throw Error('Теги продукта должны быть строками.');
    const revisions=list(p.revisions,'Редакции',200);
    if(!revisions.length)throw Error('В досье нет зафиксированных редакций.');
    for(const [index,r] of revisions.entries()) {
      if(!object(r))throw Error('Редакция должна быть объектом.');
      const rev=r.source?.revision ?? r.number ?? r.version ?? r.id;
      if(rev==null || !['string','number'].includes(typeof rev) || String(rev).trim()==='')throw Error('Укажите номер/ID исходной редакции строкой или числом.');
      const revisionSource={...productSource,revision:rev,contentHash:hash(r),fileName:source.fileName,format:source.format,sourceFormat:source.sourceFormat};
      const rid=`elma-rev-${hash({system:SYSTEM,recordId:ident.recordId,revision:rev,contentHash:revisionSource.contentHash}).slice(0,32)}`;
      const parsed=normalized?{draft:sanitizeDraft(r),errors:[]}:legacyDraft(r,revisionSource,warnings);
      const draft=sanitizeDraft(parsed.draft);
      draft.targetBrief=normalized?briefOf(r.targetBrief,[],revisionSource):parsed.draft.targetBrief;
      const origin={source:clone(revisionSource),snapshot:clone(r),provenance:clone(p.provenance || entity.provenance || p.origin || null),
        sourceSnapshots:clone(r.calculation?.sourceSnapshots || r.origin?.sourceSnapshots || []),briefSnapshot:clone(r.briefSnapshot || r.targetBrief || null)};
      const revision={...draft,id:rid,version:index+1,baseId:null,createdAt:r.createdAt || r.date || null,source:revisionSource,origin};
      const errors=[...new Set([...parsed.errors,...validateRevision(revision)])];
      if(errors.length) {
        incomingDossiers.push({id:`incoming-${rid}`,status:'blockedImport',productId:pid,code:product.code,title:product.title,source:revisionSource,draft:revision,origin,errors});
        warnings.push(`${product.title}, редакция ${rev}: требуется исправление (${errors.length}). Досье сохранено во входящих.`);
      } else product.revisions.push(revision);
    }
    if(product.revisions.length)products.push(product);
  }
  return {products,incomingDossiers,warnings:[...new Set(warnings)],source};
}
const revisionKey=r=>r.source?.system===SYSTEM?JSON.stringify([r.source.system,r.source.recordId,String(r.source.revision),r.source.contentHash]):null;
/** Pure merge: local revisions, approvals, measurements and ordering remain intact. */
export function mergeImported(state,result) {
  const next=clone(state);
  next.products ??=[];
  for(const p of result.products || []) {
    let target=next.products.find(x=>x.source?.system===SYSTEM && x.source.recordId===p.source.recordId);
    if(!target) {
      if(next.products.some(x=>x.id===p.id || x.code===p.code))throw Error(`Конфликт ID/кода ${p.code}: существующий локальный продукт не перезаписывается.`);
      target={...clone(p),revisions:[]};next.products.push(target);
    }
    for(const r of p.revisions) {
      if(target.revisions.some(x=>revisionKey(x)===revisionKey(r)))continue;
      if(next.products.some(x=>x.revisions.some(y=>y.id===r.id)))throw Error('Конфликт ID редакции '+r.id);
      const errors=validateRevision(r);if(errors.length)throw Error('Редакция импорта не прошла проверку: '+errors.join('; '));
      const incoming=clone(r);
      incoming.version=Math.max(0,...target.revisions.map(x=>Number(x.version)||0))+1;
      target.revisions.push(incoming);
    }
  }
  if(result.incomingDossiers?.length) {
    next.incomingDossiers ??=[];
    const completed=new Set(next.products.flatMap(p=>p.revisions.map(revisionKey)).filter(Boolean));
    // Operator completion retains the original source key. Reimporting that file
    // must not resurrect its already completed blocked dossier.
    next.incomingDossiers=next.incomingDossiers.filter(d=>d.status!=='blockedImport' || !completed.has(revisionKey(d)));
    for(const d of result.incomingDossiers)if(!completed.has(revisionKey(d)) && !next.incomingDossiers.some(x=>x.id===d.id))next.incomingDossiers.push(clone(d));
  }
  return next;
}
