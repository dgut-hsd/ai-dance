/**
 * scene.js — 舞台(Dance Evolution / Just Dance / Dance Spotlight 风格)。
 *
 * 暗场 + 光:三盏会动的锥形聚光灯(扫动 + 变色 + 精确椭圆投影)、
 * 逆光勾边、脚下光池、台口灯带、雾、粒子。
 * 无后处理 bloom / 无环境反射(按实验台验收结果,直接 renderer.render)。
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// 光束:右圆锥(顶点=光源,半张角 HALF_ANGLE);锥身超出地板,由 shader 裁剪出「锥∩平面」的椭圆
const HALF_ANGLE = 8 * Math.PI / 180;
const BEAM_HEIGHT = 14.0;

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1020);
  scene.fog = new THREE.FogExp2(0x0a1020, 0.02);

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

  // 正面补光(暖白、不投影):让舞者正面/脸看得清,与背后彩色轮廓光区分
  const frontFill = new THREE.DirectionalLight(0xfff3e6, 4.0);
  frontFill.position.set(0, 1.7, 4.5);
  scene.add(frontFill);

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

  const particles = buildParticles();
  scene.add(particles);

  function resize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", resize);

  return {
    renderer,
    scene,
    camera,
    controls,
    particles,
    update(dt) {
      particles.rotation.y += dt * 0.04;
      updateMovingLights(movingLights, dt);
      controls.update();
    },
    render() {
      renderer.render(scene, camera);
    },
    resetCamera() {
      camera.position.set(0, 2.0, 6.2);
      controls.target.set(0, 1.0, 0);
      controls.update();
    },
  };
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

  // 脚下光池:饱和青色,additive
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

    // 光束:锥顶点在光源,指向地板;锥身超出地板,由 shader 裁剪出「锥∩平面」的椭圆
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

// 光束:右圆锥(顶点在光源处),超出地板由 shader 裁剪出椭圆投影
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
