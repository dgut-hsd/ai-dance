/**
 * silhouette.js — 3D 舞者「白影剪影」渲染核心。
 *
 * 由 tools/gen-silhouettes.mjs 的核心逻辑提取而来,去掉 Node/Playwright 依赖,
 * 变成页面内可以直接 import 调用的模块:离屏渲染 → 纯白材质 → 透明背景 → 按 alpha 裁剪。
 *
 * 页面里最简用法(把某一帧的舞者画成剪影):
 *   import { createSilhouetteRenderer, renderSilhouetteFrame } from "./silhouette.js";
 *   const sil = createSilhouetteRenderer({ size: 512 });
 *   scene.add(sil.root);                       // 离屏场景,可一直挂着
 *   const canvas = renderSilhouetteFrame({
 *     sil, object3D: avatar.object, skeletons: avatar.skeletons,
 *     retargeter: avatar.retargeter, seq, boneDefs, t,
 *   });
 *   ctx.drawImage(canvas, x, y);
 *   // 用尽后 sil.dispose();
 *
 * 批量离线生成(命令行)走同一份核心,见 tools/silhouette-core.mjs。
 */
import * as THREE from "three";

export const DEFAULT_SILHOUETTE_OPTIONS = {
  size: 512,          // 离屏画布边长(像素)
  color: 0xffffff,    // 剪影颜色(纯色材质)
  half: 1.7,          // 正交相机半宽/半高(米):越大拍得越远
  centerY: 0.9,       // 取景中心高度(米):大致是人的胸口
  distance: 12,       // 相机距离
  padFrac: 0.06,      // 按 alpha 裁剪后留的边距(相对内容尺寸)
  alphaThreshold: 8,  // alpha 低于此值视为透明
};

/**
 * 造一个离屏剪影渲染器(自带 renderer / scene / orthographic camera)。
 * 注意:一个页面别造太多(每个都会占一个 WebGL 上下文),用完 dispose()。
 */
export function createSilhouetteRenderer(opts = {}) {
  const o = { ...DEFAULT_SILHOUETTE_OPTIONS, ...opts };
  const canvas = document.createElement("canvas");
  canvas.width = o.size;
  canvas.height = o.size;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // 要读像素/toDataURL,必须开
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(o.size, o.size);
  renderer.setPixelRatio(1);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-o.half, o.half, o.half, -o.half, 0.1, o.distance * 3);
  camera.position.set(0, o.centerY, o.distance);
  camera.lookAt(0, o.centerY, 0);
  camera.updateProjectionMatrix();

  const material = new THREE.MeshBasicMaterial({ color: o.color });
  const whitened = [];   // 记录被换掉的原始材质,便于还原
  const owned = [];      // 本渲染器自己造的 Object3D(移除时一并清)

  return {
    opts: o,
    canvas,
    renderer,
    scene,
    camera,
    material,

    /** 把模型挂进离屏场景(不改动原模型的父节点之外的东西) */
    attach(object3D) {
      scene.add(object3D);
      owned.push(object3D);
      return object3D;
    },

    /**
     * 换成纯白材质(剪影的关键):只记录原材质,不 dispose——原材质可能正被主场景用着。
     * restoreMaterials() 可还原。
     */
    whiten(object3D) {
      object3D.traverse((obj) => {
        if (!obj.isMesh) return;
        whitened.push({ obj, prev: obj.material });
        obj.material = material;
      });
      return whitened.length;
    },

    restoreMaterials() {
      for (const { obj, prev } of whitened) obj.material = prev;
      whitened.length = 0;
    },

    /** 取景:改半宽/中心高度后要重算投影矩阵 */
    setFraming({ half, centerY, distance } = {}) {
      if (half != null) { camera.left = -half; camera.right = half; camera.top = half; camera.bottom = -half; }
      if (centerY != null) { camera.position.y = centerY; }
      if (distance != null) { camera.position.z = distance; }
      camera.lookAt(0, camera.position.y, 0);
      camera.updateProjectionMatrix();
    },

    /** 渲染一帧,返回原始(未裁剪)canvas */
    renderRaw() {
      renderer.render(scene, camera);
      return canvas;
    },

    dispose() {
      this.restoreMaterials();
      for (const obj of owned) scene.remove(obj);
      material.dispose();
      renderer.dispose();
    },
  };
}

