/**
 * retarget.js — 把「契约帧」的骨骼单位向量映射到人形骨架(FBX/GLB)。
 *
 * 策略(v2):
 *   - 脊柱:方向对齐(多节 Spine 共享同一方向)。
 *   - 四肢:位置级「两骨 IK」(ik.js),末端(腕/踝)精确到位,肘/膝弯折方向用 pole 约束。
 *   - 头:相对「中性朝向」的偏差(点头/转头/歪头),避免把鼻子的解剖前凸当抬头。
 *   - 根节点:高度追踪,让脚始终贴地;脚掌做简单 foot-IK 保持水平。
 *
 * 坐标系标定见 pose_capture/models/README.md:canonical x=右, y=上, z=朝镜头。
 */

import * as THREE from "three";
import { reconstructJoints } from "../pose_capture/playback.js";
import { solveTwoBone } from "./ik.js";

const MIXA = "mixamorig";
const _norm = (s) => s.toLowerCase();

// 脊柱多节骨骼按「曲率权重」分布同一条 spine 方向:下段更直、上段跟随躯干前倾,
// 让身体前倾/侧倾时呈现自然 S 曲线,而不是一整根刚性杆。
const SPINE_TARGETS = [
  { name: "Spine",  f: 0.6 },
  { name: "Spine1", f: 0.8 },
  { name: "Spine2", f: 0.95 },
  { name: "Chest",  f: 1.0 },
];

// 四肢两骨 IK 配置;endL/endR = 非镜像/镜像时重建关节点名;leg 标记是否属于腿
const LIMBS = [
  { upper: "LeftArm",     lower: "LeftForeArm",  endL: "left_wrist",  endR: "right_wrist",  l1: "upperArm", l2: "forearm", pole: "back",  leg: false },
  { upper: "RightArm",    lower: "RightForeArm", endL: "right_wrist", endR: "left_wrist",   l1: "upperArm", l2: "forearm", pole: "back",  leg: false },
  { upper: "LeftUpLeg",   lower: "LeftLeg",      endL: "left_ankle",  endR: "right_ankle",  l1: "thigh",    l2: "shin",    pole: "front", leg: true },
  { upper: "RightUpLeg",  lower: "RightLeg",     endL: "right_ankle", endR: "left_ankle",   l1: "thigh",    l2: "shin",    pole: "front", leg: true },
];

