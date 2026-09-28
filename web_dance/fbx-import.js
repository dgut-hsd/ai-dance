import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { fbxClipToSequence } from "../scoring/src/fbxToSequence.js";

export async function importFbx(file, opts) {
  const ab = await file.arrayBuffer();
  const root = new FBXLoader().parse(ab, "");
  const clip = (root.animations || [])[0];
  if (!clip) throw new Error("FBX 文件没有可用动画片段(animations[0])");
  return fbxClipToSequence(THREE, clip, root, opts);
}