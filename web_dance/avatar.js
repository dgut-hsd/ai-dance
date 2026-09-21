/**
 * avatar.js — 加载 FBX / GLB 人形模型,并做好 retarget 前的预处理:
 *   归一化身高、把模型底部放到地板上、居中,然后构建 Retargeter。
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { Retargeter } from "./retarget.js";

// 默认舞者:three.js 官方示例(Mixamo 人形骨架,骨骼名 Hips/Spine/LeftArm…),稳定可达。
// 想用自己的 ReadyPlayerMe 角色,可直接在「加载本地 FBX/GLB」里填 URL 或文件,例如:
//   https://models.readyplayer.me/YOUR_AVATAR_ID.glb
export const DEFAULT_MODEL = "https://threejs.org/examples/models/gltf/Michelle.glb";
export const TARGET_HEIGHT = 1.8; // 模型归一化到 1.8 个场景单位

export function detectExt(url) {
  const clean = String(url).split("?")[0].split("#")[0].toLowerCase();
  if (clean.endsWith(".fbx")) return "fbx";
  if (clean.endsWith(".gltf")) return "gltf";
  return "glb";
}

export async function loadAvatar(url = DEFAULT_MODEL, type) {
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

  return prepare(object, animations);
}

function prepare(object, animations = []) {
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

  return { object, retargeter, bones, skeletons, animations };
}

// 找到模型里的 SkinnedMesh(用于开启阴影 / 材质微调等)
export function skinnedMeshes(object) {
  const out = [];
  object.traverse((o) => {
    if (o.isSkinnedMesh) out.push(o);
  });
  return out;
}
