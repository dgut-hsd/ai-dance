/**
 * avatar.js — 加载 FBX / GLB 人形模型,并做好 retarget 前的预处理:
 *   归一化身高、把模型底部放到地板上、居中,然后构建 Retargeter。
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { Retargeter } from "./retarget.js";
import { RETARGET_TPOSE } from "./retarget-tpose.js";

// 默认舞者:本地 Mixamo 骨架的 dancer_girl.fbx;可在 /settings 后台切换其它模型。
// 想用自己的角色,可在后台填自定义 URL(支持 .glb/.gltf/.fbx 或 http(s) 地址)。
export const DEFAULT_MODEL = "../models/dancer_girl.fbx";
export const TARGET_HEIGHT = 2.2; // 模型归一化到 2.2 个场景单位(更大、更醒目)

export function detectExt(url) {
  const clean = String(url).split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".fbx")) return "fbx";
  if (clean.endsWith(".gltf")) return "gltf";
  return "glb";
}

export async function loadAvatar(url = DEFAULT_MODEL, type, brightness = 1) {
  const ext = (type || "").toLowerCase() || detectExt(url);

  let object;
  let animations = [];
  if (ext === "fbx") {
    const loader = new FBXLoader();
    const result = await loader.loadAsync(url);
    object = result;
    animations = result.animations || [];
  } else {
    const loader = new GLTFLoader();
    // 默认配 Draco 解码器(若模型非 Draco 压缩则不会被使用)
    const draco = new DRACOLoader();
    draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    object = gltf.scene || gltf.scenes?.[0];
    animations = gltf.animations || [];
  }
  if (!object) throw new Error("模型加载失败:没有可用的场景对象");

  // 这套角色的颜色已画在贴图里。FBXLoader 的 Phong 高光会把黑衣服照成银白色，
  // 因此只对默认角色使用不受舞台灯光和曝光影响的贴图材质。
  if (ext === "fbx" && /(?:^|\/)dancer_girl\.fbx$/i.test(String(url).split(/[?#]/)[0])) {
    usePaintedAvatarMaterials(object);
    animations = setDancerGirlNeutralPose(object, animations);
    // 重定向基准:把休息姿态摆成 T-pose(见下方说明)。URL 加 ?tpose=off 可关掉做 A/B 对比。
    if (tposeEnabled()) {
      const moved = applyRetargetTPose(object);
      console.info(`[avatar] 重定向基准已摆成 T-pose(调整 ${moved} 根骨);加 ?tpose=off 可关闭对比`);
    }
  }

  return prepare(object, animations, brightness);
}

// ---------------------------------------------------------------------------
// 重定向基准:T-pose
// ---------------------------------------------------------------------------
// 为什么要这一步:重定向做的是「把源骨相对其休息姿态的旋转搬到目标骨上」,
// 两边必须先对「什么叫中立姿态」有共识。源 FBX(Rokoko/Mixamo)是 T-pose,
// 而 dancer_girl 的休息姿态是「手臂垂在身侧 + 一条腿在前」——两者每根骨差 57~131°。
// 差这么大时,那个固定补偿会连关节转动轴一起拧过去:动作方向被改写、肘/膝往错的方向折、
// 手插进躯干(实测最差 79/863 帧)。把基准摆成和源一致的 T-pose,补偿量掉到几度。
// 代价:模型静止(idle / 停止后)时会以 T-pose 站立。
const T_POSE_REF = RETARGET_TPOSE;

function tposeEnabled() {
  const q = typeof location !== "undefined" ? location.search : "";
  return !/^(0|off|false)$/i.test(new URLSearchParams(q).get("tpose") || "");
}

/** 碰撞代理半径模式:mesh(默认,按蒙皮网格实测) / formula(旧的按骨长估算,?collisionradii=old 做 A/B)。 */
function collisionRadiiMode() {
  const q = typeof location !== "undefined" ? location.search : "";
  const v = new URLSearchParams(q).get("collisionradii");
  if (v === "old" || v === "formula") return "formula";
  if (v === "mesh") return "mesh";
  return "formula"; // 默认:教练路径用旧的估算半径(保真;放大半径会把手臂推歪 30°)
}