export class Retargeter {
  /**
   * @param {THREE.Object3D} root 模型根节点(已缩放、已摆好,且 updateMatrixWorld 已调用)
   */
  constructor(root) {
    this.root = root;
    this.bones = {}; // 归一化名 -> bone
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (o.isBone) this.bones[_norm(o.name)] = o;
    });

    const hips = this.findBone(["Hips"]);
    if (!hips) {
      throw new Error("未找到 Hips 骨骼:仅支持人形骨架(FBX/GLB)");
    }
    this.hips = hips;

    // ---- 模型休息基(right/up/forward) ----
    const leftArm = this.findBone(["LeftArm"]);
    const rightArm = this.findBone(["RightArm"]);
    const chest = this.findBone(["Chest", "Spine2", "Neck"]);
    let right = new THREE.Vector3(1, 0, 0);
    let up = new THREE.Vector3(0, 1, 0);
    let forward = new THREE.Vector3(0, 0, 1);
    if (leftArm && rightArm) {
      right = rightArm.getWorldPosition(new THREE.Vector3())
        .sub(leftArm.getWorldPosition(new THREE.Vector3())).normalize();
    }
    if (chest && hips) {
      up = chest.getWorldPosition(new THREE.Vector3())
        .sub(hips.getWorldPosition(new THREE.Vector3())).normalize();
    }
    forward = new THREE.Vector3().crossVectors(right, up).normalize();
    if (forward.lengthSq() < 0.5) {
      right.set(1, 0, 0); up.set(0, 1, 0); forward.set(0, 0, 1);
    }
    // 用脚趾方向校正 forward 的符号(脚趾永远朝前)
    this._fixForwardByToes(forward);
    this.basis = { right, up, forward };

    // ---- 身体尺寸(供 reconstructJoints 重建目标关节点) ----
    this.dims = this._computeDims(hips, leftArm, rightArm, chest);
    this.ankleYRest = -hips.getWorldPosition(new THREE.Vector3()).y;
    this.rootBaseY = root.position.y;
    this._hipShift = 0;
    // 骨骼四元数平滑系数(0~1):1 = 完全跟手(默认)。
    // 注意:输入已在 pose_capture 管线里过 One Euro 滤波,这里再叠加平滑会明显拖慢
    // 响应(「提线木偶」感)。除非看到高频抖动,否则不要调小;要调建议 0.7~0.9。
    this.smooth = 1;

    // ---- 脊柱 ----
    this.spineDriven = [];
    for (const s of SPINE_TARGETS) {
      const b = this.findBone([s.name]);
      if (b) this.spineDriven.push({ ...this._capture(b), f: s.f });
    }

    // ---- 四肢 ----
    this.limbs = [];
    for (const cfg of LIMBS) {
      const upper = this.findBone([cfg.upper]);
      const lower = this.findBone([cfg.lower]);
      if (!upper || !lower) continue;
      this.limbs.push({ ...cfg, upper: this._capture(upper), lower: this._capture(lower) });
    }

    // ---- 头 ----
    this.headBone = this.findBone(["Head"]);
    if (this.headBone) {
      this.headRestQuat = this.headBone.getWorldQuaternion(new THREE.Quaternion()).clone();
      this.headRestLocalQuat = this.headBone.quaternion.clone();
    }
    this._headNeutral = null;

    // ---- 脚 ----
    this.feet = [];
    for (const n of ["LeftFoot", "RightFoot"]) {
      const foot = this.findBone([n]);
      if (foot && foot.parent && foot.parent.isBone) {
        this.feet.push({
          bone: foot,
          restWorldQuat: foot.getWorldQuaternion(new THREE.Quaternion()).clone(),
          restLocalQuat: foot.quaternion.clone(),
        });
      }
    }

    this._indexCache = new WeakMap();
  }

  _capture(bone) {
    return {
      bone,
      rest: this._restDirection(bone),
      restQuat: bone.getWorldQuaternion(new THREE.Quaternion()).clone(),
      restLocalQuat: bone.quaternion.clone(),
    };
  }

  _computeDims(hips, leftArm, rightArm, chest) {
    const D = (a, b) =>
      a && b ? a.getWorldPosition(new THREE.Vector3()).distanceTo(b.getWorldPosition(new THREE.Vector3())) : 0;
    const lf = this.findBone(["LeftForeArm"]);
    const lh = this.findBone(["LeftHand"]);
    const rf = this.findBone(["RightForeArm"]);
    const rh = this.findBone(["RightHand"]);
    const lul = this.findBone(["LeftUpLeg"]);
    const ll = this.findBone(["LeftLeg"]);
    const lft = this.findBone(["LeftFoot"]);
    const rul = this.findBone(["RightUpLeg"]);
    const rl = this.findBone(["RightLeg"]);
    const rft = this.findBone(["RightFoot"]);
    const head = this.findBone(["Head"]);
    return {
      spineLen: D(hips, chest),
      shoulderWidth: D(leftArm, rightArm),
      hipWidth: D(ll, rl), // 膝宽 ≈ 髋宽(骨架里没有独立髋骨)
      upperArm: (D(leftArm, lf) + D(rightArm, rf)) / 2,
      forearm: (D(lf, lh) + D(rf, rh)) / 2,
      thigh: (D(lul, ll) + D(rul, rl)) / 2,
      shin: (D(ll, lft) + D(rl, rft)) / 2,
      headLen: D(chest, head) * 0.6,
    };
  }

  _worldPos(bone) {
    return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
  }

  // 用「脚趾 - 脚」的水平方向校正 forward 的符号(脚趾永远朝前)
  _fixForwardByToes(forward) {
    const lf = this.findBone(["LeftFoot"]);
    const lt = this.findBone(["LeftToeBase", "LeftToe_End"]);
    const rf = this.findBone(["RightFoot"]);
    const rt = this.findBone(["RightToeBase", "RightToe_End"]);
    const toe = new THREE.Vector3();
    let ok = false;
    if (lf && lt) {
      toe.add(this._worldPos(lt).sub(this._worldPos(lf)));
      ok = true;
    }
    if (rf && rt) {
      toe.add(this._worldPos(rt).sub(this._worldPos(rf)));
      ok = true;
    }
    if (!ok) return;
    toe.y = 0;
    if (toe.lengthSq() < 1e-8) return;
    toe.normalize();
    if (toe.dot(forward) < 0) forward.negate();
  }

  // 骨骼「父→子」休息方向;叶子骨骼回退到本地 +Y 的世界朝向
  _restDirection(bone) {
    for (const child of bone.children) {
      if (!child.isBone) continue;
      const a = bone.getWorldPosition(new THREE.Vector3());
      const b = child.getWorldPosition(new THREE.Vector3());
      const d = b.sub(a);
      if (d.lengthSq() > 1e-10) return d.normalize();
    }
    return new THREE.Vector3(0, 1, 0)
      .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion()))
      .normalize();
  }

  findBone(candidates) {
    const all = Object.keys(this.bones);
    for (const c of candidates) if (this.bones[c]) return this.bones[c];
    for (const c of candidates) {
      const low = _norm(c);
      const hit = all.find((k) => k === low);
      if (hit) return this.bones[hit];
    }
    for (const c of candidates) {
      const stripped = _norm(c).replace(new RegExp("^" + MIXA), "");
      const hit = all.find((k) => k === stripped);
      if (hit) return this.bones[hit];
    }
    for (const c of candidates) {
      const stripped = _norm(c).replace(new RegExp("^" + MIXA), "");
      const hit = all.find((k) => k.endsWith(stripped));
      if (hit) return this.bones[hit];
    }
    return null;
  }

  _boneIndex(boneDefs) {
    if (!this._indexCache.has(boneDefs)) {
      const map = {};
      boneDefs.forEach((b, i) => (map[b.name] = i));
      this._indexCache.set(boneDefs, map);
    }
    return this._indexCache.get(boneDefs);
  }

  // 方向对齐:把某骨骼的休息方向转到 target 方向(带四元数平滑,消除高频抖动)
  _applyDir(cap, target) {
    const delta = new THREE.Quaternion().setFromUnitVectors(cap.rest, target);
    const targetQuat = delta.multiply(cap.restQuat);
    const pw = cap.bone.parent && cap.bone.parent.isBone
      ? cap.bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const targetLocal = pw.clone().invert().multiply(targetQuat);
    cap.bone.quaternion.slerp(targetLocal, this.smooth);
    cap.bone.updateWorldMatrix(true, false);
  }

  /**
   * 应用一帧契约数据。
   */
  applyFrame(frame, { boneDefs, mirror = true, flipFacing = false, minConf = 0.3 } = {}) {
    if (!frame || !Array.isArray(frame.bones) || !boneDefs) return;
    const bones = frame.bones;
    const idx = this._boneIndex(boneDefs);
    const conf = frame.conf || [];

    // ---- canonical -> world 基 ----
    const r = this.basis.right.clone();
    if (mirror) r.negate();
    const u = this.basis.up;
    const f = this.basis.forward.clone();
    if (flipFacing) f.negate();
    const m = new THREE.Matrix3().set(r.x, u.x, f.x, r.y, u.y, f.y, r.z, u.z, f.z);
    const toWorld = (p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix3(m);

    const isFullBody = idx["thigh_l"] != null;
    const joints = reconstructJoints(frame, this.dims, boneDefs);

    // ---- 根高度:脚贴地(仅全身模式有腿数据) ----
    if (isFullBody && joints.left_ankle && joints.right_ankle) {
      const ankleY = (joints.left_ankle[1] + joints.right_ankle[1]) / 2;
      const target = this.ankleYRest - ankleY;
      this._hipShift += (target - this._hipShift) * 0.85; // 只做很轻的低通,避免垂直方向拖沓
      this.root.position.y = this.rootBaseY + this._hipShift;
      this.root.updateMatrixWorld(true);
    }

    // ---- 脊柱(方向对齐 + 曲率分布) ----
    const spineI = idx["spine"];
    if (spineI != null && bones[spineI] && (conf[spineI] ?? 1) >= minConf) {
      const spineDir = new THREE.Vector3(bones[spineI][0], bones[spineI][1], bones[spineI][2])
        .applyMatrix3(m).normalize();
      const up = this.basis.up;
      for (const s of this.spineDriven) {
        // 下段更贴近竖直、上段更跟随躯干方向 → 自然 S 曲线
        const target = up.clone().lerp(spineDir, s.f).normalize();
        this._applyDir(s, target);
      }
    }

    // ---- 四肢(两骨 IK) ----
    const hipWorld = this.hips.getWorldPosition(new THREE.Vector3());
    for (const limb of this.limbs) {
      if (limb.leg && !isFullBody) continue;
      const endName = mirror ? limb.endR : limb.endL;
      const end = joints[endName];
      if (!end) continue;
      const targetEnd = toWorld(end).add(hipWorld);
      const p0 = limb.upper.bone.getWorldPosition(new THREE.Vector3());
      const l1 = this.dims[limb.l1];
      const l2 = this.dims[limb.l2];
      const poleDir = limb.pole === "front" ? f : f.clone().negate();
      const pole = p0.clone().add(poleDir);
      const sol = solveTwoBone(p0, targetEnd, l1, l2, pole);
      this._applyDir(limb.upper, sol.upperDir);
      this._applyDir(limb.lower, sol.lowerDir);
    }

    // ---- 头:相对中性朝向的偏差 ----
    if (this.headBone) {
      const hi = idx["head"];
      if (hi != null && bones[hi]) {
        const hd = new THREE.Vector3(bones[hi][0], bones[hi][1], bones[hi][2])
          .applyMatrix3(m).normalize();
        if (!this._headNeutral) this._headNeutral = hd.clone();
        const delta = new THREE.Quaternion().setFromUnitVectors(this._headNeutral, hd);
        const tq = delta.multiply(this.headRestQuat);
        const pw = this.headBone.parent && this.headBone.parent.isBone
          ? this.headBone.parent.getWorldQuaternion(new THREE.Quaternion())
          : new THREE.Quaternion();
        this.headBone.quaternion.slerp(pw.clone().invert().multiply(tq), this.smooth);
        this.headBone.updateWorldMatrix(true, false);
      }
    }

    // ---- 脚:世界朝向 ≈ 休息(脚掌贴地) ----
    for (const ft of this.feet) {
      const pw = ft.bone.parent.getWorldQuaternion(new THREE.Quaternion());
      ft.bone.quaternion.copy(pw.invert().multiply(ft.restWorldQuat));
      ft.bone.updateWorldMatrix(true, false);
    }
  }

  // 回到休息姿态
  reset() {
    for (const cap of this.spineDriven) cap.bone.quaternion.copy(cap.restLocalQuat);
    for (const limb of this.limbs) {
      limb.upper.bone.quaternion.copy(limb.upper.restLocalQuat);
      limb.lower.bone.quaternion.copy(limb.lower.restLocalQuat);
    }
    if (this.headBone) {
      this.headBone.quaternion.copy(this.headRestLocalQuat);
      this._headNeutral = null;
    }
    for (const ft of this.feet) ft.bone.quaternion.copy(ft.restLocalQuat);
    this.root.position.y = this.rootBaseY;
    this._hipShift = 0;
    this.root.updateMatrixWorld(true);
  }
}
