/** Pure domain logic. No I/O, network or dependency on product titles. */
export const SENSORY_GROUPS = Object.freeze({
  'Вкусовые характеристики': ['Сладость','Кислотность','Солёность','Горечь','Молочный вкус','Сливочный вкус','Кисломолочный вкус','Ягодный вкус'],
  'Обработка и сырьё': ['Обжаренные ноты','Дымные ноты','Древесные ноты','Землистые ноты','Минеральные ноты','Морские ноты','Мясные ноты','Ноты дичи'],
  'Ощущения при употреблении': ['Влажность во рту','Сухость во рту','Терпкость','Холодящий эффект','Насыщенность','Обволакивание','Интенсивность послевкусия','Длительность послевкусия'],
  'Текстуры': ['Гладкая','Зернистая','Кремовая','Воздушная','Вязкая','Плотная','Липкая','Пористая','Водянистая','Тягучая','Желейная','Пружинистая','Рассыпчатая','Хрустящая','Крошащаяся','Волокнистая','Мягкая','Упругая','Мучнистая','Маслянистая','Сочная','Слоистая','Однородная','Шероховатая']
});
export const SCENARIOS = Object.freeze({
  mixing:{name:'Технологическая обработка',points:[0,5,10,20],measurements:['Температура','Вязкость','Масса'],limitation:'Нужны скорость, оборудование и метод измерения. Изменение режима не является прогнозом текстуры.'},
  transport:{name:'Перевозка',points:[0,2,4,8],measurements:['Температура','Целостность упаковки'],limitation:'Температура и механическое повреждение проверяются отдельно. Пропуски регистратора не означают соблюдение режима.'},
  storage:{name:'Длительное хранение',points:[0,3,7,14],measurements:['pH','Внешний вид','Микробиология по методике'],limitation:'Точки являются редактируемым планом. Срок годности требует протоколов и отдельного заключения качества.'},
  opened:{name:'После вскрытия',points:[0,6,12,24],measurements:['pH','Внешний вид','Запах'],limitation:'Точки заданы в часах. Срок закрытого продукта не переносится на вскрытый.'}
});
const finite = x => typeof x === 'number' && Number.isFinite(x);
const positive = x => finite(x) && x > 0;
const copy = x => structuredClone(x);
const active = r => (r.ingredients || []).filter(i => !i.excluded);
const stable = x => Array.isArray(x) ? x.map(stable) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])) : x;
function omitIds(x) {
  if (Array.isArray(x)) return x.map(omitIds);
  if (!x || typeof x !== 'object') return x;
  return Object.fromEntries(Object.entries(x).filter(([k])=> !['id','lineId','createdAt','author','description','note'].includes(k)).map(([k,v])=>[k,omitIds(v)]));
}
export function physicalInput(revision) {
  return stable({methodVersion:'local-rules-1',ingredients:active(revision).map(i=>({
    name:String(i.name || '').trim().toLocaleLowerCase('ru'),massKg:i.massKg,phaseId:i.phaseId || 'main',
    specificationId:i.specificationId ?? null,specificationVersion:i.specificationVersion ?? null,
    nutrition:i.nutrition ?? null,properties:i.properties || {},allergens:i.allergens || []
  })),processSteps:(revision.processSteps || []).map(omitIds),output:omitIds(revision.output || {}),packaging:omitIds(revision.packaging || {})});
}
// Reproducible content fingerprint for local cache, not a cryptographic signature.
function fingerprint(value) {
  const s=JSON.stringify(value); let a=2166136261,b=2166136261;
  for(let i=0;i<s.length;i++){a=Math.imul(a^s.charCodeAt(i),16777619);b=Math.imul(b^s.charCodeAt(s.length-1-i),16777619);}
  return 'local-v1-'+(a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
}
export function validateRevision(r) {
  const errors=[];
  if (!r || typeof r!=='object') return ['Редакция должна быть объектом.'];
  if(!Array.isArray(r.ingredients))return ['Состав ingredients должен быть массивом.'];
  if(!Array.isArray(r.processSteps))return ['Технология processSteps должна быть массивом.'];
  if(r.ingredients.some(i=>!i||typeof i!=='object'))return ['Каждая строка состава должна быть объектом.'];
  if(r.processSteps.some(i=>!i||typeof i!=='object'))return ['Каждая операция должна быть объектом.'];
  if (!Array.isArray(r.ingredients)) return ['Состав должен быть массивом ингредиентов.'];
  if (!r.ingredients.length) errors.push('Добавьте хотя бы один ингредиент.');
  if (r.ingredients.some(i=>!i || typeof i!=='object')) return ['Каждая строка состава должна быть объектом.'];
  if (r.processSteps!=null && !Array.isArray(r.processSteps)) return ['Технология должна быть массивом операций.'];
  if (r.processSteps?.some(s=>!s || typeof s!=='object')) return ['Каждая операция должна быть объектом.'];
  const ids=new Set();
  for(const [n,i] of (r.ingredients || []).entries()) {
    const prefix=`Строка ${n+1}: `;
    if(!i.lineId || ids.has(i.lineId)) errors.push(prefix+'нужен уникальный lineId.'); ids.add(i.lineId);
    if(typeof i.name!=='string' || !i.name.trim()) errors.push(prefix+'укажите название сырья.');
    if(i.sourceUnit!=null&&!['kg','кг','g','г'].includes(i.sourceUnit))errors.push(prefix+'неподдерживаемая исходная единица массы.');
    if(i.allergens!=null&&!Array.isArray(i.allergens))errors.push(prefix+'аллергены должны быть массивом.');
    if(!finite(i.massKg) || i.massKg<0 || (!i.excluded && i.massKg===0)) errors.push(prefix+'масса должна быть положительным числом; ноль допустим только для исключённой строки.');
    if(i.pricePerKg!=null && (!finite(i.pricePerKg) || i.pricePerKg<0)) errors.push(prefix+'цена должна быть неотрицательным числом или null.');
    if(i.nutrition!=null) for(const k of ['kcal','protein','fat','carbs']) if(i.nutrition[k]!=null&&(!finite(i.nutrition[k]) || i.nutrition[k]<0)) errors.push(prefix+`КБЖУ: ${k} должно быть числом >= 0 или null.`);
  }
  const input=active(r).reduce((s,i)=>s+(finite(i.massKg)?i.massKg:0),0);
  if(!positive(input)) errors.push('Сумма действующих масс должна быть больше нуля.');
  if(r.output?.massKg!=null && (!positive(r.output.massKg) || r.output.massKg>input+1e-8)) errors.push('Выход должен быть > 0 и не превышать массу загрузки.');
  if(!positive(r.packaging?.portionG)) errors.push('Масса порции должна быть > 0.');
  const types=['coagulate','drain','press','mix','layer','puree','heat','cool'];
  const phases=new Set(active(r).map(i=>i.phaseId || 'main'));
  for(const [n,s] of (r.processSteps || []).entries()) {
    if(!types.includes(s.type)) errors.push(`Операция ${n+1}: неподдерживаемый тип.`);
    if(!finite(s.durationMin) || s.durationMin<0) errors.push(`Операция ${n+1}: задайте длительность в минутах >= 0.`);
    if(s.temperatureC!=null && !finite(s.temperatureC)) errors.push(`Операция ${n+1}: температура должна быть числом или null.`);
    if(s.phaseId && !phases.has(s.phaseId)) errors.push(`Операция ${n+1}: неизвестная фаза ${s.phaseId}.`);
    if(s.phaseIds?.some(p=>!phases.has(p))) errors.push(`Операция ${n+1}: неизвестная ссылка на фазу.`);
  }
  if(r.output?.method==='confirmed_mass_balance') {
    const streams=r.output.lossStreams;
    if(!Array.isArray(streams) || streams.some(s=>!finite(s.massKg) || s.massKg<0) || Math.abs(input-r.output.massKg-streams.reduce((s,i)=>s+i.massKg,0))>1e-7) errors.push('Массовый баланс не замкнут: загрузка должна равняться выходу и сумме отделяемых потоков.');
  }
  return errors;
}
export function calculate(r,{portionG=r.packaging?.portionG,quantity=1}={}) {
  const ingredients=active(r),warnings=[];
  const validInput=ingredients.length>0 && ingredients.every(i=>positive(i.massKg));
  const inputKg=validInput?ingredients.reduce((s,i)=>s+i.massKg,0):null;
  const outputKg=positive(r.output?.massKg) && inputKg!=null && r.output.massKg<=inputKg+1e-8?r.output.massKg:null;
  const yieldRatio=outputKg!=null?outputKg/inputKg:null;
  const validBatch=positive(portionG) && Number.isSafeInteger(quantity) && quantity>0;
  const finishedKg=validBatch?portionG*quantity/1000:null;
  if(!validBatch) warnings.push('Масса порции должна быть положительной, количество упаковок - целым положительным.');
  if(!validInput) warnings.push('Некорректные массы: зависимые расчёты недоступны.');
  const drain=(r.processSteps || []).some(s=>s.type==='drain');
  const streams=r.output?.lossStreams;
  const balanceModel=r.output?.confirmed===true && outputKg!=null && (
    (!drain && r.output.method==='mass_conservation' && Math.abs(inputKg-outputKg)<1e-7) ||
    (r.output.method==='confirmed_mass_balance' && Array.isArray(streams) && streams.every(s=>finite(s.massKg)&&s.massKg>=0) && Math.abs(inputKg-outputKg-streams.reduce((s,i)=>s+i.massKg,0))<1e-7)
  );
  const requiredInputKg=balanceModel && finishedKg!=null?finishedKg/yieldRatio:null;
  if(!balanceModel) warnings.push('Производственная загрузка неизвестна: нужен подтверждённый метод массового баланса. Эквивалент состава не является закупочной загрузкой.');
  if(drain) warnings.push('КБЖУ готового продукта неизвестны: требуется состав отделённой сыворотки и удержание нутриентов.');
  const lines=ingredients.map(i=>{
    const share=inputKg!=null?i.massKg/inputKg:null;
    const batchKg=share!=null && finishedKg!=null?share*finishedKg:null;
    const price=finite(i.pricePerKg)&&i.pricePerKg>=0?i.pricePerKg:null;
    return {...copy(i),share,gramsPerPortion:share!=null&&positive(portionG)?share*portionG:null,batchKg,
      cost:price!=null&&batchKg!=null?price*batchKg:null,
      inputCost:price!=null&&positive(i.massKg)?price*i.massKg:null,
      productionKg:share!=null&&requiredInputKg!=null?share*requiredInputKg:null,
      productionCost:price!=null&&share!=null&&requiredInputKg!=null?price*share*requiredInputKg:null};
  });
  const sumKnown=key=>{const a=lines.map(l=>l[key]).filter(finite);return a.length?a.reduce((s,v)=>s+v,0):null;};
  const missingPrices=lines.filter(i=>i.pricePerKg==null||!finite(i.pricePerKg)||i.pricePerKg<0).map(i=>i.name);
  const costTotal=sumKnown('cost'),costInputTotal=sumKnown('inputCost');
  if(missingPrices.length) warnings.push('Частичная стоимость: отсутствуют цены - '+missingPrices.join(', ')+'.');
  let nutrition=null;
  if(!drain && outputKg!=null) {
    nutrition=Object.fromEntries(['kcal','protein','fat','carbs'].map(k=>[k,ingredients.every(i=>finite(i.nutrition?.[k])&&i.nutrition[k]>=0)?ingredients.reduce((s,i)=>s+i.massKg*i.nutrition[k],0)/outputKg:null]));
    if(Object.values(nutrition).every(v=>v===null))nutrition=null;
    if(!nutrition||Object.values(nutrition).some(v=>v===null))warnings.push('КБЖУ заполнены частично: вычислены только показатели с полными спецификациями всех компонентов.');
  } else if(!drain) warnings.push('КБЖУ недоступны: заполните спецификации всех компонентов и выход.');
  return {inputKg,outputKg,yieldRatio,portionG:positive(portionG)?portionG:null,quantity:validBatch?quantity:null,finishedKg,requiredInputKg,lines,costTotal,costComplete:!missingPrices.length&&costTotal!=null,missingPrices,costInputTotal,
    costPerInputKg:inputKg&&costInputTotal!=null?costInputTotal/inputKg:null,costPerOutputKg:balanceModel&&costInputTotal!=null?costInputTotal/outputKg:null,
    productionCostTotal:sumKnown('productionCost'),nutrition,nutritionPerPortion:nutrition&&positive(portionG)?Object.fromEntries(Object.entries(nutrition).map(([k,v])=>[k,v==null?null:v*portionG/100])):null,
    nutritionBasis:'На 100 г готового продукта; расчёт по сохранённым спецификациям и выходу, не лабораторные измерения.',
    allergens:[...new Set(ingredients.flatMap(i=>i.allergens || []))],warnings};
}
function category(i) {
  if(i.properties?.category) return i.properties.category;
  const n=String(i.name).toLocaleLowerCase('ru');
  for(const [cat,re] of [['sugar',/сахар/],['salt',/соль/],['berry',/клубник|ягод|малин/],['cream',/сливк/],['curd',/творог|творож/],['milk',/молок/],['fruit',/яблок|груш|фрукт/]]) if(re.test(n)) return cat;
  return 'unknown';
}
export function analyze(r) {
  const input=physicalInput(r),scores=Object.fromEntries(Object.values(SENSORY_GROUPS).flat().map(n=>[n,null]));
  const evidence=[],formulas={};
  const ing=active(r),mass=ing.reduce((s,i)=>s+(positive(i.massKg)?i.massKg:0),0);
  const valid=mass>0 && ing.every(i=>positive(i.massKg));
  const share=(...cats)=>valid?ing.filter(i=>cats.includes(category(i))).reduce((s,i)=>s+i.massKg,0)/mass:0;
  const steps=r.processSteps || [],types=steps.map(s=>s.type);
  const phases=new Set(ing.map(i=>i.phaseId || 'main'));
  let structure='unknown';
  const co=types.indexOf('coagulate'),dr=types.indexOf('drain'),pr=types.indexOf('press');
  if(valid && share('milk','curd')>0.5 && co>=0&&dr>co&&pr>dr&&pr>Math.max(types.lastIndexOf('mix'),types.lastIndexOf('puree'),types.lastIndexOf('layer'))) {structure='pressed_cheese';evidence.push('Молочное сырьё > 50%; операции: получение сгустка, отделение сыворотки, прессование в указанном порядке.');}
  else if(valid) {
    for(const s of steps) {
      if(s.type==='layer'&&phases.size>1) structure='layered';
      if(s.type==='mix') structure='homogeneous';
      if(s.type==='puree') structure=share('fruit','berry')>=0.5?'puree':'homogeneous';
    }
    evidence.push('Структура получена по последней структурообразующей операции; название продукта не используется.');
  }
  const set=(key,value,formula)=>{scores[key]=Math.max(0,Math.min(5,value));formulas[key]=formula;};
  if(valid && structure!=='unknown') {
    const sugarShare=ing.reduce((s,i)=>s+i.massKg*(finite(i.properties?.sugarG)?i.properties.sugarG/100:category(i)==='sugar'?1:0),0)/mass;
    if(ing.every(i=>finite(i.properties?.sugarG)||['sugar','salt','water'].includes(category(i)))) set('Сладость',5*Math.min(1,sugarShare/.2),'5 × min(1, доля сахаров по спецификациям / 0,20). Не учитывает относительную сладость и взаимодействия.');
    set('Солёность',5*Math.min(1,share('salt')/.03),'5 × min(1, массовая доля добавленной соли / 0,03).');
    set('Молочный вкус',5*share('milk','curd','cream'),'5 × массовая доля молочного сырья.');
    set('Сливочный вкус',5*Math.min(1,share('cream')/.3),'5 × min(1, доля сливок / 0,30).');
    set('Ягодный вкус',5*Math.min(1,share('berry')/.4),'5 × min(1, доля ягод / 0,40).');
    set('Слоистая',structure==='layered'?5:0,'5 для операции сборки слоёв нескольких фаз, 0 после смешивания или измельчения.');
    set('Однородная',['homogeneous','puree'].includes(structure)?5:0,'5 для смешанной или измельчённой структуры, 0 для слоистой или прессованной.');
    if(structure==='pressed_cheese') set('Плотная',4,'Структурный индекс 4 при последовательности coagulate -> drain -> press; не измеренная плотность.');
    if(structure==='puree') set('Гладкая',4,'Структурный индекс 4 при измельчении фруктового сырья; размер частиц не измерен.');
    evidence.push(`Сырьевая база: молочные компоненты ${(share('milk','curd','cream')*100).toFixed(1)}%, ягоды ${(share('berry')*100).toFixed(1)}%.`);
  }
  const limitations=['Локальная эвристика, не измерение и не обученная модель. Индексы 0-5 служат для сравнения входов, точность сенсорного прогноза не установлена.',
    'Пороговые коэффициенты правил заданы в коде; они не получены обучением. Не подтверждает вкус, безопасность или срок годности.',
    'Остальные признаки оставлены неизвестными (null); ноль означает только результат применённого правила.',
    'Цвет, текстура и аромат требуют проверки образца. Для сывороткоотделения индексы относятся к сырьевому входу, не к концентрации в сыре.'];
  if(structure==='unknown') limitations.push('Структура не поддержана: задайте распознаваемое сырьё и последовательность операций.');
  return {inputHash:fingerprint(input),method:'Локальная эвристика v1: правила состава и последовательности операций',limitations,structure,scores,evidence,formulas,modelVersion:'local-rules-1',supported:structure!=='unknown'};
}
export function createRevision(product,draft,note='') {
  const errors=validateRevision(draft); if(errors.length) throw new Error(errors.join('\n'));
  const latest=product.revisions?.find(r=>r.id===draft.id) || product.revisions?.at(-1);
  const revision=copy(draft);
  revision.id=globalThis.crypto?.randomUUID?.() || `rev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  revision.version=Math.max(0,...(product.revisions || []).map(r=>Number(r.version)||0))+1;
  revision.baseId=latest?.id ?? null; revision.createdAt=new Date().toISOString();revision.description=note || 'Новая редакция';
  revision.sensory={corrections:{},targets:copy(draft.sensory?.targets || {}),measurements:{}};
  revision.trials=[];revision.approval={status:'preparation',recipe:null,quality:null,history:[]};
  // Evidence and results belong to their original physical snapshot.
  for(const k of ['analysis','calculation','model','models','results','shelfLifeConclusion','approvedAt','approvalPackage','label','agentOrigin']) delete revision[k];
  return revision;
}


