import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate,analyze,physicalInput,createRevision,validateRevision,SENSORY_GROUPS,SCENARIOS} from './domain.js';
import {createSeedState} from './seeds.js';
const seeds=()=>createSeedState();
const rev=(n=1)=>seeds().products[n].revisions[0];
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('all three seed revisions validate and isolated state factories',()=>{
  for(const p of seeds().products) assert.deepEqual(validateRevision(p.revisions[0]),[]);
  const a=seeds(),b=seeds(); a.products[0].revisions[0].ingredients[0].massKg=999;
  assert.equal(b.products[0].revisions[0].ingredients[0].massKg,10);
});
test('100 g x 250 is 25 kg composition; sum shares is one',()=>{
  const c=calculate(rev(),{portionG:100,quantity:250});
  near(c.finishedKg,25);near(c.inputKg,1);near(c.requiredInputKg,25);
  near(c.lines.reduce((s,i)=>s+i.share,0),1);near(c.lines.reduce((s,i)=>s+i.batchKg,0),25);
  near(c.lines[0].gramsPerPortion,65);near(c.lines[0].batchKg,16.25);
});
test('cost arithmetic and declared basis',()=>{
  const c=calculate(rev(),{portionG:100,quantity:250});
  const base=.65*280+.15*340+.06*76+.14*210;
  near(c.costInputTotal,base);near(c.costTotal,base*25);near(c.productionCostTotal,base*25);
  assert.equal(c.costComplete,true);
});
test('known nutrition weights per 100 g and scales per portion',()=>{
  const c=calculate(rev(),{portionG:150});
  near(c.nutrition.kcal,.65*121+.15*206+.06*400+.14*32);
  near(c.nutritionPerPortion.protein,c.nutrition.protein*1.5);
  assert.deepEqual(c.allergens,['Молоко']);
});
test('unknown price means partial total, not free ingredient',()=>{
  const r=rev();r.ingredients[0].pricePerKg=null;
  const c=calculate(r,{portionG:1000});
  assert.equal(c.costComplete,false);assert.deepEqual(c.missingPrices,['Творог']);
  assert.equal(c.lines[0].cost,null);near(c.costTotal,.15*340+.06*76+.14*210);
  r.ingredients.forEach(i=>i.pricePerKg=null);assert.equal(calculate(r).costTotal,null);
});
test('known zero price remains zero; missing nutrition is null',()=>{
  const r=rev();r.ingredients.forEach(i=>i.pricePerKg=0);
  const c=calculate(r);assert.equal(c.costComplete,true);assert.equal(c.costTotal,0);
  r.ingredients[0].nutrition=null;assert.equal(calculate(r).nutrition,null);
});
test('drain mass balance separates loading from equivalent; no milk nutrition in cheese',()=>{
  const c=calculate(rev(0),{portionG:150,quantity:10});
  near(c.inputKg,10.03);near(c.outputKg,1.5);near(c.finishedKg,1.5);near(c.requiredInputKg,10.03);
  near(c.lines.reduce((s,i)=>s+i.batchKg,0),1.5);
  near(c.lines.reduce((s,i)=>s+i.productionKg,0),10.03);
  assert.equal(c.nutrition,null);assert.equal(c.costComplete,false);
});
test('unconfirmed yield never becomes procurement loading',()=>{
  const r=rev();r.output.confirmed=false;
  const c=calculate(r,{quantity:250});assert.equal(c.requiredInputKg,null);assert.equal(c.productionCostTotal,null);assert.equal(c.finishedKg,25);
});
test('unclosed drain balance blocks required loading',()=>{
  const r=rev(0);r.output.lossStreams[0].massKg=8;
  assert.match(validateRevision(r).join(' '),/не замкнут/);assert.equal(calculate(r).requiredInputKg,null);
});
test('unknown output and invalid input are not zeros',()=>{
  const r=rev();r.output.massKg=null;
  assert.equal(calculate(r).outputKg,null);assert.equal(calculate(r).requiredInputKg,null);assert.equal(calculate(r).nutrition,null);
  r.ingredients[0].massKg=NaN;assert.equal(calculate(r).inputKg,null);assert.equal(calculate(r).lines[0].share,null);
});
test('quantity validation and negative prices',()=>{
  assert.equal(calculate(rev(),{quantity:1.1}).finishedKg,null);
  assert.equal(calculate(rev(),{portionG:0}).finishedKg,null);
  const r=rev();r.ingredients[0].pricePerKg=-1;assert.ok(validateRevision(r).length);assert.equal(calculate(r).lines[0].cost,null);
});
test('four exact group sizes and no fabricated unknown scores',()=>{
  assert.deepEqual(Object.values(SENSORY_GROUPS).map(a=>a.length),[8,8,8,24]);
  const a=analyze(rev());assert.equal(a.scores['Дымные ноты'],null);assert.equal(a.scores['Длительность послевкусия'],null);
  assert.match(a.limitations[0],/не обученная/);assert.ok(a.formulas['Сладость']);assert.equal(Object.keys(SCENARIOS).length,4);
});
test('structural analysis recognizes all three data-driven cases',()=>{
  assert.equal(analyze(rev(0)).structure,'pressed_cheese');assert.equal(analyze(rev(1)).structure,'layered');assert.equal(analyze(rev(2)).structure,'puree');
});
test('milk and salt without cheese operations do not become cheese',()=>{
  const r=rev(0);r.title='Очень убедительное название сыра';r.processSteps=[];
  assert.equal(analyze(r).structure,'unknown');
});
test('relabeling product and revision leaves physical input and fingerprint unchanged',()=>{
  const r=rev(),input=physicalInput(r),hash=analyze(r).inputHash;
  Object.assign(r,{id:'different',title:'Копчёный сыр',tags:['бренд'],brand:'Brand',description:'Новое имя',version:90});
  assert.deepEqual(physicalInput(r),input);assert.equal(analyze(r).inputHash,hash);
});
test('input specification and technology changes invalidate fingerprint',()=>{
  const r=rev(),hash=analyze(r).inputHash;r.ingredients[0].specificationVersion=2;assert.notEqual(analyze(r).inputHash,hash);
  const r2=rev();r2.processSteps[0].durationMin++;assert.notEqual(analyze(r2).inputHash,hash);
});
test('more sugar changes sweetness; mixing after layering changes structure',()=>{
  const r=rev(),before=analyze(r);r.ingredients[2].massKg*=2;
  assert.ok(analyze(r).scores['Сладость']>before.scores['Сладость']);
  const mixed=rev();mixed.processSteps.push({id:'new',type:'mix',durationMin:5,temperatureC:8});
  const a=analyze(mixed);assert.equal(a.structure,'homogeneous');assert.equal(a.scores['Слоистая'],0);assert.equal(a.scores['Однородная'],5);
});
test('target or correction does not modify model layer',()=>{
  const r=rev(),a=analyze(r);r.sensory.targets['Сладость']=0;r.sensory.corrections['Сладость']={value:5};
  assert.deepEqual(analyze(r),a);
});
test('create revision is pure, isolated and resets evidence and approval',()=>{
  const p=seeds().products[1],before=structuredClone(p),draft=structuredClone(p.revisions[0]);
  draft.trials=[{id:'old'}];draft.approval.status='approved';draft.sensory.corrections={'Сладость':{value:3}};draft.model={url:'old'};
  const n=createRevision(p,draft,'Изменение состава');
  assert.deepEqual(p,before);assert.equal(n.version,2);assert.notEqual(n.id,draft.id);assert.equal(n.baseId,p.revisions[0].id);
  assert.equal(n.approval.status,'preparation');assert.deepEqual(n.trials,[]);assert.deepEqual(n.sensory.corrections,{});assert.equal(n.model,undefined);
  n.ingredients[0].massKg=100;assert.notEqual(draft.ingredients[0].massKg,100);
});
test('invalid draft cannot create revision; empty duration is not zero',()=>{
  const p=seeds().products[1],r=structuredClone(p.revisions[0]);r.processSteps[0].durationMin=null;
  assert.match(validateRevision(r).join(' '),/длительность/);assert.throws(()=>createRevision(p,r),/длительность/);
});
test('malformed persisted arrays fail validation without crashing',()=>{
  const r=rev();r.ingredients={};assert.ok(validateRevision(r).length);
  r.ingredients=[null];assert.ok(validateRevision(r).length);
  r.ingredients=[];r.processSteps={};assert.ok(validateRevision(r).length);
});
test('unknown sugar specification is not absence of sweetness',()=>{
  const r=rev();r.ingredients[0].properties.sugarG=null;
  assert.equal(analyze(r).scores['Сладость'],null);
});
test('new mixing operation breaks pressed cheese shape',()=>{
  const r=rev(0);r.processSteps.push({id:'blend',type:'mix',durationMin:5,temperatureC:10});
  assert.equal(analyze(r).structure,'homogeneous');
});
