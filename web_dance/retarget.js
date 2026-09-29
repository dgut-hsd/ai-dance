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
import { separateCapsulePairs } from "./collision.js";
import {
  ARM_LIMITS,
  LEG_LIMITS,
  decomposeHead,
  clampNeck,
  neckQuaternion,
  clampLegDirection,
  clampArmDirection,
  clampLegCoronal,
} from "./rom.js";

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

// 肘/膝关节夹角生理限位(rad)由 rom.js 统一提供(医学 ROM 数据):
//   ARM_LIMITS = { minBend: 40°, maxBend: 177° } —— 臂:minBend 对齐肘最大屈曲约 140°(残余内角约 40°)
//   LEG_LIMITS = { minBend: 40°, maxBend: 177° } —— 腿:minBend 从旧 0.55(≈31.5°)收紧到 40°,
//                                               贴近膝生理残余内角 35–45°,消除非生理深折;maxBend 防反折。
// 常量来源见 web_dance/rom.js(含医学 ROM 引注)。

// 四肢两骨 IK 配置;endL/endR = 非镜像/镜像时重建关节点名;leg 标记是否属于腿
const LIMBS = [
  { upper: "LeftArm",     lower: "LeftForeArm",  endL: "left_wrist",  endR: "right_wrist",  l1: "upperArm", l2: "forearm", pole: "back",  leg: false, limits: ARM_LIMITS },
  { upper: "RightArm",    lower: "RightForeArm", endL: "right_wrist", endR: "left_wrist",   l1: "upperArm", l2: "forearm", pole: "back",  leg: false, limits: ARM_LIMITS },
  { upper: "LeftUpLeg",   lower: "LeftLeg",      endL: "left_ankle",  endR: "right_ankle",  l1: "thigh",    l2: "shin",    pole: "front", leg: true,  limits: LEG_LIMITS },
  { upper: "RightUpLeg",  lower: "RightLeg",     endL: "right_ankle", endR: "left_ankle",   l1: "thigh",    l2: "shin",    pole: "front", leg: true,  limits: LEG_LIMITS },
];

// 根运动(方案 C)调参:
const ROOT_VEL_DEADZONE = 0.08; // m/s:低于此速度的水平分量视为噪声,丢弃
const ROOT_RECENTER = 0.6;      // 1/s:贴地时水平位移回中的指数速率(防随机游走漂出)
const ROOT_MAX_DISP = 1.6;      // m:水平位移半径上限(不出舞台)
const ROOT_AIR_DAMP = 0.9;      // 腾空垂直速度每帧阻尼

// S4 γ 时序平滑调参:
const GAMMA_MAX_STEP = 0.35; // rad/帧:折叠角 γ 单帧最大变化量。吃掉 >0.35 的单帧尖峰(根因5),
                             // 保留 ~0.16 rad/帧 的快速深屈(30fps 下半秒折叠不被打断)。

