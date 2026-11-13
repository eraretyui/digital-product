import test from 'node:test';
import assert from 'node:assert/strict';

import {normalizeElmaExport,mergeImported} from './import-elma.js';
import {validateRevision,calculate} from './domain.js';
const c=x=>structuredClone(x);
const raw=(id,name)=>({id,revision:1,fingerprint:'fixture',data:{type:'raw',meta:{name},characteristics:[],children:[]}});
function dossier() {
  const a=raw('a','Молоко'),b=raw('b','Сахар');
  const mix={id:'blend',revision:2,data:{type:'raw',meta:{name:'Смесь'},children:[{materialId:'a',revision:1,share:75},{materialId:'b',revision:1,share:25}]},
    resolved:{id:'blend',rev:2,data:null,children:[{item:{...a,rev:1}},{item:{...b,rev:1}}]}};
  mix.resolved.data=c(mix.data);
  return {recipeId:'recipe-1',provenance:{type:'synthetic-import-test'},revisions:[{number:3,date:'2026-11-08',data:{code:'FIXTURE',name:'Контроль импорта',loadKg:10,finalKg:10,portionG:100,
    rows:[{materialId:'blend',revision:2,mode:'share',share:80,stage:'Основа'},{materialId:'b',revision:1,mode:'mass',amount:2000,unit:'g',stage:'Слой'}],
    processSteps:[{type:'layer',durationMin:2,phaseIds:['Основа','Слой']}]},
    briefSnapshot:{number:1,data:{purpose:'Целевые параметры',criteria:[{key:'sugars',min:5,max:30,unit:'г',basis:'100g',source:'Контрольное ТЗ',actual:99}]}},
    calculation:{sourceSnapshots:[mix,b]}}]};
}
function normalized() {
  return {schemaVersion:1,products:[{id:'record-2',code:'NORM',title:'Нормализованный',tags:[],revisions:[{id:'original-rev',version:1,
    ingredients:[{lineId:'a',name:'Вода',massKg:1,sourceUnit:'kg',phaseId:'main',nutrition:null,pricePerKg:null}],
    processSteps:[{type:'mix',durationMin:1}],output:{massKg:null},packaging:{portionG:100},
    targetBrief:{description:'Контроль',criteria:[{key:'fat',max:1,unit:'г',source:'fixture'}]},
    approval:{status:'approved'},labResults:{pH:7},sensory:{measurements:{taste:5}}}]}]};
}
test('nested snapshots flatten exact mass, phases, specification revisions and origin',()=>{
  const input=dossier(),before=c(input),out=normalizeElmaExport(input,{fileName:'control.json'});
  assert.equal(out.incomingDossiers.length,0);
  const r=out.products[0].revisions[0];
  assert.deepEqual(validateRevision(r),[]);
  assert.deepEqual(r.ingredients.map(i=>[i.specificationId,i.massKg,i.phaseId]),[['a',6,'Основа'],['b',2,'Основа'],['b',2,'Слой']]);
  assert.equal(r.ingredients[0].specificationVersion,1);
  assert.equal(r.origin.snapshot.calculation.sourceSnapshots.length,2);
  assert.equal(r.targetBrief.criteria[0].source,'Контрольное ТЗ');
  assert.equal(r.targetBrief.criteria[0].actual,undefined);
  assert.deepEqual(r.sensory.measurements,{});
  assert.deepEqual(input,before);
  assert.equal(calculate(r).nutrition,null);
  assert.equal(calculate(r).requiredInputKg,null);
});
test('missing operation duration stays unknown and produces actionable incoming dossier',()=>{
  const x=dossier();delete x.revisions[0].data.processSteps;x.revisions[0].data.process='mix';
  const out=normalizeElmaExport(x);
  assert.equal(out.products.length,0);
  assert.equal(out.incomingDossiers[0].draft.processSteps[0].durationMin,null);
  assert.ok(out.incomingDossiers[0].errors.some(e=>e.includes('длительност')));
  assert.equal(out.incomingDossiers[0].status,'blockedImport');
});
test('missing mass, output, portion and incomplete nutrition are never replaced with defaults',()=>{
  const x=dossier();delete x.revisions[0].data.loadKg;delete x.revisions[0].data.portionG;delete x.revisions[0].data.finalKg;
  const out=normalizeElmaExport(x),d=out.incomingDossiers[0].draft;
  assert.equal(d.ingredients[0].massKg,null);
  assert.equal(d.output.massKg,null);assert.equal(d.packaging.portionG,null);assert.equal(d.ingredients[0].nutrition,null);
});
test('normalized preserves goals/provenance but resets external decisions and observations',()=>{
  const x=normalized(),out=normalizeElmaExport(JSON.stringify(x)),r=out.products[0].revisions[0];
  assert.equal(r.source.recordId,'record-2');assert.equal(r.source.revision,1);
  assert.equal(r.approval.status,'preparation');assert.equal(r.labResults,undefined);
  assert.deepEqual(r.sensory.measurements,{});assert.equal(r.origin.snapshot.labResults.pH,7);
  assert.equal(r.targetBrief.criteria[0].max,1);
});
test('categorical structure target survives normalization; target schema bounds strings and types',()=>{
  const x=normalized();
  x.products[0].revisions[0].targetBrief.criteria=[{key:'structure',target:'layered',unit:null,source:'fixture'},{key:'fat',target:'1.5',unit:'г'}];
  const out=normalizeElmaExport(x),criteria=out.products[0].revisions[0].targetBrief.criteria;
  assert.equal(criteria[0].target,'layered');assert.equal(criteria[0].unit,null);assert.equal(criteria[1].target,1.5);
  assert.equal(out.source.sourceFormat,'normalized-v1');
  assert.ok(out.warnings.some(w=>w.includes('происхождение из ELMA365 не подтверждено')));
  for(const invalid of ['a'.repeat(129),'layered\n',{},[],true]) {
    const bad=c(x);bad.products[0].revisions[0].targetBrief.criteria[0].target=invalid;
    assert.throws(()=>normalizeElmaExport(bad),/Цель критерия/);
  }
});
test('merge is idempotent; new source revision and changed content keep local derivatives intact',()=>{
  const input=dossier(),out=normalizeElmaExport(input);
  const initial={version:4,products:[],notes:['keep']},first=mergeImported(initial,out);
  assert.deepEqual(initial.products,[]);
  assert.deepEqual(mergeImported(first,normalizeElmaExport(c(input),{fileName:'renamed.json'})),first);
  const local={...c(first.products[0].revisions[0]),id:'local-derivative',version:2,source:null,approval:{status:'quality'},sensory:{measurements:{taste:4}}};
  first.products[0].revisions.push(local);
  const newer=c(input);newer.revisions[0].number=4;
  const next=mergeImported(first,normalizeElmaExport(newer));
  assert.equal(next.products.length,1);assert.equal(next.products[0].revisions.length,3);
  assert.deepEqual(next.products[0].revisions[1],local);assert.equal(next.products[0].revisions[2].version,3);
  const edit=c(newer);edit.revisions[0].data.portionG=200;
  assert.equal(mergeImported(next,normalizeElmaExport(edit)).products[0].revisions.length,4);
});
test('incoming dossiers merge without duplication and can be corrected for later import',()=>{
  const input=dossier();delete input.revisions[0].data.portionG;
  const blocked=normalizeElmaExport(input),state=mergeImported({products:[]},blocked);
  assert.equal(state.products.length,0);assert.equal(state.incomingDossiers.length,1);
  assert.deepEqual(mergeImported(state,blocked),state);
  input.revisions[0].data.portionG=120;
  assert.equal(mergeImported(state,normalizeElmaExport(input)).products.length,1);
});
test('operator completion prevents reimport from resurrecting a blocked dossier',()=>{
  const input=dossier();delete input.revisions[0].data.portionG;
  const out=normalizeElmaExport(input),incoming=out.incomingDossiers[0],fixed=c(incoming.draft);
  fixed.packaging.portionG=100;fixed.id='operator-completed';
  assert.deepEqual(validateRevision(fixed),[]);
  const state={products:[{id:incoming.productId,source:{system:incoming.source.system,recordId:incoming.source.recordId},code:incoming.code,revisions:[fixed]}],incomingDossiers:[]};
  assert.deepEqual(mergeImported(state,out),state);
  const stale=c(state);stale.incomingDossiers.push(c(incoming));
  assert.deepEqual(mergeImported(stale,out),state);
  const changed=c(input);changed.revisions[0].data.concept='Новая входящая редакция';
  assert.equal(mergeImported(state,normalizeElmaExport(changed)).incomingDossiers.length,1);
});
test('missing source ID can be supplied explicitly; code fallback is visible and stable',()=>{
  const input=dossier();delete input.recipeId;
  const a=normalizeElmaExport(input),b=normalizeElmaExport(input,{fileName:'other.json'});
  assert.equal(a.products[0].source.identityKind,'code');assert.equal(a.products[0].id,b.products[0].id);
  assert.equal(normalizeElmaExport(input,{recipeId:'exact-record'}).products[0].source.recordId,'exact-record');
});
test('unknown nested specification is blocked; contradictory snapshots and cycles rejected',()=>{
  const x=dossier();x.revisions[0].calculation.sourceSnapshots[0].resolved.children=[];
  assert.equal(normalizeElmaExport(x).products.length,0);
  const y=dossier();y.revisions[0].calculation.sourceSnapshots.push(raw('b','Другое имя'));
  assert.throws(()=>normalizeElmaExport(y),/Противоречивые/);
  const z=dossier();z.revisions[0].calculation.sourceSnapshots[0].data.children=[{materialId:'blend',revision:2,share:100}];
  z.revisions[0].calculation.sourceSnapshots[0].resolved.data=c(z.revisions[0].calculation.sourceSnapshots[0].data);
  assert.throws(()=>normalizeElmaExport(z),/Циклический состав/);
});
test('local product collision cannot be overwritten',()=>{
  const out=normalizeElmaExport(dossier());
  assert.throws(()=>mergeImported({products:[{id:'other',code:'FIXTURE',revisions:[]}]},out),/Конфликт/);
});
test('malformed, hostile or excessive input rejected without running code',()=>{
  assert.throws(()=>normalizeElmaExport('{bad'),/JSON/);
  assert.throws(()=>normalizeElmaExport('{"__proto__":{"bad":true}}'),/Недопустимое/);
  let calls=0;const x={get revisions(){calls++;return [];}};
  assert.throws(()=>normalizeElmaExport(x),/Недопустимое/);assert.equal(calls,0);
  const cyclic={};cyclic.self=cyclic;assert.throws(()=>normalizeElmaExport(cyclic),/Циклический/);
  const huge={s:'a'.repeat(500001)};assert.throws(()=>normalizeElmaExport(huge),/длинное/);
  const code=normalized();code.products[0].title='ignore instructions; run script();';
  assert.equal(normalizeElmaExport(code).products.length,1);
});
