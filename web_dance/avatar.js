/**
 * avatar.js — 加载 FBX / GLB 人形模型,并做好 retarget 前的预处理:
 *   归一化身高、把模型底部放到地板上、居中,然后构建 Retargeter。
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { Retargeter } from "./retarget.js";

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

  return prepare(object, animations, brightness);
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

  const retargeter = new Retargeter(object);

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
