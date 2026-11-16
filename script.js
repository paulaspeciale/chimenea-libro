import * as THREE from "https://esm.sh/three@0.156.1";
import { GLTFLoader } from "https://esm.sh/three@0.156.1/examples/jsm/loaders/GLTFLoader.js";
import { EffectComposer } from "https://esm.sh/three@0.156.1/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://esm.sh/three@0.156.1/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://esm.sh/three@0.156.1/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "https://esm.sh/three@0.156.1/examples/jsm/postprocessing/OutputPass.js";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ====================== SUPABASE ====================== */
const SUPABASE_URL = 'https://ospgjbtkvejwovcrcclm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_dXRkYKMOoyHanBw_re-s1g_I5Y_gD2U';

const db = (SUPABASE_URL !== 'TU_SUPABASE_URL')
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

/** Guarda una frase en libro_horrible (fire & forget) */
function savePhrase(text) {
  if (!db || !text.trim()) return;
  db.from('libro_horrible')
    .insert({ text: text.trim() })
    .then(({ error }) => { if (error) console.warn('Supabase:', error.message); });
}

/* ====================== CHIMENEA ====================== */
class FireplaceApp {
  constructor(container) {
    this.container = container;
    this.gltfFile  = "https://assets.codepen.io/264161/fireplace9.glb";
    this.noiseFile = "https://assets.codepen.io/264161/noise_1.jpg";
    this.fireBoostT0 = null;       // instante (en this.time) donde arrancó el último "boost"
    this.fireBoostDuration = 0;    // duración del boost, en segundos
    this.fireBoostPeak = 1;        // cuánto crece como máximo (1 = normal, >1 = impacto)
    this.flareT0 = null;           // instante del fogonazo de impacto
    this.flareDur = 0;
    this.shakeT0 = null;           // instante del último temblor de cámara
    this.shakeDur = 0;
    this.shakeAmp = 0;
    this._basePixelRatio = window.devicePixelRatio || 1;
    this._lowQuality = false;
    this.loadAssets().catch(console.error);
  }

  get cW() { return this.container.clientWidth; }
  get cH() { return this.container.clientHeight; }