/** 按 alpha 扫出内容包围盒(未加边距);全透明返回 null */
export function alphaCropBox(source, { alphaThreshold = 8 } = {}) {
  const w = source.width;
  const h = source.height;
  const probe = document.createElement("canvas");
  probe.width = w;
  probe.height = h;
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  pctx.drawImage(source, 0, 0);
  const data = pctx.getImageData(0, 0, w, h).data;

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 把 source 的某个矩形拷到新 canvas(box 为空则原尺寸拷贝) */export function cropCanvas(source, box) {
  const x = box ? Math.max(0, Math.round(box.x)) : 0;
  const y = box ? Math.max(0, Math.round(box.y)) : 0;
  const w = box ? Math.round(box.w) : source.width;
  const h = box ? Math.round(box.h) : source.height;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").drawImage(source, x, y, w, h, 0, 0, w, h);
  return out;
}

/**
 * 一组画面共用的裁剪框(逐判定点出图用):取所有 alpha 包围盒的并集 + 边距。
 * 为什么不用"每张各自裁剪":那样每帧取景都不同,剪影大小会忽大忽小、关节像素也没法统一;
 * 共用裁剪框既能填满画面,又保证同一支舞里所有动作的比例一致。
 */
export function unionCropBox(boxes, { size, padFrac = 0.06 } = {}) {
  const valid = (boxes ?? []).filter(Boolean);
  if (!valid.length || !(size > 0)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of valid) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w - 1);
    maxY = Math.max(maxY, b.y + b.h - 1);
  }
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * padFrac);
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  return {
    x,
    y,
    w: Math.min(size, maxX + pad + 1) - x,
    h: Math.min(size, maxY + pad + 1) - y,
  };
}

/** 按 alpha 把画面裁剪到实际内容(带边距),让剪影尽量填满画布 */
export function cropToAlpha(source, { padFrac = 0.06, alphaThreshold = 8 } = {}) {
  const box = alphaCropBox(source, { alphaThreshold });
  if (!box) {
    const out = document.createElement("canvas");
    out.width = source.width;
    out.height = source.height;
    out.getContext("2d").drawImage(source, 0, 0);
    return out;
  }
  const pad = Math.round(Math.max(box.w, box.h) * padFrac);
  return cropCanvas(source, {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    w: Math.min(source.width, box.w + pad * 2),
    h: Math.min(source.height, box.h + pad * 2),
  });
}

/**
 * 正交相机下的「世界坐标 → 原始画布像素」。
 * 与 createSilhouetteRenderer 的取景完全对应:相机在 (0, centerY, distance) 看向 (0, centerY, 0),
 * up = +y、无 roll,正交半宽/半高都是 half(米)。
 * 用它把模型骨骼的世界坐标换算成图片里的像素 —— 车道箭头要贴到"正在动的那个关节"上,
 * alpha 裁剪会让每张图取景不同,靠包围盒猜是猜不准的,所以生成器直接把这组像素写进 manifest。
 */
