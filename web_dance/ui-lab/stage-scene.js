/**
 * stage-scene.js — 舞台实验(Dance Evolution / Just Dance / Dance Spotlight 风格)。
 *
 * 核心:舞者是主角,舞台是"暗场 + 光"。
 * 关键修法(上一版的两个问题):
 *   1) 反射"白膜" ← RoomEnvironment 是白色房间,给暗场抬了一层白光。
 *      改为「自建暗色 + 彩色发光板」的环境图:反射是"暗底 + 彩色光条",不是白膜。
 *   2) bloom"白炽" ← 阈值 0.85 太高,只有白/近白像素会 bloom,饱和色够不到。
 *      改为低阈值(0.22)+ 场景压黑 + 发光源保持饱和色 → bloom 出彩色光晕。
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// bloom:低阈值让饱和色也能 bloom,场景压黑避免误发光
const BLOOM = { strength: 0.6, radius: 0.45, threshold: 0.22 };

// 光束:右圆锥(顶点=光源,半张角 HALF_ANGLE);锥身超出地板,由深度裁剪出「锥∩平面」的椭圆
const HALF_ANGLE = 8 * Math.PI / 180;
const BEAM_HEIGHT = 14.0;

export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070f);
  scene.fog = new THREE.FogExp2(0x05070f, 0.03);

  // 环境反射:自建「暗室 + 彩色发光板」,反射是暗底上的彩色光条
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envMap = pmrem.fromScene(buildEnvScene(), 0.04).texture;
  // 反射默认关闭(暗场更干净),用「反射」开关按需打开
  // scene.environment = envMap;

  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 120
  );
  camera.position.set(0, 2.0, 6.2);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 2.0;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.update();

  // ---- 灯光 ----
  scene.add(new THREE.HemisphereLight(0x9db8ff, 0x14122a, 0.5));

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(2, 5, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 20;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const rimPink = new THREE.DirectionalLight(0xff5fa2, 2.2);
  rimPink.position.set(-3.5, 2.2, -4);
  scene.add(rimPink);

  const rimCyan = new THREE.DirectionalLight(0x39ffcf, 1.7);
  rimCyan.position.set(3.5, 2.0, -3.5);
  scene.add(rimCyan);

  const rimViolet = new THREE.DirectionalLight(0x8b5cff, 1.5);
  rimViolet.position.set(0, 3.2, -4.5);
  scene.add(rimViolet);

  // ---- 舞台 ----
  scene.add(buildFloor());
  const movingLights = buildMovingLights();
  scene.add(movingLights);

  const mannequin = buildMannequin();
  scene.add(mannequin);

  const particles = buildParticles();
  scene.add(particles);

  // ---- 后处理 ----
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    BLOOM.strength, BLOOM.radius, BLOOM.threshold
  );
  composer.addPass(bloom);
  bloom.enabled = false; // bloom 默认关闭,「Bloom」开关按需打开
  composer.addPass(new OutputPass());

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", resize);

  return {
    renderer,
    scene,
    camera,
    controls,
    composer,
    bloom,
    particles,
    setBloom(on) { bloom.enabled = on; },
    setEnv(on) { scene.environment = on ? envMap : null; },
    setMannequin(on) { mannequin.visible = on; },
    update(dt) {
      particles.rotation.y += dt * 0.04;
      updateMovingLights(movingLights, dt);
      controls.update();
    },
    render() {
      composer.render();
    },
  };
}

// ---------------------------------------------------------------------------
// 环境图:暗室 + 几块 HDR 彩色发光板(反射来源),不是白房间
// ---------------------------------------------------------------------------
function buildEnvScene() {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x010208);
  const defs = [
    { color: 0x39ffcf, pos: [-4, 3.5, -2], size: [5, 2.5], mult: 2.5 },
    { color: 0xff3d81, pos: [4, 3.5, -2], size: [5, 2.5], mult: 2.5 },
    { color: 0x8b5cff, pos: [0, 4.5, -4], size: [6, 2.5], mult: 2.5 },
    { color: 0x2a4a7a, pos: [0, 3, 5], size: [6, 3], mult: 1.2 },
  ];
  defs.forEach(({ color, pos, size, mult }) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size[0], size[1]),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(mult) })
    );
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    s.add(m);
  });
  return s;
}

// ---------------------------------------------------------------------------
// 地板 + 边缘灯带 + 脚下光池
// ---------------------------------------------------------------------------
function buildFloor() {
  const g = new THREE.Group();

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(6.5, 72),
    new THREE.MeshStandardMaterial({ color: 0x0a0d16, roughness: 0.38, metalness: 0.6 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);

  const edge = new THREE.Mesh(
    new THREE.TorusGeometry(5.7, 0.02, 16, 128),
    new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0x39ffcf, emissiveIntensity: 1.6, roughness: 0.5, metalness: 0,
    })
  );
  edge.rotation.x = -Math.PI / 2;
  edge.position.y = 0.012;
  g.add(edge);

  // 脚下光池:饱和青色(不再近白),低透明度
  const pool = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 4.6),
    new THREE.MeshBasicMaterial({
      map: makeGlowTexture("rgba(70,240,255,0.85)", "rgba(70,240,255,0)"),
      transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.02;
  g.add(pool);

  return g;
}

// ---------------------------------------------------------------------------
// 会动的舞台灯:光束扫动 + 地面光斑跟随 + 颜色循环
// ---------------------------------------------------------------------------
function buildMovingLights() {
  const g = new THREE.Group();
  const defs = [
    { sx: 0,    sy: 4.2, sz: -4.5, ca: 0x39ffcf, cb: 0x4d7cff, range: 3.0, zBase: -1.5, phase: 0.0 },
    { sx: -3.5, sy: 4.0, sz: -4.0, ca: 0x8b5cff, cb: 0xff3d81, range: 2.4, zBase: -1.0, phase: 2.09 },
    { sx: 3.5,  sy: 4.0, sz: -4.0, ca: 0xff3d81, cb: 0x39ffcf, range: 2.4, zBase: -1.0, phase: 4.19 },
  ];
  const lights = defs.map((d) => {
    const beam = buildBeam();
    // 光斑:组(朝向) + 椭圆盘(每帧按精确椭圆参数缩放)
    const poolGroup = new THREE.Group();
    const poolMesh = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({
        map: makeGlowTexture("rgba(255,255,255,0.85)", "rgba(255,255,255,0)"),
        color: 0xffffff,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    poolMesh.rotation.x = -Math.PI / 2;
    poolGroup.add(poolMesh);
    g.add(beam);
    g.add(poolGroup);
    return { ...d, beam, poolGroup, poolMesh, colorA: new THREE.Color(d.ca), colorB: new THREE.Color(d.cb), t: d.phase };
  });
  g.userData.lights = lights;
  return g;
}

const SWEEP_SPEED = 0.7; // 三盏灯同速,相位均分 → 协调的左右横扫

function updateMovingLights(g, dt) {
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const tmp = new THREE.Color();
  const S = new THREE.Vector3();
  const T = new THREE.Vector3();
  const sinθ = Math.sin(HALF_ANGLE), cosθ = Math.cos(HALF_ANGLE), tanθ = Math.tan(HALF_ANGLE);
  for (const l of g.userData.lights) {
    l.t += dt;
    // 简单水平横扫(固定深度),三盏灯同步
    const a = l.t * SWEEP_SPEED + l.phase;
    const tx = Math.sin(a) * l.range;
    const tz = l.zBase;

    S.set(l.sx, l.sy, l.sz);
    T.set(tx, 0, tz);
    dir.subVectors(T, S);
    const h = dir.length();
    dir.normalize();

    // 光束:锥顶点在光源,指向地板;锥身超出地板,由深度裁剪出「锥∩平面」的椭圆
    l.beam.position.copy(S);
    l.beam.quaternion.setFromUnitVectors(up, dir);

    // ---- 圆锥 ∩ 地面(y=0) = 椭圆(精确解) ----
    const cosγ = l.sy / h;                  // 轴与竖直方向的夹角余弦
    const sinγ = Math.hypot(dir.x, dir.z);  // 轴的水平分量
    const denom = cosγ * cosγ - sinθ * sinθ;
    const b = h * tanθ;                               // 半短轴
    const aEllipse = h * sinθ * cosθ * cosγ / denom;  // 半长轴(沿倾斜方向)
    const offset = h * sinθ * sinθ * sinγ / denom;    // 中心沿倾斜方向的偏移

    let ux = 0, uz = 0, angle = 0;
    if (sinγ > 1e-3) {
      ux = dir.x / sinγ;
      uz = dir.z / sinγ;
      angle = Math.atan2(-uz, ux); // 长轴对准轴的水平投影方向
    }

    // 光斑:椭圆(中心偏移 T,长轴对准倾斜方向)
    l.poolGroup.position.set(tx + offset * ux, 0.02, tz + offset * uz);
    l.poolGroup.rotation.y = angle;
    l.poolMesh.scale.set(aEllipse, b, 1);

    // 颜色:慢速、相位错开的循环,可预测
    const k = (Math.sin(l.t * 0.5 + l.phase) + 1) / 2;
    tmp.copy(l.colorA).lerp(l.colorB, k);
    l.beam.userData.mat.uniforms.uColor.value.copy(tmp);
    l.poolMesh.material.color.copy(tmp);
  }
}

// 光束:右圆锥(顶点在光源处),超出地板由深度裁剪出椭圆投影
function buildBeam() {
  const baseRadius = Math.tan(HALF_ANGLE) * BEAM_HEIGHT;
  const mat = makeBeamMaterial(0.7); // 主光束(彩色)

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(baseRadius, 0.02, BEAM_HEIGHT, 32, 1, true),
    mat
  );
  mesh.position.y = BEAM_HEIGHT / 2;

  const g = new THREE.Group();
  g.add(mesh);
  g.userData.mat = mat; // 主光束材质(每帧 tint)
  return g;
}

// 光束 shader:中心亮/边缘淡 + 越远越淡 + 地板裁剪
function makeBeamMaterial(intensity) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(0xffffff) },
      uIntensity: { value: intensity },
    },
    vertexShader: `
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      void main() {
        vViewNormal = normalize(normalMatrix * normal);
        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        vViewPos = viewPos.xyz;
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewPos;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec3 vViewNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec2 vUv;
      void main() {
        // 裁剪到地板平面:锥身再长也不会穿出地面
        if (vWorldPos.y < 0.0) discard;
        // 视线方向(相机在视图空间原点)
        vec3 viewDir = normalize(-vViewPos);
        // 中心亮、边缘淡:正对相机处最亮,轮廓处→0
        float center = pow(abs(dot(normalize(vViewNormal), viewDir)), 1.3);
        // 越远越淡(平方反比近似):近源很亮,远端快速变暗
        float falloff = 1.0 / (1.0 + 12.0 * vUv.y * vUv.y);
        float a = uIntensity * center * falloff;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// 占位人偶
// ---------------------------------------------------------------------------
function buildMannequin() {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x0b0e18, roughness: 0.45, metalness: 0.35 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.7, 8, 16), mat);
  torso.position.y = 1.05;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 16), mat);
  head.position.y = 1.72;
  g.add(head);

  const armGeo = new THREE.CapsuleGeometry(0.07, 0.55, 4, 12);
  const lArm = new THREE.Mesh(armGeo, mat);
  lArm.position.set(-0.32, 1.1, 0);
  lArm.rotation.z = 0.25;
  g.add(lArm);
  const rArm = new THREE.Mesh(armGeo, mat);
  rArm.position.set(0.32, 1.1, 0);
  rArm.rotation.z = -0.25;
  g.add(rArm);

  const legGeo = new THREE.CapsuleGeometry(0.09, 0.75, 4, 12);
  const lLeg = new THREE.Mesh(legGeo, mat);
  lLeg.position.set(-0.13, 0.38, 0);
  g.add(lLeg);
  const rLeg = new THREE.Mesh(legGeo, mat);
  rLeg.position.set(0.13, 0.38, 0);
  g.add(rLeg);

  return g;
}

// ---------------------------------------------------------------------------
// 粒子
// ---------------------------------------------------------------------------
function buildParticles() {
  const n = 420;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const palette = [
    new THREE.Color(0xff3d81),
    new THREE.Color(0x4d7cff),
    new THREE.Color(0x39ffcf),
  ];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 8;
    pos[i * 3 + 1] = Math.random() * 4.2;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 8;
    const c = palette[i % 3];
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.026,
    vertexColors: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}

// ---------------------------------------------------------------------------
// 贴图生成
// ---------------------------------------------------------------------------
function makeGlowTexture(inner = "rgba(255,255,255,1)", outer = "rgba(255,255,255,0)") {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const ctx = c.getContext("2d");
  const grad = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, outer);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