const _normBone = (name) => String(name).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");

/**
 * 把模型的休息姿态对齐到参考骨架(Mixamo T-pose)的**朝向**:目标骨的世界朝向 = 参考骨的世界朝向。
 *
 * 与「只把手臂摆成水平」的区别:那样只对齐了方向,roll(绕骨长轴的扭转)是瞎猜的 → 肘的弯折平面歪掉,
 * 实测穿模反而从 28 帧涨到 70 帧。整段搬朝向(方向 + roll)才是「两边对中立姿态有共识」:
 *   方向误差 37.9° → 4.4°,手插进躯干 45 帧 → 13 帧(拿本舞自己的源当参考能到 1.9°/18 帧)。
 * 之后 captureRestPose()/Retargeter 都以它为基准。URL 加 ?tpose=off 可关闭对比。
 * @returns {number} 实际对齐的骨骼数
 */
export function applyRetargetTPose(object, refRoot = null) {
  object.updateMatrixWorld(true);
  // refRoot 给了就用「那支舞自己的源骨架」的休息姿态当参考(更贴合:实测方向误差 4.6°→2.1°、
  // 腿 11°→1.5°);没给就用烘好的通用 Mixamo 参考(web_dance/retarget-tpose.js)。
  const refBones = refRoot ? restWorldQuats(refRoot) : T_POSE_REF.bones;
  const target = new Map();
  object.traverse((o) => { if (o.isBone) target.set(_normBone(o.name), o); });
  const depthOf = new Map();
  (function walk(o, d) { depthOf.set(o, d); for (const c of o.children) walk(c, d + 1); })(object, 0);
  const entries = Object.entries(refBones)
    .map(([name, q]) => ({ bone: target.get(name), q }))
    .filter((e) => e.bone)
    // 父骨先写:子骨的局部旋转要用父骨刚更新过的世界朝向
    .sort((a, b) => (depthOf.get(a.bone) ?? 0) - (depthOf.get(b.bone) ?? 0));
  let moved = 0;
  for (const { bone, q } of entries) {
    const srcWorld = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
    const parentWorld = bone.parent
      ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    bone.quaternion.copy(parentWorld.invert().multiply(srcWorld));
    object.updateMatrixWorld(true);
    moved += 1;
  }
  object.updateMatrixWorld(true);
  return moved;
}

/** 读一份骨架的休息姿态(世界四元数,按归一化骨名)。 */
function restWorldQuats(root) {
  root.updateMatrixWorld(true);
  const out = {};
  root.traverse((o) => {
    if (!o.isBone) return;
    const key = _normBone(o.name);
    if (out[key]) return; // 重名只取第一个
    const q = o.getWorldQuaternion(new THREE.Quaternion());
    out[key] = [q.x, q.y, q.z, q.w];
  });
  return out;
}

/**
 * 按某支舞的源骨架重新对齐基准,并重建 Retargeter(它的 basis/尺寸/骨骼休息参考都基于休息姿态)。
 * 调用方随后应 `captureRestPose(avatar.object)` 刷新重定向用的休息姿态缓存。
 * @returns {number} 对齐的骨骼数
 */
export function realignRetargeter(avatar, refRoot) {
  if (!tposeEnabled()) return 0; // ?tpose=off:整套基准对齐都关掉,便于 A/B 对比
  const moved = applyRetargetTPose(avatar.object, refRoot);
  avatar.object.updateMatrixWorld(true);
  avatar.retargeter = new Retargeter(avatar.object, { collisionRadiiMode: collisionRadiiMode() });
  return moved;
}