export function projectOrthoJoint(point, { size, half = 1.7, centerY = 0.9 } = {}) {
  if (!point || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return null;
  const ndcX = point[0] / half;
  const ndcY = (point[1] - centerY) / half;
  return [(ndcX * 0.5 + 0.5) * size, (0.5 - ndcY * 0.5) * size];
}

/** 读当前渲染器的取景参数,交给 projectOrthoJoint */
export function silhouetteView(sil) {
  return { size: sil?.opts?.size ?? 512, half: sil?.camera?.right ?? 1.7, centerY: sil?.camera?.position?.y ?? 0.9 };
}

/**
 * 渲染一张「带关节像素」的剪影(生成器用)。
 *
 * @param jointPoints { name: [x,y,z] } 该帧各关节的世界坐标,或 (ctx) => 上面那种对象
 *        (传函数时会在套帧 + updateMatrixWorld 之后调用,这样取到的是当前帧的骨骼位置)
 * @param crop        裁剪框;传 null = 固定取景不裁剪
 * @returns { canvas, width, height, joints: { name: [x,y] } } —— joints 已是裁剪后图内像素
 */
export function renderSilhouetteShot({
  sil, object3D, skeletons, retargeter, seq, t, boneDefs,
  mirror = false, rootMotion = false, crop = null, jointPoints = null,
}) {
  applySequenceFrame(seq, t, retargeter, boneDefs, { mirror, rootMotion });
  skeletons?.forEach((s) => s.update());
  object3D.updateMatrixWorld(true);
  const points = typeof jointPoints === "function"
    ? jointPoints({ retargeter, object3D, seq, t })
    : jointPoints;
  const raw = sil.renderRaw();
  const canvas = crop ? cropCanvas(raw, crop) : raw;

  const joints = {};
  if (points) {
    const view = silhouetteView(sil);
    const ox = crop ? Math.max(0, Math.round(crop.x)) : 0;
    const oy = crop ? Math.max(0, Math.round(crop.y)) : 0;
    for (const [name, p] of Object.entries(points)) {
      const px = projectOrthoJoint(p, view);
      if (px) joints[name] = [+(px[0] - ox).toFixed(2), +(px[1] - oy).toFixed(2)];
    }
  }
  return { canvas, width: canvas.width, height: canvas.height, joints };
}

/** 把某支舞序列的某一帧套到(重定向器驱动的)模型上 */
export function applySequenceFrame(seq, t, retargeter, boneDefs, { mirror = false, rootMotion = false } = {}) {
  const frames = seq?.frames;
  if (!frames?.length || !retargeter) return false;
  const fps = seq.meta?.fps || 30;
  const i = Math.min(frames.length - 1, Math.max(0, Math.round(t * fps)));
  retargeter.applyFrame(frames[i], { boneDefs, mirror, rootMotion });
  return true;
}

/**
 * 渲染「序列某一帧」的剪影:套帧 → 渲染 → 按 alpha 裁剪。返回可直接 drawImage 的 canvas。
 * skins 需要在外层调用 skeletons.forEach(s => s.update()) —— 这里代劳。
 */
export function renderSilhouetteFrame({
  sil, object3D, skeletons, retargeter, seq, t, boneDefs, mirror = false, rootMotion = false, crop = true,
}) {
  applySequenceFrame(seq, t, retargeter, boneDefs, { mirror, rootMotion });
  skeletons?.forEach((s) => s.update());
  object3D.updateMatrixWorld(true);
  const raw = sil.renderRaw();
  return crop ? cropToAlpha(raw, { padFrac: sil.opts.padFrac, alphaThreshold: sil.opts.alphaThreshold }) : raw;
}

/** canvas → PNG dataURL(离屏渲染没有跨域污染,可直接导出) */
export function canvasToPng(canvas) {
  return canvas.toDataURL("image/png");
}

/**
 * 「招牌动作」挑选:用重建关节的最大间距衡量展开度,取最展开的那一帧。
 * joints 由调用方传入(通常是 reconstructJoints(frame, dims, boneDefs)),
 * 这样本模块不依赖 playback.js。
 */
export function spreadOfJoints(joints) {
  const pts = Object.values(joints).filter((p) => Array.isArray(p));
  let m = 0;
  for (const a of pts) {
    for (const b of pts) {
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d > m) m = d;
    }
  }
  return m;
}

/**
 * 在一支舞里挑「最展开」的若干个时刻(自动招牌帧)。
 * @param seq 参考序列
 * @param jointsAt (frame) => joints 的函数(由调用方注入 reconstructJoints,避免本模块耦合)
 * @param opts.count 要几个;stepSec 采样步长;minGapSec 两个结果之间的最小间隔
 */
export function pickSignatureTimes(seq, jointsAt, { count = 1, stepSec = 0.25, minGapSec = 0.8 } = {}) {
  const frames = seq?.frames || [];
  if (!frames.length) return [];
  const fps = seq.meta?.fps || 30;
  const step = Math.max(1, Math.round(stepSec * fps));
  const scored = [];
  for (let i = 0; i < frames.length; i += step) {
    scored.push({ t: i / fps, spread: spreadOfJoints(jointsAt(frames[i])) });
  }
  scored.sort((a, b) => b.spread - a.spread);
  const picked = [];
  for (const s of scored) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p.t - s.t) < minGapSec)) continue;
    picked.push(s);
  }
  return picked.map((p) => ({ t: +p.t.toFixed(3), spread: +p.spread.toFixed(3) })).sort((a, b) => a.t - b.t);
}
