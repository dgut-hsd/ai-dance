// fbx-probe.mjs — 验证 Node 侧 FBXLoader.parse 可行性，探测骨骼/动画结构（临时探针）
import * as fs from "node:fs";
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

const path = process.argv[2] || "songs/salsa/salsa.fbx";
const buf = fs.readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new FBXLoader();
const group = loader.parse(ab, path);

console.log("== animations ==");
for (const clip of group.animations) {
  console.log(`- name=${clip.name} duration=${clip.duration.toFixed(3)}s tracks=${clip.tracks.length}`);
}

console.log("== bones(名称) ==");
const bones = [];
group.traverse((o) => {
  if (o.isBone) bones.push(o.name);
});
console.log(bones.join("\n"));
console.log("total bones:", bones.length);

console.log("== 顶层子节点 ==");
for (const c of group.children) console.log(`- ${c.name} [${c.type}] isBone=${!!c.isBone}`);