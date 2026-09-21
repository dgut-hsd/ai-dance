/**
 * dance-library.js — 内置舞曲库:加载仓库根 fbx/ 里的 Mixamo FBX 动作片段,
 * 并做「世界空间重定向」(rest-pose 对齐)套到当前舞者骨架。
 *
 * 为什么不能直接照搬旋转轨道:
 *   Mixamo FBX(经 FBXLoader 转换)与 glTF 骨架(如默认 Michelle)虽然骨骼同名,
 *   但每块骨头的「休息姿态」(rest pose)朝向可能差 90°(尤其根骨 Hips)。
 *   直接拷贝局部四元数会让整条身体横过来/头顶朝屏幕外。
 *   所以这里先把动画 bake 成世界空间旋转,再按源/目标休息姿态的差换算回目标局部空间。
 */

import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

// 内置舞曲清单。url 相对 web_dance/ 页面,即仓库根的 fbx/ 目录。
// 想加新舞:把 FBX 丢进仓库根 fbx/,在这里补一行即可。
export const BUILTIN_DANCES = [
  { id: "hiphop", label: "Hip Hop Dancing", url: "../fbx/Hip Hop Dancing.fbx" },
  { id: "salsa", label: "Salsa Dancing", url: "../fbx/Salsa Dancing.fbx" },
];

const SAMPLING_FPS = 30; // bake 采样率

// 已加载源片段缓存(id -> { root, clips })
const _cache = new Map();
// 目标骨架的「休息姿态」缓存(root -> Map<Bone, 世界四元数>),载入时采集一次
const _restCache = new WeakMap();

function stripMixamorig(name) {
  return String(name).replace(/^mixamorig/i, "");
}

/**
 * 采集目标骨架的休息姿态(载入/复位后调用一次),供后续重定向做参考。
 */
export function captureRestPose(root) {
  root.updateMatrixWorld(true);
  const map = new Map();
  root.traverse((o) => {
    if (o.isBone) map.set(o, o.getWorldQuaternion(new THREE.Quaternion()));
  });
  _restCache.set(root, map);
  return map;
}

/**
 * 把一段 Mixamo 动画片段重定向到目标骨架(世界空间 + 休息姿态对齐)。
 * 返回可在 targetRoot 上直接 clipAction 的新片段(只含旋转轨道,原地跳)。
 */
export function retargetClipToSkeleton(clip, sourceRoot, targetRoot) {
  // 目标休息姿态:优先用载入时采集的,否则现场采集
  let dstRest = _restCache.get(targetRoot);
  if (!dstRest) dstRest = captureRestPose(targetRoot);

  // 收集源/目标骨骼,按名匹配(去 mixamorig 前缀 + 忽略大小写)
  const srcByName = new Map();
  sourceRoot.traverse((o) => { if (o.isBone) srcByName.set(o.name, o); });
  const dstByKey = new Map();
  targetRoot.traverse((o) => {
    if (o.isBone) dstByKey.set(stripMixamorig(o.name).toLowerCase(), o);
  });

  const pairs = []; // { src, dst }
  for (const [name, src] of srcByName) {
    const dst = dstByKey.get(stripMixamorig(name).toLowerCase());
    if (dst) pairs.push({ src, dst });
  }
  if (!pairs.length) return new THREE.AnimationClip(clip.name, clip.duration, []);

  // 拓扑排序:父骨骼先于子骨骼(算目标局部旋转时要先有父的世界朝向)
  const depthOf = new Map();
  (function walk(o, d) { depthOf.set(o, d); for (const c of o.children) walk(c, d + 1); })(sourceRoot, 0);
  pairs.sort((a, b) => (depthOf.get(a.src) ?? 0) - (depthOf.get(b.src) ?? 0));
  const pairOfSrc = new Map(pairs.map((p) => [p.src, p]));

  // 每块骨头的世界空间修正:delta = dstRest * srcRest⁻¹
  sourceRoot.updateMatrixWorld(true);
  const delta = new Map();
  for (const p of pairs) {
    const srcRest = p.src.getWorldQuaternion(new THREE.Quaternion());
    const dstR = dstRest.get(p.dst);
    if (!dstR) continue;
    delta.set(p.src, dstR.clone().multiply(srcRest.clone().invert()));
  }

  // 用源自己的 mixer 逐帧采样(源骨头的世界四元数)
  const mixer = new THREE.AnimationMixer(sourceRoot);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.update(0); // 绑定并落到 t=0

  const dur = Math.max(0.001, clip.duration || 0);
  const total = Math.max(2, Math.round(dur * SAMPLING_FPS));
  const dt = dur / total;
  const times = [];
  const sampleOf = new Map(); // src -> [x,y,z,w, ...]
  for (const p of pairs) sampleOf.set(p.src, []);

  for (let i = 0; i <= total; i++) {
    times.push(i * dt);
    if (i > 0) mixer.update(dt);
    sourceRoot.updateMatrixWorld(true);

    const correctedWorld = new Map(); // src -> 修正后的世界四元数
    for (const p of pairs) {
      if (!delta.has(p.src)) continue;
      const srcWorld = p.src.getWorldQuaternion(new THREE.Quaternion());
      const cw = delta.get(p.src).clone().multiply(srcWorld);
      correctedWorld.set(p.src, cw);

      // 目标局部 = 父世界⁻¹ × 修正世界
      let parentWorld;
      const pp = p.src.parent ? pairOfSrc.get(p.src.parent) : null;
      if (pp) {
        parentWorld = correctedWorld.get(pp.src);
      } else {
        const dstParent = p.dst.parent;
        parentWorld = (dstParent && dstParent.isBone)
          ? (dstRest.get(dstParent) || new THREE.Quaternion())
          : new THREE.Quaternion();
      }
      if (!parentWorld) parentWorld = new THREE.Quaternion();
      const local = parentWorld.clone().invert().multiply(cw);
      const arr = sampleOf.get(p.src);
      arr.push(local.x, local.y, local.z, local.w);
    }
  }

  // 组装目标片段(只保留旋转轨道)
  const tracks = [];
  for (const p of pairs) {
    const arr = sampleOf.get(p.src);
    if (!arr || !arr.length) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(p.dst.name + ".quaternion", times, arr));
  }
  if (!tracks.length) {
    console.warn(
      "retargetClipToSkeleton: 没有骨骼能匹配。",
      "源骨骼示例:", [...srcByName.keys()].slice(0, 12).join(", "),
      "| 目标骨骼示例:", [...dstByKey.keys()].slice(0, 12).join(", "),
    );
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * 加载一支内置舞曲的源骨架与动画片段(缓存)。
 * @returns {Promise<{ root: THREE.Object3D, clips: THREE.AnimationClip[] }>}
 */
export async function loadDanceClips(dance) {
  if (_cache.has(dance.id)) return _cache.get(dance.id);
  const loader = new FBXLoader();
  const root = await loader.loadAsync(encodeURI(dance.url));
  const clips = root.animations || [];
  const entry = { root, clips };
  _cache.set(dance.id, entry);
  return entry;
}
