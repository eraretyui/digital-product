// Local implicit 3D renderer. No images, network resources or product identity inputs.
import {analyze} from './domain.js';
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const PALETTE = {
  milk: [0.95, 0.91, 0.82], curd: [0.97, 0.95, 0.89], cream: [0.98, 0.95, 0.86],
  berry: [0.65, 0.15, 0.25], fruit: [0.82, 0.66, 0.31], sugar: [0.98, 0.97, 0.93],
  salt: [0.98, 0.98, 0.95], water: [0.89, 0.92, 0.91], starter: [0.96, 0.93, 0.86],
};
function category(i) {
  if (PALETTE[i.properties?.category]) return i.properties.category;
  const n = String(i.name || '').toLowerCase();
  if (/клубник|ягод|малин|смород|strawberry|berry/.test(n)) return 'berry';
  if (/яблок|груш|персик|apple|fruit/.test(n)) return 'fruit';
  if (/творог|curd/.test(n)) return 'curd';
  if (/сливк|cream/.test(n)) return 'cream';
  if (/молок|milk/.test(n)) return 'milk';
  if (/сахар|sugar/.test(n)) return 'sugar';
  if (/соль|salt/.test(n)) return 'salt';
  if (/закваск|starter/.test(n)) return 'starter';
  if (/вода|water/.test(n)) return 'water';
  return 'unknown';
}
function ingredientColor(i) {
  const v = i.properties?.color;
  if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) {
    return [1, 3, 5].map(p => parseInt(v.slice(p, p + 2), 16) / 255);
  }
  if (Array.isArray(v) && v.length === 3 && v.every(x => Number.isFinite(x) && x >= 0 && x <= 1)) return [...v];
  return PALETTE[category(i)] || [0.78, 0.77, 0.72];
}
function blended(lines) {
  const mass = lines.reduce((n, i) => n + i.massKg, 0);
  return [0, 1, 2].map(c => lines.reduce((n, i) => n + ingredientColor(i)[c] * i.massKg, 0) / mass);
}

/** Pure generation specification: titles, brands, tags, IDs and costs are never read. */
export function visualSpec(revision = {}) {
  const lines = Array.isArray(revision.ingredients) ? revision.ingredients.filter(i => !i.excluded) : [];
  const steps = Array.isArray(revision.processSteps) ? revision.processSteps : [];
  const unsupported = reason => ({ supported: false, structure: 'unknown', reason, color: [0.78, 0.77, 0.72], layers: [], method: 'procedural-sdf-v1' });
  if (lines.some(i => !Number.isFinite(i.massKg) || i.massKg <= 0)) return unsupported('Для 3D нужны положительные массы всех действующих ингредиентов.');
  const active = lines.filter(i => i.massKg > 0);
  if (!active.length) return unsupported('Добавьте состав с положительными массами для построения 3D.');
  const known = new Set(['coagulate', 'drain', 'press', 'mix', 'layer', 'puree', 'heat', 'cool']);
  if (steps.some(s => !known.has(s.type))) return unsupported('Технология содержит операцию вне области процедурной модели.');
  const press = steps.map(s => s.type).lastIndexOf('press');
  // A single structure classifier is shared by sensory analysis and rendering.
  const {structure} = analyze({ingredients: lines, processSteps: steps});
  if (structure === 'unknown') return unsupported('Структура не определена: нужны поддерживаемые операции прессования, сборки слоёв, смешивания или пюрирования.');
  const groups = new Map();
  for (const i of active) {
    const phase = String(i.phaseId || 'main');
    if (!groups.has(phase)) groups.set(phase, []);
    groups.get(phase).push(i);
  }
  if (structure === 'layered' && groups.size < 2) return unsupported('Для слоистой структуры нужны как минимум две фазы ингредиентов.');
  if (structure === 'layered' && groups.size > 8) return unsupported('Процедурный просмотр поддерживает не более восьми слоёв.');
  const total = active.reduce((s, i) => s + i.massKg, 0);
  // Berry is the bottom phase by the local recipe contract, never a decoration.
  const entries = [...groups].sort(([a], [b]) => a === 'berry' ? -1 : b === 'berry' ? 1 : a.localeCompare(b));
  const layers = structure === 'layered' ? entries.map(([phase, rows]) => ({
    phase, share: rows.reduce((s, i) => s + i.massKg, 0) / total,
    color: blended(rows), berry: rows.some(i => category(i) === 'berry'),
  })) : [{ phase: 'mixed', share: 1, color: blended(active), berry: active.some(i => category(i) === 'berry') }];
  const fruitShare = active.filter(i => ['berry', 'fruit'].includes(category(i))).reduce((s, i) => s + i.massKg, 0) / total;
  const pressStep = steps[press];
  const compactness = pressStep && Number.isFinite(pressStep.durationMin) ? clamp(pressStep.durationMin / 180) : 0.5;
  return {
    supported: true, structure,
    reason: 'Процедурная визуальная гипотеза по составу и технологии. Цвет и фактура не откалиброваны по физическому образцу.',
    method: 'procedural-sdf-v1', color: blended(active), layers,
    roughness: structure === 'pressed_cheese' ? 0.68 : structure === 'puree' ? 0.4 : 0.48,
    grain: structure === 'pressed_cheese' ? 0.65 : structure === 'puree' ? 0.35 : 0.5,
    fruitShare, compactness,
  };
}

