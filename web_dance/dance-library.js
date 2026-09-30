/**
 * dance-library.js — 内置舞曲库:加载 songs/<danceId>/ 里保存的 Mixamo FBX 动作片段,
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
import { createSkeletonCollisionPass } from "./skeleton-collision.js";
import { recenterTravel } from "./root-travel.js";

// 内置舞曲清单。url 相对 web_dance/ 页面,即 songs/<danceId>/<danceId>.fbx(原始 Mixamo 源)。
// 想加新舞:把 FBX 放进 songs/<danceId>/<danceId>.fbx,在这里补一行即可。
export const BUILTIN_DANCES = [
  { id: "hiphop", label: "Hip Hop Dancing", url: "../songs/hiphop/hiphop.fbx" },
  { id: "salsa", label: "Salsa Dancing", url: "../songs/salsa/salsa.fbx" },
  { id: "copydance1", label: "Copy Dance 1", url: "../songs/copydance1/copydance1.fbx" },
];

const SAMPLING_FPS = 30; // bake 采样率

// 「源片段第 0 帧其实是骨架 bind pose」的判定阈值(与 scoring/src/fbxToSequence.js 同一套):
// 首帧与静态姿态足够接近(留 25° 余量),且首帧→次帧是明显跳变(正常舞蹈帧间只有 ~9°)。
const BIND_FRAME_EPS_RAD = 25 * Math.PI / 180;
/** 髋部水平位移上限(舞台范围,单位=模型身高 2.2 的同一单位)。正常编舞自己会回到中间,这里只防"意外跑飞"。 */
const ROOT_TRAVEL_LIMIT = 2.2; // 舞台半径 2.88(见 scene.js 的地台)留一点余量
/** 水平走位「去漂移」的移动平均窗口(秒):比这慢的漂移会被慢慢拉回中心 */
const TRAVEL_RECENTER_SEC = 2.5;
const BIND_FRAME_JUMP_RAD = 10 * Math.PI / 180;

// 已加载源片段缓存(id -> { root, clips })
const _cache = new Map();
// 目标骨架的「休息姿态」缓存(root -> Map<Bone, 世界四元数>),载入时采集一次
const _restCache = new WeakMap();

