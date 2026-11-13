// Self-contained demonstration specifications, not supplier quotations or laboratory records.
const at='2026-11-08T09:00:00.000Z';
const provenance={kind:'demonstration',status:'not_verified',source:'Локальный демонстрационный набор для проверки функций. Не производственные дозировки, не данные поставщика и не результаты лаборатории.',createdAt:at};
function ingredient(lineId,name,massKg,phaseId,pricePerKg,nutrition,properties,allergens=[]) {
  return {lineId,name,massKg,phaseId,pricePerKg,nutrition,properties,allergens,
    specificationId:`demo-spec-${lineId}`,specificationVersion:1,
    priceBasis:{currency:'RUB',unit:'kg',date:'2026-11-08',status:'demonstration',tax:'Не сопоставлено с коммерческой поставкой'},provenance:structuredClone(provenance)};
}
function revision(id,ingredients,processSteps,output,packaging) {
  return {id,version:1,baseId:null,createdAt:at,description:'Исходная демонстрационная редакция',ingredients,processSteps,output,packaging,
    sensory:{corrections:{},targets:{},measurements:{}},trials:[],approval:{status:'preparation',recipe:null,quality:null,history:[]},provenance:structuredClone(provenance)};
}
const nutrition=(kcal,protein,fat,carbs)=>({kcal,protein,fat,carbs});
export function createSeedState() {
  const cheese=revision('rev-cheese-1',[
    ingredient('cheese-milk','Молоко',10,'main',72,nutrition(60,3.2,3.2,4.7),{category:'milk',color:'#f4ead7',sugarG:4.7},['Молоко']),
    ingredient('cheese-salt','Соль',.02,'main',24,nutrition(0,0,0,0),{category:'salt',color:'#ffffff',sugarG:0}),
    ingredient('cheese-starter','Закваска',.01,'main',null,null,{category:'starter',color:'#f4ead7',sugarG:null},['Молоко'])
  ],[
    {id:'ch-heat',type:'heat',durationMin:30,temperatureC:63},
    {id:'ch-coagulate',type:'coagulate',durationMin:45,temperatureC:32},
    {id:'ch-drain',type:'drain',durationMin:20,temperatureC:30},
    {id:'ch-press',type:'press',durationMin:120,temperatureC:20,pressureKPa:null},
    {id:'ch-cool',type:'cool',durationMin:120,temperatureC:4}
  ],{massKg:1.5,method:'confirmed_mass_balance',confirmed:true,lossStreams:[{name:'Сыворотка и технологические потери',massKg:8.53}],provenance:structuredClone(provenance)}, {type:'Вакуумный пакет',portionG:150});
  const dessert=revision('rev-dessert-1',[
    ingredient('dessert-curd','Творог',.65,'main',280,nutrition(121,17,5,1.8),{category:'curd',color:'#f5eee0',sugarG:1.8},['Молоко']),
    ingredient('dessert-cream','Сливки',.15,'main',340,nutrition(206,2.5,20,4),{category:'cream',color:'#f7efdd',sugarG:4},['Молоко']),
    ingredient('dessert-sugar','Сахар',.06,'main',76,nutrition(400,0,0,100),{category:'sugar',color:'#ffffff',sugarG:100}),
    ingredient('dessert-berry','Клубничное пюре',.14,'berry',210,nutrition(32,0.7,0.3,7.7),{category:'berry',color:'#b73951',sugarG:4.9})
  ],[
    {id:'de-mix',type:'mix',phaseId:'main',durationMin:8,temperatureC:8},
    {id:'de-layer',type:'layer',phaseIds:['berry','main'],durationMin:2,temperatureC:8,bottomPhaseId:'berry'},
    {id:'de-cool',type:'cool',durationMin:30,temperatureC:4}
  ],{massKg:1,method:'mass_conservation',confirmed:true,provenance:structuredClone(provenance)}, {type:'Стаканчик с крышкой',portionG:100});
  const puree=revision('rev-puree-1',[
    ingredient('puree-apple','Яблочное пюре',.9,'main',98,nutrition(52,0.3,0.2,13.8),{category:'fruit',color:'#d3ac50',sugarG:10.4}),
    ingredient('puree-water','Вода',.07,'main',2,nutrition(0,0,0,0),{category:'water',color:'#e7dda9',sugarG:0}),
    ingredient('puree-sugar','Сахар',.03,'main',76,nutrition(400,0,0,100),{category:'sugar',color:'#ffffff',sugarG:100})
  ],[
    {id:'pu-mix',type:'mix',durationMin:5,temperatureC:20},
    {id:'pu-puree',type:'puree',durationMin:10,temperatureC:20},
    {id:'pu-heat',type:'heat',durationMin:5,temperatureC:85},
    {id:'pu-cool',type:'cool',durationMin:30,temperatureC:4}
  ],{massKg:1,method:'mass_conservation',confirmed:true,provenance:structuredClone(provenance)}, {type:'Банка',portionG:100});
  return {schemaVersion:1,version:0,products:[
    {id:'product-cheese',code:'DP-001',title:'Прессованный молочный сыр',tags:['Сыр','Демонстрационные данные'],stage:'Рецептура',revisions:[cheese],provenance:structuredClone(provenance)},
    {id:'product-dessert',code:'DP-002',title:'Творожный десерт с ягодным слоем',tags:['Десерт','Демонстрационные данные'],stage:'Рецептура',revisions:[dessert],provenance:structuredClone(provenance)},
    {id:'product-puree',code:'DP-003',title:'Яблочное пюре',tags:['Фрукты','Демонстрационные данные'],stage:'Рецептура',revisions:[puree],provenance:structuredClone(provenance)}
  ],settings:{columns:['title','author','updated','ingredients','nutrition','physical','allergens','mark','stage','trials'].map(id=>({id,shown:true}))},documents:[],provenance:structuredClone(provenance)};
}

