import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState} from './seeds.js';
import {importProducts} from './data-source.js';
import {validateChanges} from './state-validation.js';
test('JSON import validates atomically, preserves existing data and is repeatable',()=>{
 const state=createSeedState(),source=structuredClone(state.products[2]);source.id='local-import';source.code='NEW-01';source.revisions[0].id='new-revision';
 const next=importProducts(state,{schemaVersion:1,products:[source]});assert.equal(state.products.length,3);assert.equal(next.products.length,4);
 assert.deepEqual(importProducts(next,{schemaVersion:1,products:[source]}),next);
 const broken=structuredClone(source);broken.id='invalid';broken.revisions[0].ingredients[0].massKg=-1;
 assert.throws(()=>importProducts(state,{schemaVersion:1,products:[source,broken]}));assert.equal(state.products.length,3);
 assert.throws(()=>importProducts(state,{schemaVersion:2,products:[source]}));
 assert.throws(()=>importProducts(state,{schemaVersion:1,products:[{...source,revisions:{}}]}));
});
test('five-step demo approval checks roles, parallel decisions and final fixation',()=>{
 let before=createSeedState(),after=structuredClone(before),r=after.products[1].revisions[0];
 r.approval={status:'review',recipe:null,quality:null,history:[],packageSnapshot:{test:true},packageHash:'hash',runId:'run'};
 assert.throws(()=>validateChanges(before,after,'viewer'));validateChanges(before,after,'rd');
 before=after;after=structuredClone(before);after.products[1].revisions[0].approval.recipe={decision:'approved',role:'technologist'};
 assert.throws(()=>validateChanges(before,after,'rd'));validateChanges(before,after,'technologist');
 before=after;after=structuredClone(before);r=after.products[1].revisions[0];r.approval.quality={decision:'approved',role:'quality'};r.approval.status='final';validateChanges(before,after,'quality');
 before=after;after=structuredClone(before);r=after.products[1].revisions[0];r.approval.status='approved';r.approval.approvedAt=new Date().toISOString();after.products[1].approvedRevisionId=r.id;
 assert.throws(()=>validateChanges(before,after,'technologist'));validateChanges(before,after,'chief');
 assert.doesNotThrow(()=>validateChanges(after,structuredClone(after),'chief'));
 const changed=structuredClone(after);changed.products[1].revisions[0].approval.status='preparation';assert.throws(()=>validateChanges(after,changed,'chief'));
});
test('review decisions cannot be erased by unrelated role or inserted before review',()=>{
 const before=createSeedState(),after=structuredClone(before);after.products[0].revisions[0].approval.recipe={decision:'approved'};
 assert.throws(()=>validateChanges(before,after,'technologist'));
 before.products[0].revisions[0].approval={status:'review',recipe:{decision:'approved'},quality:null,history:[]};
 const erased=structuredClone(before);erased.products[0].revisions[0].approval.recipe=null;assert.throws(()=>validateChanges(before,erased,'rd'));
});