// 归一化骨骼名:去掉 mixamorig 前缀,并去掉可能残留的分隔符(: . _ - 空格)。
// 兼容三种命名:Mixamo FBX 的 `mixamorigHips`、Michelle glb 的 `mixamorig:Hips`、
// 以及 ReadyPlayerMe 的 `Hips`,统一归一到 `hips`。
function normalizeBoneName(name) {
  return String(name)
    .toLowerCase()
    .replace(/^mixamorig/i, "")
    .replace(/^[:._\s-]+/, "");
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
 * 源骨架的 bind(静态)姿态快照。第一次遇到某个源时记下来(此刻它就是 bind 姿态),
 * 之后每次重定向前还原 —— 重定向过程会在源骨架上播动画,缓存复用时不能直接当休息姿态读。
 * @returns {boolean} 是否真的做了还原(第一次采样时返回 false)
 */
const _bindSnapshot = new WeakMap();
function restoreBindPose(root) {
  let snap = _bindSnapshot.get(root);
  if (!snap) {
    snap = [];
    root.traverse((o) => {
      if (o.isBone) snap.push({ bone: o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
    });
    _bindSnapshot.set(root, snap);
    return false;
  }
  for (const s of snap) {
    s.bone.position.copy(s.p);
    s.bone.quaternion.copy(s.q);
    s.bone.scale.copy(s.s);
  }
  root.updateMatrixWorld(true);
  return true;
}

/**
 * 把一段 Mixamo 动画片段重定向到目标骨架(世界空间 + 休息姿态对齐)。
 * 返回可在 targetRoot 上直接 clipAction 的新片段(只含旋转轨道,原地跳)。
 */
export function retargetClipToSkeleton(clip, sourceRoot, targetRoot, { preserveArmRotations = false, collision = true, rootMotion = true, radiiMode = "mesh", collisionAllowance, radiiBlend } = {}) {
  // 源骨架是缓存复用的,而重定向会在它身上播动画 → 先把姿态还原回 bind(静态)姿态,
  // 否则这里读到的「休息姿态」是上一段动画的最后一帧,重定向基准就错了(切歌切回来会明显跑偏)。
  restoreBindPose(sourceRoot);

  // 目标休息姿态:优先用载入时采集的,否则现场采集
  let dstRest = _restCache.get(targetRoot);
  if (!dstRest) dstRest = captureRestPose(targetRoot);

  // 收集源/目标骨骼,按名匹配(去 mixamorig 前缀 + 忽略大小写)
  const srcByName = new Map();
  sourceRoot.traverse((o) => { if (o.isBone) srcByName.set(o.name, o); });
  const dstByKey = new Map();
  targetRoot.traverse((o) => {
    if (o.isBone) dstByKey.set(normalizeBoneName(o.name), o);
  });

  const pairs = []; // { src, dst }
  for (const [name, src] of srcByName) {
    const dst = dstByKey.get(normalizeBoneName(name));
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
  const srcRestQ = new Map(); // 源骨架的 bind(静态)姿态,用来识别「第 0 帧是 bind pose」
  for (const p of pairs) {
    const srcRest = p.src.getWorldQuaternion(new THREE.Quaternion());
    const dstR = dstRest.get(p.dst);
    if (!dstR) continue;
    srcRestQ.set(p.src, srcRest.clone());
    delta.set(p.src, dstR.clone().multiply(srcRest.clone().invert()));
  }

  // 用源自己的 mixer 逐帧采样(源骨头的世界四元数)
  const mixer = new THREE.AnimationMixer(sourceRoot);
  const action = mixer.clipAction(clip);
  action.play();
  mixer.update(0); // 绑定并落到 t=0

  // 髋部位移(走位 + 蹲/跳):本函数原本只保留旋转轨道 → 髋高恒为休息值、走位完全不体现。
  // 做法:取「源髋相对其休息位置的三维偏移」→ 换到源髋自己的静止坐标系 → 按身高比缩放 →
  // 再映射到目标髋的静止朝向,写成目标髋的位置轨道。
  // 水平方向保留(舞里的走位一般会自己回到舞台中间,不需要额外回中),只夹一个舞台范围上限防跑飞。
  targetRoot.updateMatrixWorld(true);
  const hipsPair = pairs.find((p) => normalizeBoneName(p.src.name) === "hips");
  let hipsMotion = null;
  if (rootMotion && hipsPair) {
    const srcRestPos = hipsPair.src.getWorldPosition(new THREE.Vector3());
    const srcRestY = srcRestPos.y;
    const tgtRestWorld = hipsPair.dst.getWorldPosition(new THREE.Vector3());
    if (Number.isFinite(srcRestY) && Math.abs(srcRestY) > 1e-6 && Number.isFinite(tgtRestWorld.y)) {
      const parent = hipsPair.dst.parent;
      const soleBones = ["mixamorigLeftFoot", "mixamorigRightFoot", "mixamorigLeftToeBase", "mixamorigRightToeBase"]
        .map((n) => targetRoot.getObjectByName(n)).filter(Boolean);
      let restLowest = Infinity;
      for (const b of soleBones) {
        const y = b.getWorldPosition(new THREE.Vector3()).y;
        if (y < restLowest) restLowest = y;
      }
      hipsMotion = {
        srcRestPos,
        srcRestQuatInv: hipsPair.src.getWorldQuaternion(new THREE.Quaternion()).invert(),
        tgtRestQuat: hipsPair.dst.getWorldQuaternion(new THREE.Quaternion()),
        srcRestY,
        tgtRestWorld,
        restLocal: hipsPair.dst.position.clone(),
        parentInv: parent ? new THREE.Matrix4().copy(parent.matrixWorld).invert() : new THREE.Matrix4(),
        scale: Math.abs(tgtRestWorld.y) / Math.abs(srcRestY),
        values: [],
        raw: [], // 每帧 [水平x, 竖直y, 水平z];落轨道前统一做「去漂移 + 舞台限幅」
        minDy: Infinity,
        maxDy: -Infinity,
        liftedFrames: 0,
        floorY: 0, // 模型载入时底部已贴地,地板就是 y=0
        soleBones,
        // 休息姿态下「最低脚骨」的 Y ≈ 脚骨离脚底的高度;脚底 Y = 脚骨 Y − 这个偏移
        soleOffset: Number.isFinite(restLowest) ? restLowest : 0,
        src: hipsPair.src,
        dst: hipsPair.dst,
      };
    }
  }

  const dur = Math.max(0.001, clip.duration || 0);
  const total = Math.max(2, Math.round(dur * SAMPLING_FPS));
  const dt = dur / total;

  // 有些源(例如 Rokoko 导出)把骨架 bind pose(T-pose)当成第 0 帧:那一帧不是动作的一部分。
  // 先探两帧,若「首帧≈bind 姿态」且「首帧→次帧是明显跳变」就跳过它 ——
  // 否则每次播放/循环都会先闪一下目标骨架的休息姿态(实测 copydance1 首帧跳变 82°)。
  const angleOf = (a, b) => {
    const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    return 2 * Math.acos(Math.min(1, d)); // 四元数夹角(rad),取 |dot| 处理双覆盖
  };
  const worldQuats = () => pairs.map((p) => p.src.getWorldQuaternion(new THREE.Quaternion()));
  sourceRoot.updateMatrixWorld(true);
  const w0 = worldQuats();
  mixer.update(dt);
  sourceRoot.updateMatrixWorld(true);
  const w1 = worldQuats();
  const toBind = Math.max(...pairs.map((p, i) => (srcRestQ.has(p.src) ? angleOf(w0[i], srcRestQ.get(p.src)) : 0)));
  const toNext = Math.max(...pairs.map((_, i) => angleOf(w0[i], w1[i])));
  const skipFirst = toBind < BIND_FRAME_EPS_RAD && toNext > BIND_FRAME_JUMP_RAD;
  if (skipFirst) {
    console.warn(
      `[dance-library] 源片段第 0 帧是骨架 bind pose(与静态姿态差 ${(toBind * 180 / Math.PI).toFixed(1)}°,` +
      `下一帧差 ${(toNext * 180 / Math.PI).toFixed(1)}°):已跳过并整体前移 ${dt.toFixed(4)}s`,
    );
  }
  mixer.setTime(0);                 // 回到 t=0 重新采样
  if (skipFirst) mixer.update(dt);  // 跳过 bind 帧 → 从 clip 的 1/30s 开始
  const startIdx = skipFirst ? 1 : 0;

  const times = [];
  const sampleOf = new Map(); // src -> [x,y,z,w, ...]
  const armLocal = new Map(); // src -> [x,y,z,w, ...] 仅 preserveArmRotations 时收集(手臂直接用源局部旋转)
  const isArmBone = (name) => /^(left|right)(shoulder|arm|forearm|hand)$/.test(normalizeBoneName(name));
  for (const p of pairs) {
    sampleOf.set(p.src, []);
    // 同系(Mixamo 命名)骨架的手臂:直接保留源骨的局部旋转,不用「另一个休息姿态」去修正
    // (否则肘部过度折叠、手插进躯干)。按我们的时间栅格采样 → 与其它轨道同一时间基,也一起跳过 bind 帧。
    if (preserveArmRotations && isArmBone(p.src.name)) armLocal.set(p.src, []);
  }

  // 碰撞避免层(可选,默认开):见 web_dance/skeleton-collision.js 的说明。
  // 直接搬源朝向时,源里本来就贴着身体的手(抱臂/手贴肚子)在目标模型的比例下会穿进去。
  const resolveCollisions = collision ? createSkeletonCollisionPass(targetRoot, { radiiMode, allowance: collisionAllowance, blend: radiiBlend }) : null;
  let collisionFrames = 0;

  for (let i = startIdx; i <= total; i++) {
    times.push((i - startIdx) * dt);
    if (i > startIdx) mixer.update(dt);
    sourceRoot.updateMatrixWorld(true);

    const correctedWorld = new Map(); // src -> 修正后的世界四元数
    const frameApplied = [];          // 本帧每根骨实际要播放的局部旋转(碰撞之前)
    for (const p of pairs) {
      if (!delta.has(p.src)) continue;
      const srcWorld = p.src.getWorldQuaternion(new THREE.Quaternion());
      const cw = delta.get(p.src).clone().multiply(srcWorld);
      correctedWorld.set(p.src, cw);

      // 目标局部 = 父世界⁻¹ × 修正世界
      // 父是被匹配的骨骼 → 用它本帧的修正世界朝向;否则(非骨骼父节点/未匹配骨骼)
      // → 用父节点当前(休息态)的真实世界朝向,不能假设是恒等(Michelle 骨架外层有带旋转的节点)。
      let parentWorld;
      const pp = p.src.parent ? pairOfSrc.get(p.src.parent) : null;
      if (pp) {
        parentWorld = correctedWorld.get(pp.src);
      } else {
        const dstParent = p.dst.parent;
        parentWorld = dstParent
          ? dstParent.getWorldQuaternion(new THREE.Quaternion())
          : new THREE.Quaternion();
      }
      if (!parentWorld) parentWorld = new THREE.Quaternion();
      const local = parentWorld.clone().invert().multiply(cw);
      // 手臂直通(同系骨架)时,实际播放的是源骨的局部旋转,而不是上面这个修正值 ——
      // 碰撞层必须看到「真正会播放的姿态」,否则会把碰撞算在错误的位置上。
      frameApplied.push({ p, q: armLocal.has(p.src) ? p.src.quaternion.clone() : local });
    }

    // 碰撞避免:先把本帧姿态贴到目标骨架,跑一遍胶囊分离,再回读(被推开的)局部旋转。
    if (resolveCollisions) {
      for (const { p, q } of frameApplied) p.dst.quaternion.copy(q);
      targetRoot.updateMatrixWorld(true);
      if (resolveCollisions() > 0) collisionFrames += 1;
      for (const { p } of frameApplied) {
        const q = p.dst.quaternion;
        const arr = armLocal.get(p.src) ?? sampleOf.get(p.src);
        arr.push(q.x, q.y, q.z, q.w);
      }
    } else {
      for (const { p, q } of frameApplied) {
        const arr = armLocal.get(p.src) ?? sampleOf.get(p.src);
        arr.push(q.x, q.y, q.z, q.w);
      }
    }

    if (hipsMotion) {
      // 源髋相对休息位置的三维偏移 → 源髋静止坐标系 → 缩放 → 目标髋静止朝向
      const delta = hipsMotion.src.getWorldPosition(new THREE.Vector3()).sub(hipsMotion.srcRestPos);
      const local = delta.applyQuaternion(hipsMotion.srcRestQuatInv).multiplyScalar(hipsMotion.scale);
      const world = local.clone().applyQuaternion(hipsMotion.tgtRestQuat);
      const dyBase = world.y;
      const toLocal = (extraY) => hipsMotion.tgtRestWorld.clone()
        .add(world.clone().setY(dyBase + extraY))
        .applyMatrix4(hipsMotion.parentInv);
      let pos = toLocal(0);
      // 脚底单向贴地:插进地板就整体抬起来(不压低正常抬脚)。
      // 只按源的髋位移走是不够的 —— 目标腿长与源不同,蹲下时脚会穿地(实测 538/863 帧)。
      hipsMotion.dst.position.copy(pos);
      targetRoot.updateMatrixWorld(true);
      let lowestSole = Infinity;
      for (const b of hipsMotion.soleBones) {
        const y = b.getWorldPosition(new THREE.Vector3()).y;
        if (y < lowestSole) lowestSole = y;
      }
      const lift = Math.max(0, hipsMotion.floorY - (lowestSole - hipsMotion.soleOffset));
      hipsMotion.dst.position.copy(hipsMotion.restLocal); // 采样期间不动模型的姿态
      const dy = dyBase + lift;
      // 水平位移先存下来,循环结束后统一做「去漂移 + 舞台限幅」再落成轨道
      // (直接照搬源位移会把舞者带出舞台:实测 Z 摆幅 2.96 单位 > 地台半径 2.88)
      hipsMotion.raw.push([local.x, dy, local.z]);
      hipsMotion.minDy = Math.min(hipsMotion.minDy, dy);
      hipsMotion.maxDy = Math.max(hipsMotion.maxDy, dy);
      if (lift > 1e-5) hipsMotion.liftedFrames += 1;
    }
  }
  if (resolveCollisions) {
    console.info(`[dance-library] 碰撞避免:${collisionFrames}/${times.length} 帧做了最小分离`);
  }

  // 组装目标片段(只保留旋转轨道)
  const tracks = [];
  for (const p of pairs) {
    const armArr = armLocal.get(p.src);
    if (armArr && armArr.length) {
      tracks.push(new THREE.QuaternionKeyframeTrack(p.dst.name + ".quaternion", times, armArr));
      continue;
    }
    const arr = sampleOf.get(p.src);
    if (!arr || !arr.length) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(p.dst.name + ".quaternion", times, arr));
  }
  // 髋部位移轨道(走位 + 蹲/跳):水平先去掉低频漂移、再按舞台半径限幅,然后落成位置轨道。
  let travelStats = null;
  if (hipsMotion?.raw.length) {
    const dt = times.length > 1 ? times[1] - times[0] : 1 / 30;
    const adjusted = recenterTravel(hipsMotion.raw, dt, { tauSec: TRAVEL_RECENTER_SEC, limit: ROOT_TRAVEL_LIMIT });
    travelStats = { clampedFrames: adjusted.clampedFrames, maxTravel: adjusted.maxTravel };
    for (let i = 0; i < adjusted.length; i++) {
      const world = new THREE.Vector3(adjusted[i][0], adjusted[i][1], adjusted[i][2])
        .applyQuaternion(hipsMotion.tgtRestQuat);
      const pos = hipsMotion.tgtRestWorld.clone().add(world).applyMatrix4(hipsMotion.parentInv);
      hipsMotion.values.push(pos.x, pos.y, pos.z);
    }
  }
  if (hipsMotion?.values.length) {
    tracks.push(new THREE.VectorKeyframeTrack(hipsMotion.dst.name + ".position", times, hipsMotion.values));
    console.info(
      `[dance-library] 髋部位移:竖直 ${hipsMotion.minDy.toFixed(3)}~${hipsMotion.maxDy.toFixed(3)}` +
      `(摆幅 ${(hipsMotion.maxDy - hipsMotion.minDy).toFixed(3)})、水平最大 ${(travelStats?.maxTravel ?? 0).toFixed(2)} 单位` +
      `(已去漂移 τ=${TRAVEL_RECENTER_SEC}s` +
      (travelStats?.clampedFrames ? `,限幅 ${travelStats.clampedFrames} 帧 > ${ROOT_TRAVEL_LIMIT}` : "") + ")",
      (hipsMotion.liftedFrames ? `;贴地抬起 ${hipsMotion.liftedFrames} 帧` : ""),
    );
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