// 肘/膝 pole 时序距离钳(根因:弯曲过大 / 身体抽搐):MeTRAbs 单帧回归会把肘/膝点
// 瞬移到离上一帧很远的位置,导致弯折方向翻转或过度折叠。把本帧 pole 钳到上一帧
// 中间关节的 POLE_MAX_JUMP 距离内(方向不变),抑制帧间跳远又保留快速深屈(未超阈值零干预)。
const ELBOW_POLE_MAX_JUMP = 0.12; // m:肘 pole 相对上一帧肘位置的单帧最大位移
const KNEE_POLE_MAX_JUMP = 0.14;  // m:膝 pole 单帧最大位移(腿部动作幅度更大,略宽)

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
    this.hipsRestQuat = hips.getWorldQuaternion(new THREE.Quaternion()).clone();
    this.hipsRestLocalQuat = hips.quaternion.clone();
    this.bodyYaw = new THREE.Quaternion();
    this._torsoRoll = 0; // 躯干侧倾(roll,rad),由肩轴 y 分量估计;预留增强消费

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
    // 脚踝休息高度 = 髋→脚踝的腿长(负值)。与 reconstructJoints 的「髋为原点」口径自洽,
    // 避免用「髋离地高度」导致脚踝/脚掌整体下陷(差一个脚踝离地高度 + 骨盆偏移)。
    this.ankleYRest = -(this.dims.thigh + this.dims.shin);
    this.rootBasePos = root.position.clone(); // 根基准位(布局 x/z + 贴地 y)
    this._hipShift = 0;                        // 垂直位移(蹲/跳)
    this._rootDisp = new THREE.Vector3();      // 水平位移积分(前后/左右)
    this._airVy = 0;                           // 腾空垂直速度(世界系)
    this._lastT = null;                        // 上一帧 t(秒),用于积分 dt
    this._rootBaseSynced = false;              // 根基准位是否已对齐当前布局
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
      this.limbs.push({ ...cfg, upper: this._capture(upper), lower: this._capture(lower), _prevMid: null, _prevRoot: null, _prevGamma: null });
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
      hipWidth: D(lul, rul), // 膝宽 ≈ 髋宽(骨架里没有独立髋骨)
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
    const rest = cap.rest.clone().applyQuaternion(this.bodyYaw);
    const delta = new THREE.Quaternion().setFromUnitVectors(rest, target);
    const targetQuat = delta.multiply(this.bodyYaw).multiply(cap.restQuat);
    const pw = cap.bone.parent && cap.bone.parent.isBone
      ? cap.bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const targetLocal = pw.clone().invert().multiply(targetQuat);
    cap.bone.quaternion.slerp(targetLocal, this.smooth);
    cap.bone.updateWorldMatrix(true, false);
  }

  // 在世界系绕给定轴旋转某骨骼(用于「胸椎扭转」这类不在两骨 IK 目标内的轴向自由度)。
  // 在 _applyDir 之后叠加:先取骨骼当前世界四元数,左乘绕 axis 的旋转变换,再转回局部。
  _twistWorld(bone, axis, angle) {
    if (!bone || !axis || Math.abs(angle) < 1e-4) return;
    const q = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), angle);
    const pw = bone.parent && bone.parent.isBone
      ? bone.parent.getWorldQuaternion(new THREE.Quaternion())
      : new THREE.Quaternion();
    const world = q.clone().multiply(bone.getWorldQuaternion(new THREE.Quaternion()));
    const local = pw.clone().invert().multiply(world);
    bone.quaternion.slerp(local, this.smooth);
    bone.updateWorldMatrix(true, false);
  }

  /**
   * 应用一帧契约数据。
   */
  applyFrame(frame, { boneDefs, mirror = true, flipFacing = false, minConf = 0.3, rootMotion = true } = {}) {
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

    // ---- 根运动(仅全身模式):水平位移积分 + 垂直(贴地运动学 / 腾空速度) ----
    if (isFullBody && joints.left_ankle && joints.right_ankle) {
      if (!this._rootBaseSynced) {
        this.rootBasePos.copy(this.root.position);
        this._rootDisp.set(0, 0, 0);
        this._hipShift = 0;
        this._airVy = 0;
        this._lastT = null;
        this._rootBaseSynced = true;
      }

      const ankleY = (joints.left_ankle[1] + joints.right_ankle[1]) / 2;
      const kinTarget = this.ankleYRest - ankleY; // 脚踝反推髋高(蹲下正确)
      const hasRoot = rootMotion &&
        Array.isArray(frame.rootVel) && frame.rootVel.length >= 3;

      if (hasRoot) {
        const dt = this._lastT != null
          ? Math.min(Math.max(frame.t - this._lastT, 0), 0.1)
          : 0;
        this._lastT = frame.t;
        const grounded = frame.grounded !== false; // 缺省视为贴地(保守回退)
        const vWorld = toWorld(frame.rootVel);

        // 水平:死区抑制噪声 → 积分 → 贴地缓慢回中 → 限幅不出舞台
        const vx = Math.abs(vWorld.x) < ROOT_VEL_DEADZONE ? 0 : vWorld.x;
        const vz = Math.abs(vWorld.z) < ROOT_VEL_DEADZONE ? 0 : vWorld.z;
        this._rootDisp.x += vx * dt;
        this._rootDisp.z += vz * dt;
        if (grounded) {
          const k = Math.max(0, 1 - ROOT_RECENTER * dt);
          this._rootDisp.x *= k;
          this._rootDisp.z *= k;
        }
        const d = Math.hypot(this._rootDisp.x, this._rootDisp.z);
        if (d > ROOT_MAX_DISP) {
          this._rootDisp.x *= ROOT_MAX_DISP / d;
          this._rootDisp.z *= ROOT_MAX_DISP / d;
        }

        // 垂直:贴地用运动学(蹲下),腾空用速度积分(跳跃)
        if (grounded) {
          this._hipShift += (kinTarget - this._hipShift) * 0.85;
          this._airVy = 0;
        } else {
          this._airVy = this._airVy * ROOT_AIR_DAMP + vWorld.y * (1 - ROOT_AIR_DAMP);
          this._hipShift += this._airVy * dt;
        }
      } else {
        // 回退:旧序列没有 rootVel,保持「脚贴地」运动学(向后兼容)
        this._hipShift += (kinTarget - this._hipShift) * 0.85;
      }

      this.root.position.x = this.rootBasePos.x + this._rootDisp.x;
      this.root.position.z = this.rootBasePos.z + this._rootDisp.z;
      this.root.position.y = this.rootBasePos.y + this._hipShift;
      this.root.updateMatrixWorld(true);
    }

    // Orient the pelvis using the measured axis; do not double-rotate world-space limbs.
    // v2 骨盆偏航:参考序列帧带 torsoTwist 时,骨盆朝向 = 髋轴 rootYaw,胸椎扭转(肩轴 − 髋轴)
    // 抽出到脊柱曲线与头部,呈现 salsa 胸腔反向带动。旧/实时帧无 torsoTwist,回退旧策略:
    // 骨盆朝向 = 肩轴水平投影(肩点更稳、更少被衣物/下半身遮挡),缺肩轴时再回退 rootYaw。
    let bodyLatent = null;
    let torsoTwist = null;
    if (Number.isFinite(frame.torsoTwist) && (frame.rootYawConf ?? 1) >= minConf) {
      const rYaw = Number.isFinite(frame.rootYaw) ? frame.rootYaw : 0;
      bodyLatent = [Math.cos(rYaw), 0, Math.sin(rYaw)];
      torsoTwist = mirror ? -frame.torsoTwist : frame.torsoTwist;
    } else if (Array.isArray(frame.shoulderAxis) && frame.shoulderAxis.length >= 3) {
      const sa = frame.shoulderAxis;
      const h = Math.hypot(sa[0], sa[2]);
      if (h > 1e-6) {
        // 肩轴水平投影归一化 → 与 rootYaw 的 (cos,sin) 同构,但数据源更鲁棒
        bodyLatent = [sa[0] / h, 0, sa[2] / h];
        // 躯干侧倾(roll)= 肩轴相对水平面的夹角(rad)。本版仅记录,供后续 roll 增强消费。
        this._torsoRoll = Math.atan2(sa[1], h);
      } else if (Number.isFinite(frame.rootYaw)) {
        bodyLatent = [Math.cos(frame.rootYaw), 0, Math.sin(frame.rootYaw)];
      }
    } else if (Number.isFinite(frame.rootYaw)) {
      bodyLatent = [Math.cos(frame.rootYaw), 0, Math.sin(frame.rootYaw)];
    }
    if (bodyLatent && (frame.rootYawConf ?? 1) >= minConf) {
      const lateral = toWorld(bodyLatent).normalize();
      if (mirror) lateral.negate();
      this.bodyYaw.setFromUnitVectors(this.basis.right, lateral);
      const parent = this.hips.parent.getWorldQuaternion(new THREE.Quaternion());
      this.hips.quaternion.copy(parent.invert().multiply(this.bodyYaw).multiply(this.hipsRestQuat));
      this.hips.updateWorldMatrix(true, true);
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
        // 胸椎扭转:沿脊柱分布(下段≈0、胸/颈≈全量),骨盆已固定为 rootYaw。
        if (torsoTwist) this._twistWorld(s.bone, up, torsoTwist * s.f);
      }
    }

    // ---- 四肢(两骨 IK) ----
    const hipWorld = this.hips.getWorldPosition(new THREE.Vector3());
    // 身体前向/侧向(由 bodyYaw 旋转的躯干基),供髋/肩锥约束复用。
    const bodyF = this.basis.forward.clone().applyQuaternion(this.bodyYaw);
    const bodyR = this.basis.right.clone().applyQuaternion(this.bodyYaw);
    for (const limb of this.limbs) {
      if (limb.leg && !isFullBody) continue;
      const endName = mirror ? limb.endR : limb.endL;
      const end = joints[endName];
      if (!end) continue;
      let targetEnd = toWorld(end).add(hipWorld);
      const p0 = limb.upper.bone.getWorldPosition(new THREE.Vector3());
      const l1 = this.dims[limb.l1];
      const l2 = this.dims[limb.l2];
      const poleDir = limb.pole === "front" ? f : f.clone().negate();
      // The elbow/knee is the pole, rather than a fixed front/back bend direction.
      const midName = endName.replace("wrist", "elbow").replace("ankle", "knee");

      // 自身侧符号:模型侧(右 +1 / 左 −1),由骨骼名推导,镜像稳健。
      const sideSign = _norm(limb.upper.bone.name).includes("right") ? 1 : -1;

      // 髋/肩方向锥约束(根因:臂弯曲异常 / 腿轨迹异常 / 穿躯干):IK 前把「肩/髋→末端」
      // 方向钳到生理锥内,只改方向、长度守恒,不影响下蹲(膝屈曲)。
      //   腿部:先矢状(前后摆 clampLegDirection)后冠状(内外展 clampLegCoronal)。
      //   臂部:肩立体锥(后伸 + 内收 clampArmDirection),防上臂穿躯干/过度反折。
      const rel = targetEnd.clone().sub(p0);
      if (limb.leg) {
        const sag = clampLegDirection(rel, this.basis.up, bodyF, bodyR);
        targetEnd = p0.clone().add(clampLegCoronal(sag, this.basis.up, bodyF, bodyR, sideSign));
      } else {
        targetEnd = p0.clone().add(clampArmDirection(rel, this.basis.up, bodyF, bodyR, sideSign));
      }

      // S2 膝盖方向防护(根因4):肘/膝点缺失或低置信度时,回退固定 front/back poleDir,
      // 避免用不可靠的 mid 反推 pole 导致膝盖方向帧间翻转。
      const side = endName.startsWith("left") ? "l" : "r";
      const midBone = limb.leg ? `thigh_${side}` : `upper_arm_${side}`;
      const midConf = idx[midBone] != null ? (conf[idx[midBone]] ?? 1) : 1;
      const mid = midConf >= minConf ? joints[midName] : null;
      let pole = mid ? toWorld(mid).add(hipWorld) : p0.clone().add(poleDir);
      // 肘/膝 pole 时序距离钳(根因:弯曲过大/抽搐):在肩/髋局部坐标系下做(相对 p0 的偏移),
      // 避免全身位移(root 移动/下蹲)被误判成 pole 跳远。限速 + 死区:未超阈值零干预。
      if (limb._prevMid && limb._prevRoot) {
        const maxJump = limb.leg ? KNEE_POLE_MAX_JUMP : ELBOW_POLE_MAX_JUMP;
        const relPrev = limb._prevMid.clone().sub(limb._prevRoot); // 上帧肘/膝相对肩/髋偏移
        const relNow = pole.clone().sub(p0);                        // 本帧相对偏移
        const jump = relNow.distanceTo(relPrev);
        if (jump > maxJump) {
          const dir = relNow.clone().sub(relPrev).normalize();
          pole = p0.clone().add(relPrev).addScaledVector(dir, maxJump);
        }
      }

      const sol = solveTwoBone(p0, targetEnd, l1, l2, pole, {
        limits: limb.limits,
        hint: limb._prevMid || null,
        // S4 γ 时序平滑(根因5):限制折叠角帧间变化率,吃掉单帧尖峰、保留快速深屈。
        gammaHint: limb._prevGamma,
        gammaMaxStep: GAMMA_MAX_STEP,
      });
      limb._prevMid = sol.p1.clone();
      limb._prevRoot = p0.clone();
      limb._prevGamma = sol.gamma ?? limb._prevGamma;
      this._applyDir(limb.upper, sol.upperDir);
      this._applyDir(limb.lower, sol.lowerDir);
      // 记录本帧关节世界位置,供 IK 后的胶囊碰撞避免(_resolveCollisions)回写方向。
      limb._root = p0.clone();
      limb._mid = sol.p1.clone();
      limb._end = targetEnd.clone();
    }

    // ---- 头:躯干坐标系分解 yaw(转头)/pitch(点头) + 颈椎 ROM + bodyYaw 耦合 ----
    // 医学依据(颈椎 ROM):旋转各侧 60–80°、屈曲 45–50°、后伸 45°。头向量(鼻−肩中点)
    // 天然与躯干偏航/平移解耦(鼻始终在肩上方),故在「固定世界基」下分解出俯仰/偏航即可
    // 隔离「头随身体白转」的耦合;再与 bodyYaw 组合,使头自然跟随身体转向,并限幅到颈椎 ROM。
    if (this.headBone) {
      const hi = idx["head"];
      if (hi != null && bones[hi] && (conf[hi] ?? 1) >= minConf) {
        const hw = new THREE.Vector3(bones[hi][0], bones[hi][1], bones[hi][2]);
        if (hw.lengthSq() > 1e-10) {
          hw.normalize().applyMatrix3(m);
          if (!this._headNeutral) this._headNeutral = hw.clone();
          // 用未镜像的 basis 右/上轴分解:镜像已由 hw(m 矩阵)的 x 翻转体现,避免双重翻折。
          const { pitch, yaw } = decomposeHead(hw, this._headNeutral, this.basis.up, this.basis.right);
          const nc = clampNeck(pitch, yaw);
          const qNeck = neckQuaternion(nc.pitch, nc.yaw, this.basis.up, this.basis.right);
          // 组合:身体朝向(bodyYaw) × 颈旋(躯干局部) × 头休息姿态。headRestQuat 为模型休息世界四元数。
          const tq = this.bodyYaw.clone();
          // 胸椎扭转:头随胸腔全量扭转(否则头会相对肩「落后」一个扭转角)。颈旋 qNeck 在前序步骤
          // 里相对中性头方向解出,不包含体轴扭转,故这里在 bodyYaw 与 qNeck 之间显式补上扭转。
          if (torsoTwist) tq.multiply(new THREE.Quaternion().setFromAxisAngle(this.basis.up, torsoTwist));
          tq.multiply(qNeck).multiply(this.headRestQuat);
          const pw = this.headBone.parent && this.headBone.parent.isBone
            ? this.headBone.parent.getWorldQuaternion(new THREE.Quaternion())
            : new THREE.Quaternion();
          this.headBone.quaternion.slerp(pw.clone().invert().multiply(tq), this.smooth);
          this.headBone.updateWorldMatrix(true, false);
        }
      }
    }

    // ---- 脚:世界朝向 ≈ 休息(脚掌贴地) ----
    for (const ft of this.feet) {
      const pw = ft.bone.parent.getWorldQuaternion(new THREE.Quaternion());
      ft.bone.quaternion.copy(pw.invert().multiply(this.bodyYaw).multiply(ft.restWorldQuat));
      ft.bone.updateWorldMatrix(true, false);
    }

    // ---- 交叠穿模避免(IK 后轻量几何推开) ----
    this._resolveCollisions();
  }

  // 交叠穿模避免:把肢体抽象为胶囊,与躯干/头/对侧肢体做最小平移分离,再把位移写回上/下骨方向。
  // 仅当胶囊重叠时触发;共享「中」关节(肘/膝)用同一 Vector3 引用,推开后相邻段自动一致。
  _resolveCollisions() {
    const dims = this.dims;
    const torsoR = (dims.shoulderWidth || 0) * 0.32 || 0.10; // 躯干半厚(前后/侧向)
    const headR = (dims.headLen || 0) * 0.45 || 0.08;        // 头部球半径
    const armR = (dims.shoulderWidth || 0) * 0.11 || 0.035;  // 手臂胶囊半径
    const legR = (dims.hipWidth || 0) * 0.14 || 0.04;        // 腿部胶囊半径

    // 刷新整棵骨骼世界矩阵,保证关节世界位置是当前姿态。
    this.root.updateMatrixWorld(true);

    const hipsPos = this.hips.getWorldPosition(new THREE.Vector3());
    const chestBone = this.findBone(["Chest", "Spine2", "Neck"]);
    const chestPos = chestBone ? chestBone.getWorldPosition(new THREE.Vector3()) : hipsPos.clone();
    const headPos = this.headBone ? this.headBone.getWorldPosition(new THREE.Vector3()) : null;

    const capsules = [];
    // 躯干胶囊(固定)
    const torsoIdx = 0;
    capsules.push({ p0: hipsPos, p1: chestPos, r: torsoR, movable0: false, movable1: false });
    // 头部胶囊(退化为球,固定)
    let headIdx = -1;
    if (headPos) {
      headIdx = capsules.length;
      capsules.push({ p0: headPos, p1: headPos.clone(), r: headR, movable0: false, movable1: false });
    }

    // 每个本帧驱动的肢体两段:上段(根→中,根固定)、下段(中→末,两端可动)。共享「中」关节引用。
    const limbCaps = [];
    for (const limb of this.limbs) {
      if (!limb._mid || !limb._end || !limb._root) continue; // 本帧未驱动(如 gesture 模式跳过腿)
      const r = limb.leg ? legR : armR;
      const upper = { p0: limb._root, p1: limb._mid, r, movable0: false, movable1: true };
      const lower = { p0: limb._mid, p1: limb._end, r, movable0: true, movable1: true };
      limbCaps.push({ limb, upperIdx: capsules.length, lowerIdx: capsules.length + 1 });
      capsules.push(upper, lower);
    }

    const pairs = [];
    for (const lc of limbCaps) {
      pairs.push([lc.upperIdx, torsoIdx]); // 上臂/大腿 vs 躯干
      pairs.push([lc.lowerIdx, torsoIdx]); // 前臂/小腿 vs 躯干
      if (headIdx >= 0 && !lc.limb.leg) pairs.push([lc.lowerIdx, headIdx]); // 前臂(手) vs 头
    }
    // 两肢体(各含上/下两段)全对全胶囊互测
    const pairsOf = (A, B) => {
      for (const a of A) for (const b of B) {
        pairs.push([a.upperIdx, b.upperIdx]);
        pairs.push([a.lowerIdx, b.lowerIdx]);
        pairs.push([a.upperIdx, b.lowerIdx]);
        pairs.push([a.lowerIdx, b.upperIdx]);
      }
    };
    // 双腿互穿:对侧大腿/小腿两两检测(交叉步/并腿时防止穿插)。
    const legs = limbCaps.filter((lc) => lc.limb.leg);
    const arms = limbCaps.filter((lc) => !lc.limb.leg);
    for (let i = 0; i < legs.length; i++)
      for (let j = i + 1; j < legs.length; j++)
        pairsOf([legs[i]], [legs[j]]);
    // 手臂 vs 手臂:双手交叉/合十/抱拳等单帧回归常见的双腕交叠。
    for (let i = 0; i < arms.length; i++)
      for (let j = i + 1; j < arms.length; j++)
        pairsOf([arms[i]], [arms[j]]);
    // 手臂 vs 大腿:手臂下垂贴腿、摸膝、抱膝等手腿交叠。
    for (const a of arms) for (const l of legs) pairsOf([a], [l]);

    separateCapsulePairs(capsules, pairs, { iterations: 3, pushFactor: 0.6 });

    // 把(可能被推开)的中/末关节写回上/下骨方向。
    for (const lc of limbCaps) {
      const { limb } = lc;
      const upperDir = limb._mid.clone().sub(limb._root);
      const lowerDir = limb._end.clone().sub(limb._mid);
      if (upperDir.lengthSq() < 1e-12 || lowerDir.lengthSq() < 1e-12) continue;
      this._applyDir(limb.upper, upperDir.normalize());
      this._applyDir(limb.lower, lowerDir.normalize());
      limb._prevMid = limb._mid.clone(); // 更新 hint,保持帧间弯折方向连续
    }
  }

  // 回到休息姿态
  reset() {
    this.hips.quaternion.copy(this.hipsRestLocalQuat);
    this.bodyYaw.identity();
    this._torsoRoll = 0;
    for (const cap of this.spineDriven) cap.bone.quaternion.copy(cap.restLocalQuat);
    for (const limb of this.limbs) {
      limb.upper.bone.quaternion.copy(limb.upper.restLocalQuat);
      limb.lower.bone.quaternion.copy(limb.lower.restLocalQuat);
      limb._prevMid = null;
      limb._prevRoot = null;
      limb._prevGamma = null;
    }
    if (this.headBone) {
      this.headBone.quaternion.copy(this.headRestLocalQuat);
      this._headNeutral = null;
    }
    for (const ft of this.feet) ft.bone.quaternion.copy(ft.restLocalQuat);
    // 撤销我们施加的根位移(布局 x/z 由外部控制,这里只去掉水平漂移)
    this.root.position.x -= this._rootDisp.x;
    this.root.position.z -= this._rootDisp.z;
    this._rootDisp.set(0, 0, 0);
    this._hipShift = 0;
    this._airVy = 0;
    this._lastT = null;
    this.root.position.y = this.rootBasePos.y;
    this._rootBaseSynced = false; // 下次 applyFrame 重新对齐基准位(布局可能已变)
    this.root.updateMatrixWorld(true);
  }
}
