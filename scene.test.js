import test from 'node:test';
import assert from 'node:assert/strict';
import {visualSpec} from './scene.js';
import {analyze} from './domain.js';

const base = () => ({id:'r1',title:'Десерт',ingredients:[
  {lineId:'a',name:'Творог',massKg:8,phaseId:'main',properties:{category:'curd',color:'#f7f0df'}},
  {lineId:'b',name:'Клубника',massKg:2,phaseId:'berry',properties:{category:'berry',color:'#b73951'}},
],processSteps:[{id:'op',type:'layer'}]});

test('visual generator is independent from product identity and commercial fields',()=>{
  const a=base(), b=structuredClone(a);
  Object.assign(b,{id:'brand-2',version:99,title:'Сыр иной марки',brand:'x',tags:['puree'],description:'cheese'});
  b.ingredients.forEach((i,n)=>Object.assign(i,{lineId:String(n),pricePerKg:999}));
  b.processSteps[0].id='another';
  assert.deepEqual(visualSpec(a),visualSpec(b));
});
test('assembly makes berry bottom layer with mass-based thickness; mixing removes layers',()=>{
  const a=base(), s=visualSpec(a);
  assert.equal(s.structure,'layered');assert.equal(s.supported,true);
  assert.equal(s.layers[0].phase,'berry');assert.equal(s.layers[0].share,.2);
  a.ingredients[1].massKg=8;
  assert.equal(visualSpec(a).layers[0].share,.5);
  a.processSteps.push({type:'mix'});
  const mixed=visualSpec(a);
  assert.equal(mixed.structure,'homogeneous');assert.equal(mixed.layers.length,1);
  assert.notDeepEqual(mixed.color,s.color);
});
test('operation sequence drives cheese and puree; titles cannot supply missing process',()=>{
  const a=base();a.processSteps=[{type:'coagulate'},{type:'drain'},{type:'press'}];
  assert.equal(visualSpec(a).structure,'pressed_cheese');
  a.processSteps.reverse();assert.equal(visualSpec(a).supported,false);
  a.processSteps=[{type:'puree'}];assert.equal(visualSpec(a).structure,'homogeneous');
  a.ingredients=a.ingredients.slice(1);assert.equal(visualSpec(a).structure,'puree');
  a.processSteps=[];a.title='Прессованный сыр';assert.equal(visualSpec(a).supported,false);
});
test('render classification agrees with domain for dairy, fruit and excluded ingredients',()=>{
  const a=base();
  for(const steps of [['coagulate','drain','press'],['puree'],['layer'],['layer','mix']]) {
    a.processSteps=steps.map(type=>({type}));
    assert.equal(visualSpec(a).structure,analyze(a).structure);
    const fruit=structuredClone(a);fruit.ingredients=fruit.ingredients.slice(1);
    assert.equal(visualSpec(fruit).structure,analyze(fruit).structure);
  }
  a.processSteps=[{type:'mix'}];
  const before=visualSpec(a);
  a.ingredients.push({lineId:'excluded',name:'Ягодная масса',massKg:1000,phaseId:'other',excluded:true,properties:{category:'berry',color:'#000000'}});
  assert.deepEqual(visualSpec(a),before);
  a.ingredients.at(-1).massKg=NaN;
  assert.deepEqual(visualSpec(a),before);
});

test('WebGL never reads unused black layer colors on top surfaces', {skip:!process.env.RUNTIME_NODE_MODULES}, async()=>{
  const {createRequire}=await import('node:module');
  const {readFile}=await import('node:fs/promises');
  const {join}=await import('node:path');
  const {chromium}=createRequire(join(process.env.RUNTIME_NODE_MODULES,'playwright/package.json'))('playwright');
  const browser=await chromium.launch({headless:true,channel:'msedge'});
  try {
    const page=await browser.newPage();
    await page.route('http://scene.test/**',async route=>{
      const module=new URL(route.request().url()).pathname.slice(1);
      if(['scene.js','domain.js'].includes(module))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL(module,import.meta.url),'utf8')});
      return route.fulfill({contentType:'text/html',body:'<div id="scene" style="width:640px;height:480px"></div>'});
    });
    await page.goto('http://scene.test/');
    for(const type of ['layer','mix','puree']) {
      const revision=base();revision.processSteps=[{type}];
      if(type==='puree')revision.ingredients=revision.ingredients.slice(1);
      const result=await page.evaluate(async revision=>{
        window.model?.dispose();
        const {mountScene}=await import('/scene.js');
        window.model=mountScene(document.querySelector('#scene'),revision);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const canvas=document.querySelector('canvas'),gl=canvas.getContext('webgl');
        const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let black=0,nonBackground=0;
        for(let p=0;p<pixels.length;p+=4){if(pixels[p]<10&&pixels[p+1]<10&&pixels[p+2]<10)black++;if(pixels[p]<230)nonBackground++;}
        return {black,nonBackground,error:window.model.error};
      },revision);
      assert.equal(result.error,null);assert.equal(result.black,0,`${type} contains black surface pixels`);assert.ok(result.nonBackground>10000);
    }
  } finally {await browser.close();}
});
test('invalid mass, one phase and unsupported operations produce reasons without invented shape',()=>{
  for(const value of [-1,NaN,undefined]){const a=base();a.ingredients[0].massKg=value;assert.equal(visualSpec(a).supported,false);}
  const a=base();a.ingredients[1].phaseId='main';assert.equal(visualSpec(a).supported,false);
  a.processSteps=[{type:'bake'}];assert.equal(visualSpec(a).structure,'unknown');assert.ok(visualSpec(a).reason);
  assert.equal(visualSpec({}).supported,false);
});
test('specification colors respond to composition and explicit color properties without mutation',()=>{
  const a=base(), before=structuredClone(a), s=visualSpec(a);
  assert.deepEqual(a,before);
  a.ingredients[1].properties.color='#222266';
  assert.notDeepEqual(visualSpec(a).layers[0].color,s.layers[0].color);
  a.ingredients.forEach(i=>i.massKg*=10);
  assert.equal(visualSpec(a).layers[0].share,s.layers[0].share);
});