const vertexSource = `attribute vec2 position; varying vec2 uv; void main(){uv=position;gl_Position=vec4(position,0.,1.);}`;
const fragmentSource = `
precision highp float;
varying vec2 uv;
uniform vec2 resolution;
uniform vec3 eye;
uniform float kind, roughness, grain, compactness, fruitShare;
uniform int layerCount;
uniform vec3 layerColors[8];
uniform float layerEnds[8];
const vec3 background = vec3(0.9254902,0.9333333,0.9254902);
float hash(vec3 p){p=fract(p*.3183099+vec3(.1,.3,.7));p*=17.;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
float cylinder(vec3 p,float radius,float halfheight,float bevel){vec2 d=abs(vec2(length(p.xz),p.y))-vec2(radius-bevel,halfheight-bevel);return min(max(d.x,d.y),0.)+length(max(d,0.))-bevel;}
float height(){return kind<.5 ? .48-.08*compactness : kind<1.5 ? .72 : .46;}
float sdf(vec3 p){
  if(kind<.5){float d=cylinder(p,1.,height(),.055);return max(d,min(p.x,p.z)-.012);}
  if(kind<1.5){float wave=.003*sin(p.y*7.+p.x*4.)*sin(p.z*6.);return cylinder(p,.86+wave,height(),.055);}
  // A coherent rounded puree mound; surface ripples are spatial, not a painted image.
  vec3 q=p; q.y+=.13; q.xz/=vec2(1.08,.88);
  float d=(length(q/vec3(1.,.65,1.))-1.)*.65;
  d=max(d,-p.y-.43);
  float r=length(p.xz);float a=atan(p.z,p.x);
  float swirl=.012*sin(r*38.-a*2.)*smoothstep(.12,.8,r)*smoothstep(-.1,.35,p.y);
  return d+swirl;
}
vec3 normal(vec3 p){vec2 e=vec2(.001,0);return normalize(vec3(sdf(p+e.xyy)-sdf(p-e.xyy),sdf(p+e.yxy)-sdf(p-e.yxy),sdf(p+e.yyx)-sdf(p-e.yyx)));}
float shadow(vec3 p,vec3 l){float s=1.,t=.025;for(int i=0;i<24;i++){float h=sdf(p+l*t);s=min(s,8.*h/t);t+=clamp(h,.03,.15);if(t>2.5)break;}return clamp(s,.0,1.);}
void main(){
  vec3 forward=normalize(-eye),right=normalize(cross(forward,vec3(0,1,0))),up=cross(right,forward);
  vec2 v=uv; v.x*=resolution.x/resolution.y;
  vec3 rd=normalize(forward*2.3+right*v.x+up*v.y);
  float t=0.;bool hit=false;
  for(int i=0;i<112;i++){float d=sdf(eye+rd*t);if(d<.0014){hit=true;break;}t+=max(d*.8,.0008);if(t>8.)break;}
  if(!hit){gl_FragColor=vec4(background,1.);return;}
  vec3 p=eye+rd*t,n=normal(p);
  float fine=noise(p*130.), mid=noise(p*36.), coarse=noise(p*8.);
  // Microstructure changes local normals as well as albedo.
  vec3 bump=vec3(noise(p*95.+vec3(1,0,0)),noise(p*95.+vec3(0,1,0)),noise(p*95.+vec3(0,0,1)))-.5;
  n=normalize(n+bump*(kind<.5?.09:.055)*grain);
  float h=(p.y+height())/(height()*2.);
  vec3 base=layerColors[0];
  float boundary=h+.006*sin(p.x*11.+p.z*7.)+.003*sin(p.z*29.);
  // Select existing phases only. The top surface can exceed normalized height 1
  // slightly; it must retain the final layer rather than read an unused color.
  for(int i=1;i<8;i++){if(i<layerCount && boundary>layerEnds[i-1])base=layerColors[i];}
  float variation=(fine-.5)*.025+(mid-.5)*.035+(coarse-.5)*.02;
  base*=1.+variation;
  if(kind<.5){
    float rind=smoothstep(.91,.99,length(p.xz));
    base=mix(base,base*vec3(1.015,.955,.79),rind*.45);
    float pores=smoothstep(.82,.96,noise(p*54.));base*=1.-pores*.1;
  } else if(fruitShare>.01){float seeds=smoothstep(.93,.98,noise(p*98.));base*=1.-seeds*.12*fruitShare;}
  vec3 light=normalize(vec3(-.6,1.5,1.8));
  float diffuse=max(dot(n,light),0.);
  float ambient=.67+.10*n.y;
  float occlusion=1.;for(int i=1;i<4;i++){float d=float(i)*.055;occlusion-=max(0.,d-sdf(p+n*d))*.9;}
  float shade=shadow(p+n*.008,light);
  vec3 halfv=normalize(light-rd);
  float gloss=pow(max(dot(n,halfv),0.),mix(85.,24.,roughness))*(1.-roughness)*.3;
  vec3 color=base*(ambient+diffuse*.28*shade)*occlusion+vec3(gloss);
  float rim=pow(1.-max(dot(n,-rd),0.),3.)*.025;
  color+=rim;
  gl_FragColor=vec4(clamp(color,0.,1.),1.);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const message = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(message); }
  return shader;
}

/** Creates and owns only its canvas and button; call dispose before replacing the view. */
export function mountScene(container, revision) {
  const doc = container.ownerDocument;
  const canvas = doc.createElement('canvas');
  canvas.setAttribute('aria-label', '3D-прототип: перетащите для вращения, используйте колесо для приближения. Стрелки вращают, плюс и минус меняют масштаб.');
  canvas.setAttribute('role', 'img'); canvas.tabIndex = 0;
  canvas.style.cssText = 'display:block;width:100%;height:100%;min-height:260px;background:#eceeec;touch-action:none;outline-offset:-3px';
  const button = doc.createElement('button');
  button.type = 'button'; button.textContent = '↻';
  button.style.cssText = 'position:absolute;right:16px;bottom:16px;width:34px;height:34px;min-width:34px;padding:0;border:1px solid #d3d7d2;border-radius:50%;background:#f7f8f6;color:#45594a;font:22px Arial;cursor:pointer;display:grid;place-items:center';
  const previousPosition = container.style.position;
  if (!previousPosition || previousPosition === 'static') container.style.position = 'relative';
  container.append(canvas, button);
  let disposed = false, rotating = false, yaw = .66, pitch = .34, distance = 3.65, frame = 0, lastTime = 0;
  let spec = visualSpec(revision), gl = null, program = null, buffer = null, shaders = [], observer;
  const listeners = [], pointers = new Map();
  const on = (node, event, callback, opts) => { node.addEventListener(event, callback, opts); listeners.push(() => node.removeEventListener(event, callback, opts)); };
  const setRotating = value => { rotating = Boolean(value); button.setAttribute('aria-pressed', String(rotating)); button.setAttribute('aria-label', rotating ? 'Остановить вращение' : 'Включить вращение'); button.title = button.getAttribute('aria-label'); schedule(); };
  const uniforms = {};
  let contextError = null;
  try {
    gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL недоступен в этом браузере.');
    shaders = [compile(gl, gl.VERTEX_SHADER, vertexSource), compile(gl, gl.FRAGMENT_SHADER, fragmentSource)];
    program = gl.createProgram(); shaders.forEach(s => gl.attachShader(program, s)); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(program, 'position'); gl.enableVertexAttribArray(pos); gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['resolution','eye','kind','roughness','grain','compactness','fruitShare','layerCount','layerColors[0]','layerEnds[0]']) uniforms[name] = gl.getUniformLocation(program, name);
  } catch (e) { contextError = '3D недоступно: ' + e.message; container.dataset.sceneError = contextError; button.hidden = true; }
  function render(time) {
    frame = 0; if (disposed || !gl || !program || contextError) return;
    if (rotating && lastTime) yaw += Math.min((time-lastTime)/1000,.05)*.22;
    lastTime = time;
    const r = canvas.getBoundingClientRect();
    const scale = Math.min(globalThis.devicePixelRatio || 1, 1.5, 1000 / Math.max(r.width, 1));
    const width = Math.max(1,Math.round(r.width*scale)), height = Math.max(1,Math.round(r.height*scale));
    if (canvas.width !== width || canvas.height !== height) {canvas.width=width;canvas.height=height;}
    gl.viewport(0,0,width,height); gl.clearColor(236/255,238/255,236/255,1); gl.clear(gl.COLOR_BUFFER_BIT);
    if (spec.supported) {
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution,width,height);
      gl.uniform3f(uniforms.eye,Math.sin(yaw)*Math.cos(pitch)*distance,Math.sin(pitch)*distance,Math.cos(yaw)*Math.cos(pitch)*distance);
      gl.uniform1f(uniforms.kind,spec.structure==='pressed_cheese'?0:spec.structure==='layered'?1:2);
      for(const name of ['roughness','grain','compactness','fruitShare'])gl.uniform1f(uniforms[name],spec[name]);
      const colors = new Float32Array(24), ends = new Float32Array(8).fill(2); let cumulative=0;
      spec.layers.forEach((l,i)=>{colors.set(l.color,i*3); cumulative+=l.share; ends[i]=cumulative;});
      gl.uniform1i(uniforms.layerCount,spec.layers.length); gl.uniform3fv(uniforms['layerColors[0]'],colors);gl.uniform1fv(uniforms['layerEnds[0]'],ends);
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
    if(rotating && spec.supported) schedule();
  }
  function schedule(){if(!disposed&&!frame)frame=requestAnimationFrame(render);}
  on(button,'click',()=>setRotating(!rotating));
  on(canvas,'pointerdown',e=>{canvas.focus(); canvas.setPointerCapture?.(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});});
  on(canvas,'pointermove',e=>{
    const old=pointers.get(e.pointerId);if(!old)return;
    const other=[...pointers].find(([id])=>id!==e.pointerId)?.[1];
    if(other){const a=Math.hypot(old.x-other.x,old.y-other.y), b=Math.hypot(e.clientX-other.x,e.clientY-other.y);if(b>0)distance=clamp(distance*a/b,2.5,6.5);}
    else {yaw-=(e.clientX-old.x)*.009;pitch=clamp(pitch+(e.clientY-old.y)*.007,-.3,1.2);}
    pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});schedule();
  });
  for(const event of ['pointerup','pointercancel','lostpointercapture'])on(canvas,event,e=>pointers.delete(e.pointerId));
  on(canvas,'wheel',e=>{e.preventDefault();distance=clamp(distance*Math.exp(clamp(e.deltaY,-100,100)*.0015),2.5,6.5);schedule();},{passive:false});
  on(canvas,'keydown',e=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(e.key))return;
    e.preventDefault();if(e.key==='ArrowLeft')yaw-=.12;if(e.key==='ArrowRight')yaw+=.12;if(e.key==='ArrowUp')pitch=clamp(pitch+.1,-.3,1.2);if(e.key==='ArrowDown')pitch=clamp(pitch-.1,-.3,1.2);if(e.key==='+'||e.key==='=')distance=clamp(distance*.9,2.5,6.5);if(e.key==='-')distance=clamp(distance*1.1,2.5,6.5);schedule();
  });
  on(canvas,'webglcontextlost',e=>{e.preventDefault();contextError='Контекст WebGL потерян. Откройте карточку повторно.';container.dataset.sceneError=contextError;button.hidden=true;});
  if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(schedule);observer.observe(container);}
  else on(globalThis,'resize',schedule);
  canvas.dataset.structure=spec.structure;button.disabled=!spec.supported;
  setRotating(false); schedule();
  return {
    get error(){return contextError;},
    update(next){spec=visualSpec(next);canvas.dataset.structure=spec.structure;button.disabled=!spec.supported;schedule();return spec;},
    setRotating,
    dispose(){if(disposed)return;disposed=true;if(frame)cancelAnimationFrame(frame);observer?.disconnect();listeners.forEach(fn=>fn());pointers.clear();if(gl){if(buffer)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);shaders.forEach(s=>gl.deleteShader(s));}canvas.remove();button.remove();container.style.position=previousPosition;delete container.dataset.sceneError;},
  };
}
