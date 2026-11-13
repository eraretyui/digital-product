import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState} from './seeds.js';
import {validateChanges} from './state-validation.js';
const seed=()=>createSeedState();
test('audit: saved ingredient commercial specification cannot be rewritten',()=>{
 const before=seed(), after=structuredClone(before);after.products[0].revisions[0].ingredients[0].pricePerKg=1;
 assert.throws(()=>validateChanges(before,after,'rd'));
});
test('audit: approved revision evidence stays frozen',()=>{
 const before=seed();before.products[0].revisions[0].approval={status:'approved',recipe:{decision:'approved'},quality:{decision:'approved'},history:[]};
 const after=structuredClone(before);after.products[0].revisions[0].sensory.corrections['Сладость']={value:5,reason:'audit'};
 assert.throws(()=>validateChanges(before,after,'rd'));
});
test('audit: approved revision trial evidence stays frozen',()=>{
 const before=seed();before.products[0].revisions[0].approval={status:'approved',recipe:{decision:'approved'},quality:{decision:'approved'},history:[]};
 const after=structuredClone(before);after.products[0].revisions[0].trials.push({id:'added-after-approval'});
 assert.throws(()=>validateChanges(before,after,'quality'));
});
test('audit: imported product cannot bypass its own approval route',()=>{
 const before=seed(), after=structuredClone(before), p=structuredClone(before.products[0]);p.id='audit-new-product';p.code='AUD-01';p.revisions[0].id='audit-new-revision';p.revisions[0].approval.status='approved';after.products.push(p);
 assert.throws(()=>validateChanges(before,after,'rd'));
});
import {analyze} from './domain.js';
import {visualSpec} from './scene.js';
test('audit: excluded positive ingredient is absent from visual composition',()=>{
 const a=seed().products[1].revisions[0], b=structuredClone(a);b.ingredients.push({...structuredClone(b.ingredients[3]),lineId:'excluded',massKg:50,excluded:true});
 assert.deepEqual(visualSpec(a),visualSpec(b));
});
test('audit: fruit process is not sufficient evidence for milk cheese geometry',()=>{
 const r=seed().products[2].revisions[0];r.processSteps=[{type:'coagulate'},{type:'drain'},{type:'press'}];
 assert.equal(analyze(r).structure,'unknown');assert.equal(visualSpec(r).supported,false);
});