  async loadAssets() {
    const gltfLoader = new GLTFLoader();
    gltfLoader.setCrossOrigin("anonymous");
    const textureLoader = new THREE.TextureLoader();
    textureLoader.setCrossOrigin("anonymous");

    const [model, noise] = await Promise.all([
      new Promise(r => gltfLoader.load(this.gltfFile, g => r(g.scene))),
      new Promise(r => textureLoader.load(this.noiseFile, t => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping; r(t);
      }))
    ]);
    this.model = model;
    this.noiseTexture = noise;
    this.initApp();
  }

  initApp() {
    this.clock = new THREE.Clock();
    this.time = 0;
    this.fireSpeed = 1;

    this.basicVert = document.getElementById("basicVert").textContent;
    this.rgbLightmapFrag = document.getElementById("rgbLightmapFrag").textContent;
    this.fireVert = document.getElementById("fireVert").textContent;
    this.fireFrag = document.getElementById("fireFrag").textContent;
    this.ashesFrag = document.getElementById("ashesFrag").textContent;

    this.createScene();
    this.createFireplace();
    this.createFire();
    this.createAshes();
    this.createEmbers();
    this.createRenderer();
    this.createPostProcessing();
    window.addEventListener("resize", () => this.onWindowResize());
    this.draw();
  }

  createScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, this.cW / this.cH, 0.1, 10);
    this.camera.position.set(0, 0.5, 1.5);
    this.scene.add(this.camera);
  }

  createFireplace() {
    this.fireplace = this.model.getObjectByName("fireplace");
    this.floor = this.model.getObjectByName("floor");

    this.fireplaceMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.fireplace.material.map }, ratioR: { value: 0 }, ratioG: { value: 1 }, ratioB: { value: 0 }, gamma: { value: 1 } },
      vertexShader: this.basicVert,
      fragmentShader: this.rgbLightmapFrag
    });
    this.fireplace.material = this.fireplaceMat;

    this.floorMat = this.fireplaceMat.clone();
    this.floorMat.uniforms.map.value = this.floor.material.map;
    this.floor.material = this.floorMat;

    this.scene.add(this.fireplace);
    this.scene.add(this.floor);
  }

  createFire() {
    this.fireMat = new THREE.ShaderMaterial({
      uniforms: {
        noiseMap: { value: this.noiseTexture },
        time: { value: 0 },
        opacity: { value: 1 },
        intensity: { value: 1 },
        stylizeRatio: { value: 0.5 },
        stylizeThreshold: { value: 0.5 },
        grayscale: { type: "b", value: false },
        details: { value: 0.5 }
      },
      side: THREE.DoubleSide,
      transparent: false,
      blending: THREE.AdditiveBlending,
      vertexShader: this.fireVert,
      fragmentShader: this.fireFrag
    });

    const geom = new THREE.CylinderGeometry(0.03, 0.2, 0.35, 15, 15, true, -Math.PI/2, Math.PI);
    geom.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0.1, 0));
    this.fire = new THREE.Mesh(geom, this.fireMat);
    this.fire.position.set(0.1, -0.1, 0);
    this.fire.rotation.y = -Math.PI / 2;
    this.fireplace.add(this.fire);

    // Posición del fuego en coordenadas de mundo: las brasas viven en la
    // escena (no dentro del modelo) para que suban libres por el hueco.
    this.scene.updateMatrixWorld(true);
    this.fireOrigin = new THREE.Vector3();
    this.fire.getWorldPosition(this.fireOrigin);
  }

  createAshes() {
    this.ashesMat = new THREE.ShaderMaterial({
      uniforms: { noiseMap: { value: this.noiseTexture }, intensity: { value: 1 }, time: { value: 0 } },
      side: THREE.DoubleSide,
      transparent: false,
      blending: THREE.MultiplyBlending,
      vertexShader: this.fireVert,
      fragmentShader: this.ashesFrag
    });

    const geom = new THREE.CylinderGeometry(0.15, 0.15, 0.4, 15, 15, true, -Math.PI/2, Math.PI);
    this.ashes = new THREE.Mesh(geom, this.ashesMat);
    this.ashes.position.set(0.1, 0.1, 0);
    this.ashes.rotation.y = -Math.PI / 2;
    this.fireplace.add(this.ashes);
  }

  /**
   * Brasas 3D que suben desde la base del fuego y se apagan al llegar
   * arriba. Se dibujan como THREE.Points con un shader mínimo: cada
   * partícula tiene tamaño, opacidad y color propios (el gradiente del
   * shader evita necesitar una textura). Con AdditiveBlending se funden
   * con las llamas y el bloom las realza.
   */
  createEmbers() {
    const COUNT = 44;
    const origin = this.fireOrigin || new THREE.Vector3(0, 0, 0);
    this.emberOrigin = new THREE.Vector3(origin.x, origin.y - 0.09, origin.z + 0.02);

    const positions = new Float32Array(COUNT * 3);
    const sizes    = new Float32Array(COUNT);
    const alphas   = new Float32Array(COUNT);
    const seeds    = new Float32Array(COUNT);

    this.emberParts = [];
    for (let i = 0; i < COUNT; i++) {
      const p = this.spawnEmberData(true);
      this.emberParts.push(p);
      positions[i * 3]     = p.x0;
      positions[i * 3 + 1] = p.y0;
      positions[i * 3 + 2] = p.z0;
      sizes[i]  = p.size;
      seeds[i]  = p.seed;
      alphas[i] = 0;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setAttribute("aSize",    new THREE.BufferAttribute(sizes, 1));
    geom.setAttribute("aAlpha",   new THREE.BufferAttribute(alphas, 1));
    geom.setAttribute("aSeed",    new THREE.BufferAttribute(seeds, 1));

    this.emberMat = new THREE.ShaderMaterial({
      uniforms: {
        // gl_PointSize se mide en píxeles del framebuffer: sin este factor,
        // las brasas se verían la mitad de grandes en pantallas retina.
        uPixelRatio: { value: this._basePixelRatio || 1 },
      },
      vertexShader: `
        uniform float uPixelRatio;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aSeed;
        varying float vAlpha;
        varying float vSeed;
        void main() {
          vAlpha = aAlpha;
          vSeed = aSeed;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (280.0 / max(0.2, -mvPosition.z)) * uPixelRatio;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vSeed;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          float core = smoothstep(0.5, 0.04, r);
          core *= core;
          vec3 hot = mix(vec3(1.0, 0.84, 0.46), vec3(1.0, 0.40, 0.10), vSeed);
          gl_FragColor = vec4(hot, core * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });

    this.embers = new THREE.Points(geom, this.emberMat);
    this.embers.frustumCulled = false; // se mueven fuera de su caja original
    this.scene.add(this.embers);
  }

  spawnEmberData(randomAge = false) {
    const o = this.emberOrigin;
    const life = 1.7 + Math.random() * 2.1;
    return {
      x0: o.x + (Math.random() - 0.5) * 0.26,
      y0: o.y + (Math.random() - 0.5) * 0.05,
      z0: o.z + (Math.random() - 0.5) * 0.12,
      rise: 0.07 + Math.random() * 0.15,
      amp: 0.012 + Math.random() * 0.032,
      sway: 0.6 + Math.random() * 1.7,
      phase: Math.random() * Math.PI * 2,
      life,
      age: randomAge ? Math.random() * life * 0.9 : 0,
      size: 0.012 + Math.random() * 0.026,
      seed: Math.random(),
    };
  }

  updateEmbers(dt, boost = 0) {
    if (!this.embers) return;
    const posAttr = this.embers.geometry.attributes.position;
    const alphaAttr = this.embers.geometry.attributes.aAlpha;
    const pos = posAttr.array;
    const alpha = alphaAttr.array;
    // El impacto acelera la subida y enciende más brasas
    const speed = 0.75 + boost * 0.75;

    for (let i = 0; i < this.emberParts.length; i++) {
      let p = this.emberParts[i];
      p.age += dt * speed;
      if (p.age >= p.life) {
        this.emberParts[i] = p = this.spawnEmberData(false);
      }
      const t = p.age / p.life;
      const fadeIn  = Math.min(1, t / 0.16);
      const fadeOut = Math.min(1, (1 - t) / 0.55);

      pos[i * 3]     = p.x0 + Math.sin(p.age * p.sway + p.phase) * p.amp;
      pos[i * 3 + 1] = p.y0 + p.rise * p.age * (1 + boost * 0.7);
      pos[i * 3 + 2] = p.z0 + Math.cos(p.age * p.sway * 0.8 + p.phase) * p.amp * 0.7;

      alpha[i] = fadeIn * fadeOut * (0.5 + 0.5 * p.seed) * (0.7 + boost * 0.6);
    }

    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  createRenderer() {
    const canvas = this.container.querySelector("canvas.webgl");
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(this._basePixelRatio);
    this.renderer.setSize(this.cW, this.cH);
    this.renderer.toneMapping = THREE.LinearToneMapping;
  }

  createPostProcessing() {
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1024, 1024), 0.25, 0.1, 0.8);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  /**
   * Baja el pixelRatio interno del renderer mientras se graba el reel.
   * Renderizar WebGL a resolución completa (2x/3x en pantallas retina)
   * Y componer el canvas del video en el mismo instante de rAF es lo
   * que más CPU/GPU compite con la animación de la hoja. Bajar a 1x
   * durante la grabación no se nota a simple vista (la atención está
   * en la hoja) y libera margen justo cuando más se necesita.
   */
  setLowQuality(on) {
    if (!this.renderer) return;
    if (this._lowQuality === on) return;
    this._lowQuality = on;
    this.renderer.setPixelRatio(on ? 1 : this._basePixelRatio);
    this.renderer.setSize(this.cW, this.cH);
    this.composer.setSize(this.cW, this.cH);
    if (this.emberMat) {
      this.emberMat.uniforms.uPixelRatio.value = on ? 1 : this._basePixelRatio;
    }
  }

  draw() {
    const dt = this.clock.getDelta();
    this.time += dt;
    const boost = this.getFireBoost() * this.fireBoostPeak + this.getFlare();
    this.bloomPass.strength = 0.25 + boost * 0.45; // flash de brillo al crecer
    this.updateFire(boost);
    this.updateLight(boost);
    this.updateEmbers(dt, boost);

    // Temblor de cámara: el golpe de la hoja sacude la escena un instante
    const shake = this.getShake();
    this.camera.position.set(shake.x, 0.5 + shake.y, 1.5);

    this.composer.render();
    requestAnimationFrame(this.draw.bind(this));
  }

  /**
   * Hace crecer el fuego momentáneamente y lo devuelve a la normalidad
   * de forma gradual.
   * @param {number} durationMs duración total del crecimiento + retorno
   * @param {number} peak       cuánto crece (1 = normal, 1.6 = impacto fuerte)
   */
  growFire(durationMs = 4000, peak = 1) {
    if (!this.fireMat) return; // los assets todavía no cargaron
    this.fireBoostT0 = this.time;
    this.fireBoostDuration = durationMs / 1000;
    this.fireBoostPeak = peak;
  }

  /**
   * Reacción de impacto: fogonazo (sumado al crecimiento que ya venía
   * sucediendo, sin reiniciarlo) + temblor de cámara. Se llama justo
   * cuando la hoja termina de entrar en las llamas.
   */
  burst() {
    this.flareT0 = this.time;
    this.flareDur = 1.25;
    this.fireBoostPeak = Math.max(this.fireBoostPeak, 1);
    this.shakeT0 = this.time;
    this.shakeDur = 1.05;
    this.shakeAmp = 0.026;
  }

  // Fogonazo del impacto: sube en ~60ms y decae con una curva suave.
  // Se suma al boost normal para que no haya un "bajón" al golpear.
  getFlare() {
    if (this.flareT0 == null) return 0;
    const elapsed = this.time - this.flareT0;
    if (elapsed < 0 || elapsed > this.flareDur) {
      this.flareT0 = null;
      return 0;
    }
    const p = elapsed / this.flareDur;
    const env = p < 0.06 ? p / 0.06 : Math.pow(1 - (p - 0.06) / 0.94, 2.2);
    return env * 1.1;
  }

  // 0 → 1 → 0 a lo largo de fireBoostDuration: sube el 70% del tiempo,
  // baja el 30% restante (crecimiento gradual, caída algo más rápida).
  getFireBoost() {
    if (this.fireBoostT0 == null) return 0;
    const elapsed = this.time - this.fireBoostT0;
    const dur = this.fireBoostDuration;
    if (elapsed < 0) return 0;
    if (elapsed > dur) { this.fireBoostT0 = null; return 0; }
    const p = elapsed / dur;
    const RISE = 0.7;
    return p < RISE ? p / RISE : 1 - (p - RISE) / (1 - RISE);
  }

  // Oscilación que decae tras el impacto. Usa senos de distinta
  // frecuencia (más un pequeño ruido) para no parecer un resorte perfecto.
  getShake() {
    if (this.shakeT0 == null) return { x: 0, y: 0 };
    const elapsed = this.time - this.shakeT0;
    if (elapsed < 0 || elapsed > this.shakeDur) {
      this.shakeT0 = null;
      return { x: 0, y: 0 };
    }
    const decay = 1 - elapsed / this.shakeDur;
    const amp = this.shakeAmp * decay * decay;
    return {
      x: Math.sin(elapsed * 52) * amp + (Math.random() - 0.5) * amp * 0.55,
      y: Math.cos(elapsed * 43) * amp * 0.75 + (Math.random() - 0.5) * amp * 0.55,
    };
  }

  updateFire(boost = 0) {
    // Las llamas van algo más rápidas cuando el fuego arrecia
    const speed = this.fireSpeed * (1 + boost * 0.22);
    this.fireMat.uniforms.time.value = this.time * speed;
    this.ashesMat.uniforms.time.value = this.time * speed;

    this.fireMat.uniforms.intensity.value = 1 + boost * 0.85;
    this.ashesMat.uniforms.intensity.value = 1 + boost * 0.3;

    const s = 1 + boost * 0.42;
    this.fire.scale.set(s, 1 + boost * 0.85, s);
    // Balanceo leve, como si las llamas se inclinaran hacia la hoja
    this.fire.rotation.z = Math.sin(this.time * 1.7) * 0.012 + boost * 0.02;
  }

  updateLight(boost = 0) {
    const t = this.time;
    const punch = 1 + boost * 0.4;
    const r = Math.abs(Math.sin(t) + Math.cos(t*4 + 0.1)*0.5) * 0.2;
    const g = Math.abs(Math.sin(t + Math.PI/2) + Math.cos(t*4 + 1.4)*0.5) * 0.2;
    const b = Math.abs(Math.sin(t + Math.PI)) * 0.2;

    this.floorMat.uniforms.ratioR.value = (0.1 + r*3) * punch;
    this.floorMat.uniforms.ratioG.value = (0.1 + g*3) * punch;
    this.floorMat.uniforms.ratioB.value = (0.1 + b*3) * punch;

    this.fireplaceMat.uniforms.ratioR.value = r*1.5 * punch;
    this.fireplaceMat.uniforms.ratioG.value = g*1.5 * punch;
    this.fireplaceMat.uniforms.ratioB.value = b*1.5 * punch;
  }

  onWindowResize() {
    this.renderer.setSize(this.cW, this.cH);
    this.composer.setSize(this.cW, this.cH);
    this.camera.aspect = this.cW / this.cH;
    this.camera.updateProjectionMatrix();
  }
}

/* ====================== FRASES ====================== */
// Caché local: se rellena la primera vez y se refresca cada CACHE_TTL ms
let _phrasesCache = [];
let _cacheTs      = 0;
const CACHE_TTL   = 5 * 60 * 1000; // 5 min — evita golpear la BD en cada rotación

async function fetchPhrases() {
  if (!db) return [];

  if (_phrasesCache.length && Date.now() - _cacheTs < CACHE_TTL)
    return _phrasesCache;

  const { data, error } = await db
    .from('libro_horrible')
    .select('text')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error || !data?.length) return _phrasesCache;

  _phrasesCache = data.map(r => r.text);
  _cacheTs      = Date.now();
  return _phrasesCache;
}

async function updateDynamicPhrase() {
  const el = document.getElementById("dynamicText");
  if (!el) return;

  el.style.opacity = "0";

  const phrases = await fetchPhrases();

  await new Promise(r => setTimeout(r, 350)); // esperar fade-out

  el.textContent = phrases.length
    ? phrases[Math.floor(Math.random() * phrases.length)]
    : "Las palabras aguardan ser escritas…";

  el.style.opacity = "1";
}

/* ====================== INICIO ====================== */
let fireplaceApp = null;
const container = document.querySelector(".fireplace-container");
if (container) fireplaceApp = new FireplaceApp(container);

/* ====================== SONIDO DE FUEGO ======================
   Los navegadores bloquean el autoplay con sonido sin gesto del
   usuario, así que el propio click en el botón es ese gesto: no hace
   falta detectar interacción en otro lado. El volumen se anima con
   rAF (no CSS/WAAPI porque no es una propiedad visual) para evitar
   el "salto" de encender/apagar de golpe.
   ================================================================= */

// Se reemplaza dentro de initFireSound(); no-op si el audio nunca se activó
// o si initFireSound aún no corrió (llamada segura desde cualquier lugar).
let boostFireAudio = () => {};

function initFireSound() {
  const audio  = document.getElementById("fireAmbience");
  const toggle = document.getElementById("soundToggle");
  if (!audio || !toggle) return;

  const TARGET_VOLUME = 0.55;
  const FADE_MS = 900;
  audio.volume = 0;

  let fadeHandle = null;
  function fadeTo(target, onDone) {
    if (fadeHandle) cancelAnimationFrame(fadeHandle);
    const start = audio.volume;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / FADE_MS);
      audio.volume = start + (target - start) * p;
      if (p < 1) {
        fadeHandle = requestAnimationFrame(step);
      } else if (onDone) {
        onDone();
      }
    };
    fadeHandle = requestAnimationFrame(step);
  }

  toggle.addEventListener("click", async () => {
    if (audio.paused) {
      try {
        await audio.play();
        fadeTo(TARGET_VOLUME);
        toggle.textContent = "🔊";
        toggle.dataset.playing = "true";
      } catch (err) {
        // Bloqueado por el navegador o el archivo aún no existe en el repo
        console.warn("No se pudo reproducir el sonido del fuego:", err);
      }
    } else {
      fadeTo(0, () => audio.pause());
      toggle.textContent = "🔇";
      toggle.dataset.playing = "false";
    }
  });

  // Sube el volumen momentáneamente (el fuego "crece") y lo devuelve al
  // nivel ambiente. No hace nada si el usuario nunca activó el sonido.
  boostFireAudio = (durationMs = 4000, extraVolume = 0.22) => {
    if (audio.paused) return;
    const peak = Math.min(1, TARGET_VOLUME + extraVolume);
    fadeTo(peak, () => {
      const holdMs = Math.max(0, durationMs - FADE_MS * 2);
      setTimeout(() => fadeTo(TARGET_VOLUME), holdMs);
    });
  };
}

/* ====================== UTILIDADES DE EASING / INTERPOLACIÓN ======================
   Para grabar el reel sin leer getComputedStyle() en cada frame (eso fuerza
   un recálculo de estilo síncrono que compite con la animación real de
   WAAPI por el hilo principal — la causa más común de un video "trabado"
   incluso cuando la animación en pantalla se ve fluida), la pose de la
   hoja se calcula puramente en JS a partir del tiempo transcurrido, usando
   las mismas curvas de easing y los mismos keyframes que ya definimos.
   Una sola fuente de verdad matemática en vez de leer el DOM.
   =================================================================== */

// Evaluador de cubic-bezier(x1,y1,x2,y2) — igual al que usan los navegadores
// para "easing" en CSS/WAAPI. Newton-Raphson con fallback a bisección.
function makeCubicBezier(x1, y1, x2, y2) {
  const A = (a1, a2) => 1.0 - 3.0 * a2 + 3.0 * a1;
  const B = (a1, a2) => 3.0 * a2 - 6.0 * a1;
  const C = (a1) => 3.0 * a1;

  const bezierX = (t) => ((A(x1, x2) * t + B(x1, x2)) * t + C(x1)) * t;
  const bezierY = (t) => ((A(y1, y2) * t + B(y1, y2)) * t + C(y1)) * t;
  const dBezierX = (t) => 3.0 * A(x1, x2) * t * t + 2.0 * B(x1, x2) * t + C(x1);

  return function solve(xTarget) {
    if (xTarget <= 0) return 0;
    if (xTarget >= 1) return 1;

    let t = xTarget;
    // Newton-Raphson (rápido, converge casi siempre en pocas iteraciones)
    for (let i = 0; i < 6; i++) {
      const dx = bezierX(t) - xTarget;
      const d = dBezierX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }

    // Fallback por bisección si Newton se fue de rango o no convergió
    if (t < 0 || t > 1 || Math.abs(bezierX(t) - xTarget) > 1e-4) {
      let lo = 0, hi = 1;
      t = xTarget;
      for (let i = 0; i < 20; i++) {
        const x = bezierX(t);
        if (Math.abs(x - xTarget) < 1e-5) break;
        if (x < xTarget) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
    }

    return bezierY(t);
  };
}

const EASE_RATTLE   = makeCubicBezier(0.36, 0.07, 0.19, 0.97);
const EASE_SHOWCASE = makeCubicBezier(0.34, 1.56, 0.64, 1);
// ease-in-out: el papel arranca con el impulso del tirón y frena al
// entrar en las llamas (antes era solo ease-out y se sentía "flotando").
const EASE_THROW    = makeCubicBezier(0.33, 0, 0.45, 1);
const EASE_WINDUP   = makeCubicBezier(0.4, 0, 0.55, 1);

function lerp(a, b, p) { return a + (b - a) * p; }

// Interpola entre una lista de "poses" {offset, x, y, rotate, tiltX, tiltY,
// scale, opacity, brightness, sepia, blur} — el mismo concepto que un set de
// keyframes de WAAPI, pero representado como números en vez de strings de
// `transform`. Los campos opcionales se tratan como 0 para que las poses
// antiguas (sin inclinación 3D) sigan funcionando.
function samplePoseList(list, easedProgress) {
  if (easedProgress <= list[0].offset) return list[0];
  const last = list[list.length - 1];
  if (easedProgress >= last.offset) return last;

  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    if (easedProgress >= a.offset && easedProgress <= b.offset) {
      const span = b.offset - a.offset || 1;
      const p = (easedProgress - a.offset) / span;
      return {
        x: lerp(a.x, b.x, p),
        y: lerp(a.y, b.y, p),
        rotate: lerp(a.rotate, b.rotate, p),
        tiltX: lerp(a.tiltX || 0, b.tiltX || 0, p),
        tiltY: lerp(a.tiltY || 0, b.tiltY || 0, p),
        scale: lerp(a.scale, b.scale, p),
        opacity: lerp(a.opacity, b.opacity, p),
        brightness: lerp(a.brightness ?? 1, b.brightness ?? 1, p),
        sepia: lerp(a.sepia || 0, b.sepia || 0, p),
        blur: lerp(a.blur || 0, b.blur || 0, p),
      };
    }
  }
  return last;
}

// Convierte una pose numérica en un `transform` de CSS. El `perspective()`
// va primero para que las inclinaciones rotateX/rotateY se vean como una
// hoja real girando en el aire y no como un simple escalado.
function poseToTransform(p) {
  return (
    `perspective(1000px) translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0) ` +
    `rotate(${p.rotate.toFixed(2)}deg) ` +
    `rotateY(${(p.tiltY || 0).toFixed(2)}deg) ` +
    `rotateX(${(p.tiltX || 0).toFixed(2)}deg) ` +
    `scale(${p.scale.toFixed(4)})`
  );
}

// Keyframe de WAAPI a partir de una pose (transform + opacidad + filtros)
function poseToKeyframe(p) {
  const blur = p.blur ? ` blur(${p.blur}px)` : "";
  return {
    transform: poseToTransform(p),
    opacity: p.opacity,
    filter: `brightness(${p.brightness ?? 1}) sepia(${p.sepia || 0})${blur}`,
    offset: p.offset,
  };
}

/* ====================== GRABACIÓN DE VIDEO (REEL 9:16) ======================
   Compone en un canvas propio — sin pedir permiso de captura de pantalla —
   solo la chimenea y el libro, recortados al centro de la ventana en
   formato vertical 9:16, durante toda la secuencia: reposo (se lee lo
   escrito) + tirón + exhibición + lectura + vuelo al fuego. Dura ~18s en
   total (ver THROW_TIMING). Se graba con MediaRecorder sobre
   canvas.captureStream().

   Por qué esto y no getDisplayMedia(): captureStream() de un <canvas> que
   nosotros mismos dibujamos no dispara ningún diálogo del navegador, así
   que cualquier visitante puede generar su reel con un solo click.

   Estrategia de dibujo por frame:
     · Chimenea → drawImage() directo del <canvas class="webgl"> (ya es
       una imagen renderizada, no hace falta reconstruir nada)
     · Libro    → drawImage() directo de la <img> de la portada
     · Hoja voladora → la pose (posición/rotación/escala/opacidad/brillo)
       se calcula matemáticamente a partir del tiempo transcurrido y las
       mismas curvas de easing que usa la animación real (ver utilidades
       de arriba), en vez de leerla del DOM con getComputedStyle(). Esto
       evita el forced reflow que competía con WAAPI por el hilo principal.
   ============================================================================ */
const REEL_WIDTH  = 1080;
const REEL_HEIGHT = 1920;

function pickVideoMimeType() {
  if (!window.MediaRecorder) return "";
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4;codecs=h264,aac", // Safari
    "video/mp4",
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

// El recorte 9:16 más grande que entra centrado en la ventana actual —
// en desktop recorta los costados, en pantallas angostas recorta arriba/abajo.
function computeCropRect() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const targetRatio = REEL_WIDTH / REEL_HEIGHT;

  let cropW, cropH;
  if (vw / vh > targetRatio) {
    cropH = vh;
    cropW = vh * targetRatio;
  } else {
    cropW = vw;
    cropH = vw / targetRatio;
  }

  return {
    x: (vw - cropW) / 2,
    y: (vh - cropH) / 2,
    scale: REEL_WIDTH / cropW, // == REEL_HEIGHT / cropH
  };
}

// Copia un elemento visible en pantalla (canvas o img) al canvas de salida,
// mapeando su posición real de viewport al recorte 9:16.
function drawScreenElement(ctx, source, naturalW, naturalH, crop) {
  const rect = source.getBoundingClientRect();
  const dx = (rect.left - crop.x) * crop.scale;
  const dy = (rect.top  - crop.y) * crop.scale;
  const dw = rect.width  * crop.scale;
  const dh = rect.height * crop.scale;
  if (dw <= 0 || dh <= 0 || !naturalW || !naturalH) return;
  ctx.drawImage(source, 0, 0, naturalW, naturalH, dx, dy, dw, dh);
}

// Mismo polígono que el clip-path del CSS (.flying-page), en % — el borde
// izquierdo rasgado, los otros tres lados limpios.
const TORN_EDGE_POINTS = [
  [0, 0], [100, 0], [100, 100], [0, 100],
  [3, 93], [0, 86], [5, 79], [1, 72], [7, 65], [0, 57],
  [4, 50], [1, 43], [6, 36], [0, 28], [4, 21], [1, 14], [5, 7], [0, 0],
];

function wrapCanvasText(ctx, text, maxWidth) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Pre-renderiza el "sprite" de la hoja (forma rasgada + degradé + rayas +
 * texto) UNA sola vez por grabación, ya que ninguno de esos detalles
 * cambia durante los ~17s del clip — solo se mueve/rota/escala como un
 * todo. Esto evita repetir measureText/gradientes/paths en cada frame,
 * que era la causa principal del video entrecortado.
 *
 * `metrics` replica las medidas del texto real en el DOM (ver
 * fitPageText) para que el mensaje se vea igual de grande en el video.
 */
function buildFlyingPageSprite(destW, destH, text, metrics = {}) {
  const sprite = document.createElement("canvas");
  sprite.width  = Math.max(1, Math.round(destW));
  sprite.height = Math.max(1, Math.round(destH));
  const ctx = sprite.getContext("2d");

  // Forma rasgada — se recorta todo lo que sigue a este path
  ctx.beginPath();
  TORN_EDGE_POINTS.forEach(([px, py], i) => {
    const x = (px / 100) * destW;
    const y = (py / 100) * destH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.clip();

  const grad = ctx.createRadialGradient(
    destW * 0.35, destH * 0.45, destW * 0.05,
    destW * 0.35, destH * 0.45, destW * 0.9
  );
  grad.addColorStop(0,   "#f6ead1");
  grad.addColorStop(0.5, "#ede0c2");
  grad.addColorStop(1,   "#e5d3ae");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, destW, destH);

  ctx.strokeStyle = "rgba(120, 90, 55, 0.22)";
  ctx.lineWidth = Math.max(1, destH * 0.006);
  for (let y = destH * 0.12; y < destH; y += destH * 0.12) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(destW, y);
    ctx.stroke();
  }

  const fontPx = Math.max(8, destH * (metrics.fontRatio || 0.055));
  const lineHeight = fontPx * (metrics.lineHeight || 1.55);
  ctx.fillStyle = "#3c2a18";
  ctx.font = `italic ${Math.round(fontPx)}px "Crimson Text", serif`;
  ctx.textAlign = "center";
  ctx.globalAlpha = 0.92;
  const lines = wrapCanvasText(ctx, text, destW * (metrics.widthRatio || 0.82));
  const startY = destH / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, destW / 2, startY + i * lineHeight));

  return sprite;
}

// Sprite de brasa (se genera una sola vez y se reutiliza en todos los frames)
let _emberSprite = null;
function getEmberSprite() {
  if (_emberSprite) return _emberSprite;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0,    "rgba(255, 252, 232, 1)");
  g.addColorStop(0.25, "rgba(255, 214, 110, 0.95)");
  g.addColorStop(0.55, "rgba(255, 140, 35, 0.62)");
  g.addColorStop(0.8,  "rgba(255, 90, 10, 0.18)");
  g.addColorStop(1,    "rgba(255, 80, 0, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _emberSprite = c;
  return c;
}

// Sprite de resplandor cálido (lectura / destello del impacto)
let _glowSprite = null;
function getGlowSprite() {
  if (_glowSprite) return _glowSprite;
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0,    "rgba(255, 236, 200, 0.95)");
  g.addColorStop(0.22, "rgba(255, 190, 105, 0.72)");
  g.addColorStop(0.5,  "rgba(255, 140, 45, 0.34)");
  g.addColorStop(0.78, "rgba(200, 70, 10, 0.1)");
  g.addColorStop(1,    "rgba(150, 40, 0, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  _glowSprite = c;
  return c;
}

// Traza la silueta rasgada en coordenadas LOCALES (centro = 0,0), para
// poder recortar la ceniza exactamente igual que el clip-path del DOM.
function traceTornPath(ctx, w, h) {
  ctx.beginPath();
  TORN_EDGE_POINTS.forEach(([px, py], i) => {
    const x = (px / 100 - 0.5) * w;
    const y = (py / 100 - 0.5) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

// Escala del div .page-char en función del progreso de quemado: replica
// exactamente los keyframes de playThrow (0.04 → 0.50 → 1.06 → 1.62).
function charScaleForBurn(burn) {
  const stops = [[0, 0.04], [0.4, 0.50], [0.72, 1.06], [1, 1.62]];
  for (let i = 1; i < stops.length; i++) {
    if (burn <= stops[i][0]) {
      const [p0, s0] = stops[i - 1];
      const [p1, s1] = stops[i];
      return s0 + (s1 - s0) * ((burn - p0) / (p1 - p0));
    }
  }
  return stops[stops.length - 1][1];
}

// Mancha de ceniza equivalente a la del DOM (.page-char): mismo centro
// móvil, mismo radio y mismos stops de color, recortada al papel.
// El div mide 160% del papel, nace en la esquina inferior derecha
// (transform-origin 74% 76%) y su degradado circular se escala con él.
function drawBurn(ctx, w, h, burn, timeSec) {
  if (burn <= 0) return;
  const flicker = 1 + Math.sin(timeSec * 21) * 0.035;
  const scale = charScaleForBurn(burn);
  const cx = w * 0.384 * (1 - scale);
  const cy = h * 0.416 * (1 - scale);
  const radius = Math.hypot(w, h) * 0.8 * scale * flicker;

  ctx.save();
  traceTornPath(ctx, w, h);
  ctx.clip();
  // La opacidad del div sube de 0.85 a 1 durante el primer 40%.
  ctx.globalAlpha *= Math.min(1, 0.85 + 0.375 * burn);

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  g.addColorStop(0,    "#050301");
  g.addColorStop(0.24, "#0c0602");
  g.addColorStop(0.40, "#1b0d04");
  g.addColorStop(0.54, "#43200a");
  g.addColorStop(0.64, "#8a3c0c");
  g.addColorStop(0.70, "#e0701a");
  g.addColorStop(0.74, "rgba(255, 175, 65, 0.9)");
  g.addColorStop(0.80, "rgba(255, 120, 30, 0.38)");
  g.addColorStop(0.88, "rgba(255, 90, 10, 0)");
  g.addColorStop(1,    "rgba(255, 90, 10, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(-w / 2, -h / 2, w, h);
  ctx.restore();
}

/**
 * Arranca la grabación del reel. Devuelve `null` si el navegador no
 * soporta MediaRecorder (nunca debe romper la animación principal).
 *
 * @param {Function} getPose función SIN argumentos que devuelve la pose
 *   actual de la hoja: { visible, x, y, rotate, tiltX, tiltY, scale,
 *   opacity, brightness, burn, embers, spotlight, impact } en
 *   píxeles/grados/unidad de página — ya relativa al centro original de
 *   la hoja (ver playThrow). No lee el DOM: es matemática pura, así que
 *   llamarla en cada frame de grabación no cuesta nada.
 */
function startReelRecording({
  webglCanvas,
  bookImg,
  baseBox,
  text,
  textMetrics,
  fireTarget,
  fireBox,
  getPose,
}) {
  const mimeType = pickVideoMimeType();
  if (!mimeType) return null;

  try {
    const crop = computeCropRect();
    const canvas = document.createElement("canvas");
    canvas.width = REEL_WIDTH;
    canvas.height = REEL_HEIGHT;
    const ctx = canvas.getContext("2d");

    const destW = baseBox.width  * crop.scale;
    const destH = baseBox.height * crop.scale;

    // Sprites / medidas pre-renderizados una sola vez (ver comentarios arriba)
    const pageSprite = buildFlyingPageSprite(destW, destH, text, textMetrics);
    const emberSprite = getEmberSprite();
    const glowSprite = getGlowSprite();

    const baseCenterX = (baseBox.left + baseBox.width  / 2 - crop.x) * crop.scale;
    const baseCenterY = (baseBox.top  + baseBox.height / 2 - crop.y) * crop.scale;

    const spotX = (window.innerWidth  / 2 - crop.x) * crop.scale;
    const spotY = (window.innerHeight / 2 - crop.y) * crop.scale;
    const spotW = baseBox.width * 2.9 * crop.scale;
    const spotH = baseBox.height * 2.2 * crop.scale;

    const fireX = fireTarget ? (fireTarget.x - crop.x) * crop.scale : spotX;
    const fireY = fireTarget ? (fireTarget.y - crop.y) * crop.scale : spotY;
    const fireW = (fireBox?.width || baseBox.width) * 1.5 * crop.scale;
    const fireH = (fireBox?.height || baseBox.height) * 1.1 * crop.scale;

    let running = true;
    let drawFailed = false;

    function drawGlow(sprite, x, y, w, h, alpha) {
      if (!(alpha > 0)) return;
      ctx.save();
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(sprite, x - w / 2, y - h / 2, w, h);
      ctx.restore();
    }

    function drawFlyingPage(pose) {
      if (!pose || !pose.visible || !(pose.opacity > 0)) return;

      // Inclinación 3D aproximada: el achatamiento por cos() basta para
      // que el papel parezca girar en el aire dentro del video 2D.
      const rx = (pose.tiltX || 0) * Math.PI / 180;
      const ry = (pose.tiltY || 0) * Math.PI / 180;
      const sx = pose.scale * Math.max(0.12, Math.cos(ry));
      const sy = pose.scale * Math.max(0.12, Math.cos(rx));

      ctx.save();
      ctx.globalAlpha = pose.opacity;
      if (pose.brightness && pose.brightness !== 1) {
        // Único filtro que se conserva en el video: brightness() es barato
        // (multiplicación por canal, sin muestreo de vecinos como blur()).
        try { ctx.filter = `brightness(${pose.brightness})`; } catch (_) { /* sin soporte */ }
      }

      ctx.translate(baseCenterX + pose.x * crop.scale, baseCenterY + pose.y * crop.scale);
      ctx.rotate((pose.rotate * Math.PI) / 180);
      ctx.scale(sx, sy);
      ctx.drawImage(pageSprite, -destW / 2, -destH / 2, destW, destH);
      ctx.filter = "none";
      drawBurn(ctx, destW, destH, pose.burn || 0, performance.now() / 1000);

      ctx.restore();
    }

    function drawEmbers(pose) {
      const list = pose?.embers;
      if (!list || !list.length) return;
      const sprite = emberSprite;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!(e.alpha > 0.01)) continue;
        const size = e.size * 4.2 * crop.scale;
        ctx.save();
        ctx.globalAlpha = Math.min(1, e.alpha);
        ctx.drawImage(
          sprite,
          (e.x - crop.x) * crop.scale - size / 2,
          (e.y - crop.y) * crop.scale - size / 2,
          size,
          size
        );
        ctx.restore();
      }
    }

    function frame() {
      if (!running) return;
      try {
        ctx.fillStyle = "#0e0603";
        ctx.fillRect(0, 0, REEL_WIDTH, REEL_HEIGHT);

        if (webglCanvas) drawScreenElement(ctx, webglCanvas, webglCanvas.width, webglCanvas.height, crop);
        if (bookImg?.complete) drawScreenElement(ctx, bookImg, bookImg.naturalWidth, bookImg.naturalHeight, crop);

        const pose = getPose();
        if (pose) {
          drawGlow(glowSprite, spotX, spotY, spotW, spotH, (pose.spotlight || 0) * 0.34);
          drawFlyingPage(pose);
          drawEmbers(pose);
          if (pose.impact > 0) {
            drawGlow(glowSprite, fireX, fireY, fireW, fireH, pose.impact * 0.85);
          }
        }
      } catch (err) {
        // Canvas "manchado" por CORS u otro error de dibujo: abortamos la
        // grabación en silencio, la animación real en pantalla no se toca.
        drawFailed = true;
        running = false;
        console.warn("Grabación de reel interrumpida:", err);
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000, // el default del navegador suele ser
      // bajo para 1080x1920 con movimiento rápido — a menor bitrate, más
      // se nota como "trabado"/borroso durante el vuelo de la hoja.
    });
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start();

    return {
      mimeType,
      stop: () =>
        new Promise((resolve) => {
          running = false;
          if (drawFailed || recorder.state === "inactive") {
            resolve(null);
            return;
          }
          recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
          recorder.stop();
        }),
    };
  } catch (err) {
    console.warn("No se pudo iniciar la grabación del reel:", err);
    return null;
  }
}

function offerReelDownload(blob, mimeType) {
  const link = document.getElementById("reelDownload");
  if (!link || !blob) return;

  const url = URL.createObjectURL(blob);
  const ext = mimeType.includes("mp4") ? "mp4" : "webm";

  link.href = url;
  link.download = `libro-horrible-${Date.now()}.${ext}`;
  link.hidden = false;
  requestAnimationFrame(() => link.classList.add("visible"));

  // Liberar memoria si nadie lo descarga en un tiempo prudente
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
}

/* ====================== ANIMACIÓN DE HOJA AL FUEGO ======================
   Toda la secuencia (tirón → exhibición → lectura → impulso → vuelo →
   incendio → impacto) es una cadena de animaciones WAAPI encadenadas con
   async/await. Ventajas sobre el enfoque anterior (clase CSS + transition
   + setTimeout):
     · Una sola fuente de verdad para los tiempos (THROW_TIMING)
     · Sin reflow forzado: WAAPI no necesita que el navegador "confirme"
       un estado intermedio antes de animar, como sí ocurre al mezclar
       transiciones CSS con animate()
     · Cada fase arranca exactamente donde terminó la anterior porque
       se usa `fill:"forwards"` + `.finished`, no un temporizador que
       intenta adivinar cuándo terminó la fase previa
   El quemado se simula con una mancha de ceniza que crece desde la
   esquina inferior derecha + chispas que salen del borde del papel. La
   mancha se anima SOLO con transform/opacity (compositor) y las chispas
   son pocas decenas de spans, así que el costo es mínimo.
   Nota de rendimiento: la animación visual en pantalla NO usa blur()
   salvo en el instante final (hoja ya minúscula, pocos píxeles a
   difuminar). blur() es, con diferencia, la operación de `filter` más
   cara en el compositor — sostenerla durante todo el vuelo (cuando la
   hoja todavía es grande) es lo que más "tranco" genera.
   ========================================================================= */
const THROW_TIMING = Object.freeze({
  introMs       : 5600,  // la hoja queda quieta sobre el libro, mostrando lo escrito
  rattleMs      : 520,   // tirón inicial (arranque del papel)
  showMs        : 820,   // transición hacia el centro (exhibición)
  readMs        : 4200,  // tiempo que el mensaje queda legible en el centro
  windupMs      : 380,   // impulso hacia atrás antes de lanzar
  throwMs       : 2700,  // vuelo hasta el fuego (incluye el quemado)
  impactTailMs  : 2600,  // cola post-impacto: la grabación sigue mientras
  // el fuego reacciona (crece, arde y vuelve a la normalidad) para no
  // cortar el reel justo cuando la hoja desaparece en las llamas.
  // Total ≈ 16.8s — el reel se graba con esta misma duración porque sigue
  // la animación real del DOM frame a frame (ver GRABACIÓN DE VIDEO).
  burnStartRatio: 0.30,  // fracción del vuelo en la que prende el papel
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EMPTY_EMBERS = Object.freeze([]);

// Sacudida — oscila mientras "arranca" de la encuadernación
const RATTLE_KEYFRAMES = [
  { transform: "translate(0px, 0px) rotate(0deg)" },
  { transform: "translate(-5px, -3px) rotate(-1.8deg)",  offset: 0.18 },
  { transform: "translate(4px, -6px) rotate(2.2deg)",    offset: 0.35 },
  { transform: "translate(-7px, -9px) rotate(-2.8deg)",  offset: 0.52 },
  { transform: "translate(5px, -12px) rotate(1.8deg)",   offset: 0.68 },
  { transform: "translate(-4px, -14px) rotate(-2.2deg)", offset: 0.82 },
  { transform: "translate(2px, -15px) rotate(0.8deg)" },
];

// Representación numérica de RATTLE_KEYFRAMES para el sampler del reel
// (mismos valores que arriba, sin parsear strings en cada frame).
const RATTLE_POSES = [
  { offset: 0,    x: 0,  y: 0,   rotate: 0,    scale: 1, opacity: 1, brightness: 1 },
  { offset: 0.18, x: -5, y: -3,  rotate: -1.8, scale: 1, opacity: 1, brightness: 1 },
  { offset: 0.35, x: 4,  y: -6,  rotate: 2.2,  scale: 1, opacity: 1, brightness: 1 },
  { offset: 0.52, x: -7, y: -9,  rotate: -2.8, scale: 1, opacity: 1, brightness: 1 },
  { offset: 0.68, x: 5,  y: -12, rotate: 1.8,  scale: 1, opacity: 1, brightness: 1 },
  { offset: 0.82, x: -4, y: -14, rotate: -2.2, scale: 1, opacity: 1, brightness: 1 },
  { offset: 1,    x: 2,  y: -15, rotate: 0.8,  scale: 1, opacity: 1, brightness: 1 },
];

/**
 * Ajusta el tamaño del mensaje para que SIEMPRE quepa dentro de la hoja
 * (sin recortar palabras largas) y devuelve las proporciones usadas,
 * para que el sprite del video replique exactamente el mismo tamaño.
 */
function fitPageText(pageEl, contentEl, paragraphEl) {
  if (!pageEl || !contentEl || !paragraphEl) {
    return { fontRatio: 0.055, lineHeight: 1.5, widthRatio: 0.82 };
  }

  const maxW = contentEl.clientWidth;
  const maxH = contentEl.clientHeight;
  let size = Math.min(26, Math.max(11, pageEl.clientHeight * 0.065));
  paragraphEl.style.lineHeight = "1.5";
  paragraphEl.style.fontSize = `${size}px`;

  let guard = 0;
  while (
    guard++ < 20 && size > 10 &&
    (paragraphEl.scrollHeight > maxH || paragraphEl.scrollWidth > maxW)
  ) {
    size -= 1;
    paragraphEl.style.fontSize = `${size}px`;
  }

  return {
    fontRatio: pageEl.clientHeight ? size / pageEl.clientHeight : 0.055,
    lineHeight: 1.5,
    widthRatio: pageEl.clientWidth ? maxW / pageEl.clientWidth : 0.82,
  };
}

function initThrowAnimation() {
  const throwBtn     = document.getElementById("throwPageBtn");
  const flyingPage   = document.getElementById("flyingPage");
  const textArea     = document.getElementById("pageText");
  const pageContentEl = flyingPage?.querySelector(".page-content");
  const pageTextEl   = pageContentEl?.querySelector("p");
  const charEl       = flyingPage?.querySelector(".page-char");
  const spotlight    = document.getElementById("pageSpotlight");
  const emberLayer   = document.getElementById("emberLayer");
  const fireImpact   = document.getElementById("fireImpact");
  const bookWrapper  = document.querySelector(".book-wrapper");
  const fireplaceEl  = document.querySelector(".fireplace-container");
  const webglCanvas  = fireplaceEl?.querySelector("canvas.webgl");
  const bookImg      = bookWrapper?.querySelector(".book-cover img");
  if (!throwBtn || !flyingPage || !bookWrapper || !fireplaceEl) return;

  let isAnimating = false;

  // Geometría de la corrida actual (la usan también las chispas, que
  // necesitan saber dónde está el papel y dónde el fuego en cada frame).
  let pageCX = 0, pageCY = 0, pageW = 0, pageH = 0;
  let fireX = 0, fireY = 0, fireW = 0, fireH = 0;

  // ── Estado de la fase actual, leído por getPose() del reel ───────────────
  // Se actualiza al arrancar cada fase de la animación (rattle/showcase/
  // read/windup/throw). getPose() interpola matemáticamente entre estos
  // datos en vez de leer estilos del DOM, así el hilo principal no compite
  // consigo mismo entre WAAPI y la grabación.
  const anim = {
    phase: "hidden",    // hidden | static | rattle | showcase | read | windup | throw | gone
    phaseStart: 0,       // performance.now() al iniciar la fase
    phaseDuration: 0,
    holdPose: null,      // para "read": pose fija a sostener
    throwPoses: null,    // para "throw": lista de poses con offsets 0..1
    burnStart: 0,        // performance.now() en el que prende el papel
    burnDuration: 0,
    impactT0: 0,         // performance.now() del impacto en las llamas
    impactDuration: 1400,
  };

  /* ====================== CHISPAS / BRASAS 2D ======================
     Partículas DOM que salen del borde quemado del papel y, al final,
     del propio fuego. Se actualizan en un único rAF compartido y se
     consultan desde getPose() para que el video del reel las dibuje en
     la misma posición exacta que la pantalla.
     ================================================================= */
  const emberParticles = [];
  let emberActive = false;
  let emberLast = 0;
  let emberAccum = 0;
  let emberSpawn = false;
  let emberSpawnFrom = 0;
  let emberSpawnUntil = 0;

  function spawnParticle(x, y, opts = {}) {
    if (!emberLayer) return null;
    const el = document.createElement("span");
    el.className = "ember-particle";
    const size = opts.size ?? (3 + Math.random() * 6);
    el.style.width = el.style.height = `${size.toFixed(1)}px`;
    emberLayer.appendChild(el);

    const p = {
      el, x, y,
      vx: opts.vx ?? (Math.random() - 0.5) * 44,
      vy: opts.vy ?? -(26 + Math.random() * 58),
      gravity: 24 + Math.random() * 34, // frena la subida sin llegar a caer
      drift: 9 + Math.random() * 22,
      sway: 1.4 + Math.random() * 3,
      phase: Math.random() * Math.PI * 2,
      age: 0,
      life: opts.life ?? (0.65 + Math.random() * 1.05),
      size,
      alpha: 0,
    };
    emberParticles.push(p);
    if (!emberActive) startEmberLoop();
    return p;
  }

  function spawnBrushEmber() {
    const pose = getPose();
    if (!pose.visible || !(pose.opacity > 0.05)) return;
    // Frente de quemado: esquina inferior derecha de la hoja
    const cx = pageCX + pose.x;
    const cy = pageCY + pose.y;
    const w = pageW * pose.scale;
    const h = pageH * pose.scale;
    const fx = 0.10 + Math.random() * 0.42;
    const fy = 0.06 + Math.random() * 0.38;

    spawnParticle(cx + w * fx, cy + h * fy, {
      vx: (Math.random() - 0.35) * 34,
      vy: -(30 + Math.random() * 72),
      life: 0.6 + Math.random() * 0.95,
      size: 2.5 + Math.random() * 6,
    });
  }

  function updateEmberParticles(dt) {
    const now = performance.now();

    if (emberSpawn && now >= emberSpawnFrom && now < emberSpawnUntil) {
      emberAccum += dt;
      const interval = 0.036;
      while (emberAccum >= interval) {
        emberAccum -= interval;
        spawnBrushEmber();
      }
    }

    for (let i = emberParticles.length - 1; i >= 0; i--) {
      const p = emberParticles[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.el.remove();
        emberParticles.splice(i, 1);
        continue;
      }

      p.vy += p.gravity * dt;
      p.x += (p.vx + Math.sin(p.age * p.sway + p.phase) * p.drift) * dt;
      p.y += p.vy * dt;

      const t = p.age / p.life;
      const fadeIn = Math.min(1, t / 0.12);
      const fadeOut = Math.min(1, (1 - t) / 0.5);
      p.alpha = fadeIn * fadeOut;

      const grow = 0.55 + 0.55 * (1 - t);
      p.el.style.transform =
        `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) ` +
        `translate(-50%, -50%) scale(${grow.toFixed(3)})`;
      p.el.style.opacity = p.alpha.toFixed(3);
    }
  }

  function startEmberLoop() {
    if (emberActive) return;
    emberActive = true;
    emberLast = performance.now();

    const tick = (now) => {
      const dt = Math.min(0.05, (now - emberLast) / 1000);
      emberLast = now;
      updateEmberParticles(dt);
      if (emberParticles.length || emberSpawn) {
        requestAnimationFrame(tick);
      } else {
        emberActive = false;
      }
    };
    requestAnimationFrame(tick);
  }

  function clearParticles() {
    emberParticles.forEach((p) => p.el.remove());
    emberParticles.length = 0;
    emberSpawn = false;
    emberAccum = 0;
  }

  function snapshotEmbers() {
    if (!emberParticles.length) return EMPTY_EMBERS;
    return emberParticles.map((p) => ({
      x: p.x,
      y: p.y,
      size: p.size,
      alpha: p.alpha,
    }));
  }

  /* ====================== POSES / CRONÓMETRO ====================== */

  function getSpotlightValue(now) {
    switch (anim.phase) {
      case "showcase": {
        const p = anim.phaseDuration ? Math.min(1, (now - anim.phaseStart) / anim.phaseDuration) : 1;
        return EASE_SHOWCASE(p);
      }
      case "read":
      case "windup":
        return 1;
      case "throw": {
        const p = anim.phaseDuration ? Math.min(1, (now - anim.phaseStart) / anim.phaseDuration) : 1;
        return Math.max(0, 1 - p / 0.42);
      }
      default:
        return 0;
    }
  }

  function getBurnValue(now) {
    if (!anim.burnDuration) return 0;
    return Math.min(1, Math.max(0, (now - anim.burnStart) / anim.burnDuration));
  }

  function getImpactValue(now) {
    if (!anim.impactT0) return 0;
    const p = (now - anim.impactT0) / anim.impactDuration;
    if (p < 0 || p > 1) return 0;
    // subida casi instantánea + caída suave
    return p < 0.14 ? p / 0.14 : Math.pow(1 - (p - 0.14) / 0.86, 1.7);
  }

  function withExtras(pose, now) {
    return {
      ...pose,
      burn: getBurnValue(now),
      spotlight: getSpotlightValue(now),
      impact: getImpactValue(now),
      embers: snapshotEmbers(),
    };
  }

  function getPose() {
    const now = performance.now();
    switch (anim.phase) {
      case "static":
        return withExtras(
          { visible: true, x: 0, y: 0, rotate: 0, scale: 1, opacity: 1, brightness: 1 },
          now
        );
      case "rattle": {
        const p = anim.phaseDuration ? Math.min(1, (now - anim.phaseStart) / anim.phaseDuration) : 1;
        const eased = EASE_RATTLE(p);
        return withExtras(
          { visible: true, ...samplePoseList(RATTLE_POSES, eased) },
          now
        );
      }
      case "showcase": {
        const p = anim.phaseDuration ? Math.min(1, (now - anim.phaseStart) / anim.phaseDuration) : 1;
        const eased = EASE_SHOWCASE(p);
        const from = RATTLE_POSES[RATTLE_POSES.length - 1];
        const to = anim.holdPose;
        return withExtras({
          visible: true,
          x: lerp(from.x, to.x, eased),
          y: lerp(from.y, to.y, eased),
          rotate: lerp(from.rotate, to.rotate, eased),
          tiltX: 0,
          tiltY: 0,
          scale: lerp(from.scale, to.scale, eased),
          opacity: 1,
          brightness: 1,
        }, now);
      }
      case "read":
        return withExtras({ visible: true, ...anim.holdPose }, now);
      case "windup": {
        const p = anim.phaseDuration ? Math.min(1, (now - anim.phaseStart) / anim.phaseDuration) : 1;
        const eased = EASE_WINDUP(p);
        const from = anim.holdPose;
        const to = anim.windupPose;
        return withExtras({
          visible: true,
          x: lerp(from.x, to.x, eased),
          y: lerp(from.y, to.y, eased),
          rotate: lerp(from.rotate, to.rotate, eased),
          tiltX: 0,
          tiltY: lerp(0, to.tiltY || 0, eased),
          scale: lerp(from.scale, to.scale, eased),
          opacity: 1,
          brightness: 1,
        }, now);
      }
      case "throw": {
        const p = anim.phaseDuration ? Math.min(1, (now - anim.phaseStart) / anim.phaseDuration) : 1;
        const eased = EASE_THROW(p);
        return withExtras(
          { visible: true, ...samplePoseList(anim.throwPoses, eased) },
          now
        );
      }
      default:
        return withExtras({ visible: false }, now);
    }
  }

  function setPhase(phase, durationMs, extra) {
    anim.phase = phase;
    anim.phaseStart = performance.now();
    anim.phaseDuration = durationMs || 0;
    if (extra) Object.assign(anim, extra);
  }

  function resetPageVisuals() {
    [flyingPage, charEl, pageContentEl, pageTextEl, spotlight, fireImpact].forEach((el) => {
      if (el) el.getAnimations().forEach((a) => a.cancel());
    });
    if (charEl) {
      charEl.style.opacity = "0";
      charEl.style.transform = "scale(0)";
    }
    flyingPage.classList.remove("is-reading");
    flyingPage.style.boxShadow = "";
    if (spotlight) {
      spotlight.style.display = "none";
      spotlight.style.opacity = "0";
    }
  }

  async function playThrow() {
    // ── 0. Guardar texto en Supabase (fire & forget) ──────────────────
    const typed = textArea?.value?.trim() ?? '';
    if (typed) savePhrase(typed);
    if (pageTextEl) {
      pageTextEl.textContent = typed || 'Las palabras arden, pero el recuerdo permanece…';
    }

    resetPageVisuals();

    // ── 1. Localizar la página derecha del libro en pantalla ──────────
    const bookRect = bookWrapper.getBoundingClientRect();
    const fireRect = fireplaceEl.getBoundingClientRect();

    const pgLeft   = bookRect.left  + bookRect.width  * 0.50;
    const pgTop    = bookRect.top   + bookRect.height * 0.04;
    const pgWidth  = bookRect.width  * 0.46;
    const pgHeight = bookRect.height * 0.90;

    const startCX = pgLeft + pgWidth  / 2;
    const startCY = pgTop  + pgHeight / 2;
    const tgtX    = fireRect.left + fireRect.width  * 0.50;
    const tgtY    = fireRect.top  + fireRect.height * 0.62; // centro de llamas

    // Guardamos la geometría para las chispas (viven fuera de playThrow)
    pageCX = startCX;
    pageCY = startCY;
    pageW = pgWidth;
    pageH = pgHeight;
    fireX = tgtX;
    fireY = tgtY;
    fireW = fireRect.width;
    fireH = fireRect.height;

    // Escala y centro de la "exhibición" — se calculan en vivo para que el
    // mensaje sea legible sea cual sea el tamaño de pantalla.
    const showcaseScale = Math.min(
      1.5,
      (window.innerWidth  * 0.82) / pgWidth,
      (window.innerHeight * 0.62) / pgHeight
    );
    const showcaseTX = (window.innerWidth  / 2) - startCX;
    const showcaseTY = (window.innerHeight / 2) - startCY;
    const showcasePose = {
      x: showcaseTX, y: showcaseTY, rotate: 0, tiltX: 0, tiltY: 0,
      scale: showcaseScale, opacity: 1, brightness: 1,
    };

    // ── 2. Superponer la hoja exactamente sobre la página derecha ─────
    Object.assign(flyingPage.style, {
      position   : "fixed",
      left       : `${pgLeft}px`,
      top        : `${pgTop}px`,
      width      : `${pgWidth}px`,
      height     : `${pgHeight}px`,
      display    : "block",
      opacity    : "1",
      transform  : "none",
      willChange : "transform, opacity, filter",
      zIndex     : "10000",
    });

    // El texto se ajusta ANTES de arrancar la grabación: el sprite del
    // video usa las mismas proporciones (ver fitPageText).
    const textMetrics = fitPageText(flyingPage, pageContentEl, pageTextEl);

    // Velo cálido alrededor de la hoja mientras se lee, centrado en el
    // lugar donde termina la exhibición (el centro de la pantalla).
    if (spotlight) {
      Object.assign(spotlight.style, {
        display: "block",
        opacity: "0",
        width: `${Math.max(pgWidth * showcaseScale * 2.9, 300)}px`,
        height: `${Math.max(pgHeight * showcaseScale * 2.15, 320)}px`,
      });
    }

    isAnimating = true;
    setPhase("static");

    // ── 2b. Arrancar la grabación del reel (si el navegador la soporta) ──
    // Bajamos la calidad del renderer de Three.js mientras se graba: es
    // el ajuste más simple que libera margen de GPU/CPU justo cuando dos
    // rAF (el del fuego y el de la grabación) corren en paralelo.
    fireplaceApp?.setLowQuality(true);

    const reel = startReelRecording({
      webglCanvas,
      bookImg,
      baseBox: { left: pgLeft, top: pgTop, width: pgWidth, height: pgHeight },
      text: pageTextEl?.textContent || "",
      textMetrics,
      fireTarget: { x: tgtX, y: tgtY },
      fireBox: { width: fireRect.width, height: fireRect.height },
      getPose,
    });

    // ── 2c. Reposo — la hoja escrita queda quieta sobre el libro unos
    //    segundos antes de arrancarse, para que se alcance a leer lo
    //    escrito (y quede capturado en el video) antes del tirón.
    if (pageTextEl) {
      pageTextEl.animate(
        [
          { opacity: 0, transform: "scale(0.985)" },
          { opacity: 1, transform: "scale(1)" },
        ],
        { duration: 1100, easing: "ease-out", fill: "forwards" }
      );
    }
    await sleep(THROW_TIMING.introMs);

    // ── 3. Fase de tirón ────────────────────────────────────────────────
    setPhase("rattle", THROW_TIMING.rattleMs);
    await flyingPage.animate(RATTLE_KEYFRAMES, {
      duration: THROW_TIMING.rattleMs,
      easing  : "cubic-bezier(0.36, 0.07, 0.19, 0.97)",
      fill    : "forwards",
    }).finished;

    // ── 4. Fase de "lectura" — centrar y ampliar la hoja ───────────────
    // Sombra fija, NO animada — evita un repaint por frame.
    flyingPage.style.boxShadow =
      "0 30px 70px rgba(0,0,0,0.9), 0 0 46px rgba(255,150,60,0.26)";

    setPhase("showcase", THROW_TIMING.showMs, { holdPose: showcasePose });
    if (spotlight) {
      spotlight.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        {
          duration: THROW_TIMING.showMs,
          easing  : "cubic-bezier(0.34, 1.56, 0.64, 1)",
          fill    : "forwards",
        }
      );
    }
    await flyingPage.animate(
      [
        { transform: "translate(2px, -15px) rotate(0.8deg)", filter: "brightness(1)" },
        poseToKeyframe({ ...showcasePose, offset: 1 }),
      ],
      {
        duration: THROW_TIMING.showMs,
        easing  : "cubic-bezier(0.34, 1.56, 0.64, 1)",
        fill    : "forwards",
      }
    ).finished;

    // Respiración sutil del mensaje durante la lectura
    flyingPage.classList.add("is-reading");
    setPhase("read", THROW_TIMING.readMs, { holdPose: showcasePose });
    await sleep(THROW_TIMING.readMs);

    // ── 5. Impulso (anticipación) ─────────────────────────────────────
    // Un pequeño retroceso antes de lanzar hace que el gesto se sienta
    // intencionado: el papel "toma aire" y luego sale disparado.
    const windupPose = {
      x: showcaseTX + 10,
      y: showcaseTY - 26,
      rotate: -6,
      tiltX: 0,
      tiltY: 4,
      scale: showcaseScale * 0.96,
      opacity: 1,
      brightness: 1,
    };
    const windupEasing = "cubic-bezier(0.4, 0, 0.55, 1)";

    flyingPage.classList.remove("is-reading");
    setPhase("windup", THROW_TIMING.windupMs, { windupPose });
    await flyingPage.animate(
      [
        poseToKeyframe({ ...showcasePose, offset: 0 }),
        poseToKeyframe({ ...windupPose, offset: 1 }),
      ],
      {
        duration: THROW_TIMING.windupMs,
        easing  : windupEasing,
        fill    : "forwards",
      }
    ).finished;

    // ── 6. Trayectoria dinámica hacia el fuego ──────────────────────────
    // El destino se calcula desde el centro ORIGINAL de la página (el
    // libro), y se usa SIEMPRE ese mismo espacio para interpolar desde la
    // pose de exhibición. corregir aquí el viejo desfase que duplicaba la
    // traslación del showcase (se notaba sobre todo en landscape).
    const dx = tgtX - startCX;
    const dy = tgtY - startCY;
    const bow = -Math.max(pgWidth * 0.5, Math.abs(dx) * 0.22);

    const track = (t) => ({
      x: lerp(showcaseTX, dx, t),
      y: lerp(showcaseTY, dy, t),
    });
    const poseAt = (offset, t, bowAmt, rotate, tiltX, tiltY, scale, opacity, brightness, sepia, blur) => {
      const pos = track(t);
      return {
        offset,
        x: pos.x + bowAmt,
        y: pos.y,
        rotate, tiltX, tiltY, scale, opacity, brightness, sepia, blur,
      };
    };

    const throwPosesForAnim = [
      { offset: 0, x: windupPose.x, y: windupPose.y, rotate: windupPose.rotate, tiltX: 0, tiltY: 4, scale: windupPose.scale, opacity: 1, brightness: 1, sepia: 0, blur: 0 },
      poseAt(0.13, 0.13, bow * 0.35, 26,  -16, -18, showcaseScale * 0.93, 1,    1.05, 0,    0),
      poseAt(0.34, 0.34, bow * 0.90, 92,  -20, -38, showcaseScale * 0.76, 1,    1.15, 0.08, 0),
      poseAt(0.55, 0.55, bow * 0.80, 150,  24, -40, showcaseScale * 0.58, 1,    1.35, 0.20, 0),
      poseAt(0.74, 0.74, bow * 0.42, 205,  44, -30, 0.40,                 1,    1.80, 0.32, 0),
      poseAt(0.87, 0.87, bow * 0.15, 240,  52, -20, 0.28,                 0.94, 2.40, 0.45, 0),
      poseAt(0.95, 0.95, 0,          262,  58, -12, 0.19,                 0.72, 3.60, 0.55, 0.5),
      { offset: 1, x: dx, y: dy, rotate: 274, tiltX: 62, tiltY: -8, scale: 0.09, opacity: 0, brightness: 6, sepia: 0.6, blur: 2 },
    ];

    // El fuego empieza a crecer mientras la hoja se acerca (luego el
    // impacto remata el efecto con un golpe mucho más fuerte).
    fireplaceApp?.growFire(THROW_TIMING.throwMs * 1.15, 0.5);

    // El quemado arranca al 30% del vuelo y termina justo al llegar.
    const burnDelay = THROW_TIMING.throwMs * THROW_TIMING.burnStartRatio;
    const burnDur = THROW_TIMING.throwMs - burnDelay;
    anim.burnStart = performance.now() + burnDelay;
    anim.burnDuration = burnDur;

    if (charEl) {
      charEl.animate(
        [
          { transform: "scale(0.04) rotate(-4deg)", opacity: 0.85 },
          { transform: "scale(0.50) rotate(4deg) scaleX(0.92)", opacity: 1, offset: 0.4 },
          { transform: "scale(1.06) rotate(-3deg) scaleY(0.94)", opacity: 1, offset: 0.72 },
          { transform: "scale(1.62) rotate(3deg)", opacity: 1 },
        ],
        {
          duration: burnDur,
          delay: burnDelay,
          easing: "linear",
          fill: "forwards",
        }
      );
    }

    // El texto se consume antes que el papel: primero se oscurece y
    // desaparece bajo la ceniza.
    if (pageTextEl) {
      pageTextEl.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        {
          duration: burnDur * 0.68,
          delay: burnDelay + burnDur * 0.2,
          easing: "ease-in",
          fill: "forwards",
        }
      );
    }

    // El resplandor de lectura se apaga al iniciar el vuelo
    if (spotlight) {
      spotlight.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        {
          duration: THROW_TIMING.throwMs * 0.45,
          easing  : "ease-out",
          fill    : "forwards",
        }
      );
    }

    emberSpawn = true;
    emberSpawnFrom = anim.burnStart;
    emberSpawnUntil = performance.now() + THROW_TIMING.throwMs;
    emberAccum = 0;
    startEmberLoop();

    setPhase("throw", THROW_TIMING.throwMs, { throwPoses: throwPosesForAnim });

    await flyingPage.animate(throwPosesForAnim.map(poseToKeyframe), {
      duration: THROW_TIMING.throwMs,
      easing  : "cubic-bezier(0.33, 0, 0.45, 1)",
      fill    : "forwards",
    }).finished;

    emberSpawn = false;

    // ── 7. Impacto — la hoja entra en las llamas ───────────────────────
    setPhase("gone");
    triggerImpact();

    await sleep(THROW_TIMING.impactTailMs);

    // ── 8. Limpieza ──────────────────────────────────────────────────────
    if (reel) {
      const blob = await reel.stop();
      if (blob) offerReelDownload(blob, reel.mimeType);
    }
    fireplaceApp?.setLowQuality(false);

    resetPageVisuals();
    flyingPage.removeAttribute("style");
    flyingPage.style.display = "none";
    if (pageTextEl) {
      pageTextEl.style.fontSize = "";
      pageTextEl.style.lineHeight = "";
    }
    isAnimating = false;
    setPhase("hidden");
    anim.burnStart = 0;
    anim.burnDuration = 0;
    anim.impactT0 = 0;
    clearParticles();

    if (textArea) textArea.value = '';
    if (pageTextEl) pageTextEl.textContent = 'Las palabras arden, pero el recuerdo permanece…';
    _cacheTs = 0; // invalidar caché — la próxima rotación trae la frase recién guardada
  }

  function triggerImpact() {
    emberSpawn = false;
    anim.impactT0 = performance.now();
    anim.impactDuration = 1500;

    // Flash cálido sobre la boca del fuego
    if (fireImpact) {
      fireImpact.getAnimations().forEach((a) => a.cancel());
      fireImpact.animate(
        [
          { opacity: 0, transform: "scale(0.72)" },
          { opacity: 0.95, transform: "scale(1)", offset: 0.16 },
          { opacity: 0.42, transform: "scale(1.12)", offset: 0.46 },
          { opacity: 0, transform: "scale(1.32)" },
        ],
        { duration: 1100, easing: "cubic-bezier(0.2, 0.7, 0.35, 1)" }
      );
    }

    // El fuego arde con fuerza y la cámara tiembla un instante
    fireplaceApp?.burst();
    boostFireAudio(1600, 0.28);

    // Brasas que brotan del fuego al recibir el papel
    const count = 26;
    for (let i = 0; i < count; i++) {
      spawnParticle(
        fireX + (Math.random() - 0.5) * fireW * 0.20,
        fireY + (Math.random() - 0.5) * fireH * 0.10,
        {
          vx: (Math.random() - 0.5) * 95,
          vy: -(60 + Math.random() * 155),
          life: 0.9 + Math.random() * 1.4,
          size: 3 + Math.random() * 8,
        }
      );
    }
  }

  throwBtn.addEventListener("click", () => {
    if (isAnimating) return;
    playThrow();
  });
}

// Ejecutar cuando el DOM esté listo
window.addEventListener("load", () => {
  updateDynamicPhrase();
  setInterval(updateDynamicPhrase, 7000);
  initThrowAnimation();
  initFireSound();
});
