/**
 * retarget-tpose.mjs — 从一支 Mixamo 骨架的 FBX 里提取「重定向参考姿态」(T-pose 的世界朝向),
 * 烘成 web_dance/retarget-tpose.js,供 avatar.js 在载入模型时把基准摆正。
 *
 * 为什么需要:重定向是「把源骨相对其休息姿态的旋转搬到目标骨」。源是 T-pose,而目标模型
 * (dancer_girl)的休息姿态是「手臂垂在身侧 + 一条腿在前」,两者每根骨差 57~131° —— 那个固定
 * 补偿会把关节转动轴一起拧过去(实测方向误差 37.9°、手插进躯干 45~79 帧)。把目标的基准
 * 摆成与源一致的朝向(方向 + roll)后:方向误差 1.9~4.4°、穿模帧 13~18。
 *
 * 用法:
 *   node tools/retarget-tpose.mjs                       # 默认用 songs/hiphop/hiphop.fbx
 *   node tools/retarget-tpose.mjs --src <fbx> --out <js>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Node 里 FBXLoader 解析带贴图的模型时会碰 document;这个脚本不需要贴图,给个最小垫片。
if (!globalThis.document) {
  const fake = () => ({
    width: 0, height: 0, style: {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, remove() {},
    set src(_v) {}, get src() { return ""; },
  });
  globalThis.document = { createElementNS: () => fake(), createElement: () => fake() };
  if (typeof globalThis.URL.createObjectURL !== "function") {
    globalThis.URL.createObjectURL = () => "blob:stub";
    globalThis.URL.revokeObjectURL = () => {};
  }
}

const args = process.argv.slice(2);
const opt = { src: "songs/hiphop/hiphop.fbx", out: "web_dance/retarget-tpose.js" };
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--src") opt.src = args[i + 1];
  else if (args[i] === "--out") opt.out = args[i + 1];
  else if (args[i] === "--help") {
    console.log("用法: node tools/retarget-tpose.mjs [--src <fbx>] [--out <js>]");
    process.exit(0);
  }
}

const norm = (s) => String(s).toLowerCase().replace(/^mixamorig/i, "").replace(/^[:._\s-]+/, "");

const buf = readFileSync(join(ROOT, opt.src));
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
root.updateMatrixWorld(true);

const map = {};
root.traverse((o) => {
  if (!o.isBone) return;
  const key = norm(o.name);
  if (map[key]) return; // 重名只取第一个(例如 Rokoko 导出里重复的 head 节点)
  const q = o.getWorldQuaternion(new THREE.Quaternion());
  map[key] = [+q.x.toFixed(6), +q.y.toFixed(6), +q.z.toFixed(6), +q.w.toFixed(6)];
});
if (!Object.keys(map).length) throw new Error(`${opt.src} 里没找到骨骼`);

const text = `/**
 * retarget-tpose.js — 自动生成,请勿手改。
 * 由 tools/retarget-tpose.mjs 从 ${opt.src} 提取:每根骨在休息姿态(T-pose)下的**世界**四元数。
 * avatar.js 载入模型时用它把重定向基准摆正(见该文件 applyRetargetTPose 的说明)。
 * 重新生成:node tools/retarget-tpose.mjs --src ${opt.src}
 */
export const RETARGET_TPOSE = {
  source: ${JSON.stringify(opt.src)},
  bones: {
${Object.entries(map).map(([k, v]) => `    ${JSON.stringify(k)}: [${v.join(", ")}],`).join("\n")}
  },
};
`;
writeFileSync(join(ROOT, opt.out), text);
console.log(`已写出 ${opt.out}:${Object.keys(map).length} 根骨(来源 ${opt.src})`);
