/**
 * scene.js — 三渲二风格「舞池」场景:舞台、灯光、粒子、相机与渲染器。
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b18);
  scene.fog = new THREE.FogExp2(0x070b18, 0.028);

  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 100
  );
  camera.position.set(0, 1.55, 3.6);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.92, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.4;
  controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI * 0.62;
  controls.update();

  // ---- 灯光 ----
  scene.add(new THREE.HemisphereLight(0x9db8ff, 0x14122a, 0.85));

  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 20;
  key.shadow.bias = -0.0004;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xff5fa2, 1.6);
  rim.position.set(-3, 2, -4);
  scene.add(rim);

  const rim2 = new THREE.DirectionalLight(0x39ffcf, 1.0);
  rim2.position.set(3, 1, -3);
  scene.add(rim2);

  // ---- 舞池 ----
  scene.add(buildFloor());

  // ---- 粒子 ----
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
    // 每帧更新(粒子旋转 + 阻尼)
    update(dt) {
      particles.rotation.y += dt * 0.05;
      controls.update();
    },
    resetCamera() {
      camera.position.set(0, 1.55, 3.6);
      controls.target.set(0, 0.92, 0);
      controls.update();
    },
  };
}

function buildFloor() {
  const g = new THREE.Group();

  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(6, 72),
    new THREE.MeshStandardMaterial({ color: 0x0b1220, roughness: 0.35, metalness: 0.55 })
  );
  disk.rotation.x = -Math.PI / 2;
  disk.receiveShadow = true;
  g.add(disk);

  const grid = new THREE.GridHelper(12, 24, 0x2b3a67, 0x141d38);
  grid.position.y = 0.004;
  g.add(grid);

  // 内圈霓虹环
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.9, 0.028, 16, 128),
    new THREE.MeshBasicMaterial({ color: 0xff3d81 })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  g.add(ring);

  const ring2 = new THREE.Mesh(
    new THREE.TorusGeometry(2.4, 0.014, 16, 128),
    new THREE.MeshBasicMaterial({ color: 0x4d7cff })
  );
  ring2.rotation.x = -Math.PI / 2;
  ring2.position.y = 0.018;
  g.add(ring2);

  return g;
}

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
    pos[i * 3] = (Math.random() - 0.5) * 7;
    pos[i * 3 + 1] = Math.random() * 4.2;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 7;
    const c = palette[i % 3];
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.03,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}
