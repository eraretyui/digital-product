import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState} from './seeds.js';
import {calculate,validateRevision} from './domain.js';
test('known nutrient survives unknown fat without treating missing fat as zero',()=>{
 const r=createSeedState().products[1].revisions[0];r.ingredients[0].nutrition.fat=null;
 assert.deepEqual(validateRevision(r),[]);const c=calculate(r,{portionG:150});
 assert.equal(c.nutrition.fat,null);assert.equal(c.nutritionPerPortion.fat,null);assert.ok(c.nutrition.protein>0);assert.ok(c.nutrition.kcal>0);
 r.processSteps.push({id:'drain',type:'drain',durationMin:1,temperatureC:null});assert.equal(calculate(r).nutrition,null);
});