// FBX 的静态节点姿态是蹲下低头；第一段动画的第 0 帧双脚着地、躯干直立。
// 在 Retargeter 采集休息姿态之前应用它，再把头骨调到平视。
function setDancerGirlNeutralPose(object, animations) {
  if (!animations.length) return animations;
  const mixer = new THREE.AnimationMixer(object);
  mixer.clipAction(animations[0]).play();
  mixer.update(0);
  object.updateMatrixWorld(true);

  let head;
  object.traverse((node) => {
    if (node.isBone && /(?:^|[:._-])head$/i.test(node.name.replace(/^mixamorig/i, ""))) {
      head = node;
    }
  });
  if (!head) return animations;

  const forward = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion()));
  const pitch = Math.atan2(-forward.y, forward.z);
  const correction = new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitch);
  head.quaternion.multiply(correction);
  object.updateMatrixWorld(true);

  // 自带动画会逐帧覆盖休息姿态；把同一校正加到头骨轨道，保留原本的点头变化。
  return animations.map((clip) => {
    const corrected = clip.clone();
    const headTrack = corrected.tracks.find((track) =>
      track.name === `${head.name}.quaternion`
    );
    if (!headTrack) return corrected;
    const values = headTrack.values;
    const q = new THREE.Quaternion();
    for (let i = 0; i < values.length; i += 4) {
      q.fromArray(values, i).multiply(correction).normalize().toArray(values, i);
    }
    return corrected;
  });
}

function usePaintedAvatarMaterials(object) {
  object.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.material) return;
    const painted = (source) => {
      if (!source.map) return source;
      return new THREE.MeshBasicMaterial({
        name: source.name,
        map: source.map,
        color: 0xffffff,
        side: source.side,
        transparent: source.transparent,
        opacity: source.opacity,
        alphaTest: source.alphaTest,
        depthWrite: source.depthWrite,
        toneMapped: false,
      });
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(painted)
      : painted(mesh.material);
  });
}

function prepare(object, animations = [], brightness = 1) {
  object.updateMatrixWorld(true);

  // 1) 归一化身高
  const box = new THREE.Box3().setFromObject(object);
  const height = box.getSize(new THREE.Vector3()).y;
  if (height > 1e-3) {
    object.scale.setScalar(TARGET_HEIGHT / height);
    object.updateMatrixWorld(true);
  }

  // 2) 底部贴地、水平居中
  const box2 = new THREE.Box3().setFromObject(object);
  const center = box2.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box2.min.y;
  object.updateMatrixWorld(true);

  // 3) 确认有骨架
  const bones = [];
  object.traverse((o) => {
    if (o.isBone) bones.push(o);
  });
  if (!bones.length) {
    throw new Error("模型里没有骨骼(isBone),无法驱动(仅支持人形骨架)");
  }

  const retargeter = new Retargeter(object, { collisionRadiiMode: collisionRadiiMode() });

  // 收集唯一 Skeleton(改骨骼后需要手动 update 才能刷新蒙皮),并开启阴影
  const skeletons = [];
  object.traverse((o) => {
    if (o.isSkinnedMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (o.skeleton && !skeletons.includes(o.skeleton)) skeletons.push(o.skeleton);
    }
  });

  // 4) 亮度增益(暗模型在暗场里会发黑):b>1 提亮、b<1 压暗
  applyBrightness(object, brightness);

  return { object, retargeter, bones, skeletons, animations };
}

// 亮度增益只调整材质颜色，不添加自发光；自发光会抹平舞台灯光形成的阴影。
function applyBrightness(object, brightness) {
  const b = Math.max(0.2, Math.min(3, Number(brightness) || 1));
  object.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.map && m.color) m.color.setRGB(1, 1, 1);
      if (m.color) m.color.multiplyScalar(b);
      m.needsUpdate = true;
    }
  });
}

// 找到模型里的 SkinnedMesh(用于开启阴影 / 材质微调等)
export function skinnedMeshes(object) {
  const out = [];
  object.traverse((o) => {
    if (o.isSkinnedMesh) out.push(o);
  });
  return out;
}
