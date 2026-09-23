import { BONE_COUNT, BONE_DEFS } from "./schema.js";
const EPS = 0.01;
function validateFrame(frame) {
  const issues = [];
  if (typeof frame !== "object" || frame === null) {
    return [{ path: "$", message: "frame is not an object" }];
  }
  if (typeof frame.t !== "number" || !Number.isFinite(frame.t)) {
    issues.push({ path: "t", message: "t must be a finite number (seconds)" });
  }
  const bones = frame.bones;
  if (!Array.isArray(bones)) {
    issues.push({ path: "bones", message: "bones must be an array" });
    return issues;
  }
  if (bones.length !== BONE_COUNT) {
    issues.push({ path: "bones", message: `expected ${BONE_COUNT} bones, got ${bones.length}` });
  }
  bones.forEach((bone, i) => {
    const p = `bones[${i}]`;
    if (!Array.isArray(bone) || bone.length !== 3) {
      issues.push({ path: p, message: "each bone must be [x, y, z]" });
      return;
    }
    const [x, y, z] = bone;
    if (![x, y, z].every((v) => typeof v === "number" && Number.isFinite(v))) {
      issues.push({ path: p, message: "coordinates must be finite numbers" });
      return;
    }
    const len = Math.hypot(x, y, z);
    const isZero = len < EPS;
    if (!isZero && Math.abs(len - 1) > 0.01) {
      issues.push({ path: p, message: `bone not unit length (|v|=${len.toFixed(4)})` });
    }
    if (isZero && (frame.conf ? frame.conf[i] !== 0 : false)) {
      issues.push({ path: p, message: "zero bone requires conf[i]=0" });
    }
  });
  const conf = frame.conf;
  if (conf !== void 0) {
    if (!Array.isArray(conf) || conf.length !== BONE_COUNT) {
      issues.push({ path: "conf", message: `conf must have length ${BONE_COUNT}` });
    } else {
      conf.forEach((c, i) => {
        if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) {
          issues.push({ path: `conf[${i}]`, message: "conf must be in [0, 1]" });
        }
      });
    }
  }
  if (frame.rootYaw !== void 0 && (typeof frame.rootYaw !== "number" || !Number.isFinite(frame.rootYaw))) {
    issues.push({ path: "rootYaw", message: "rootYaw must be a finite number (radians)" });
  }
  return issues;
}
function assertValidFrame(frame) {
  const issues = validateFrame(frame);
  if (issues.length > 0) {
    const lines = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`invalid SkeletonFrame \u2014 ${lines}`);
  }
}
function resolveConf(frame) {
  const conf = frame.conf;
  if (conf === void 0) return new Array(BONE_COUNT).fill(1);
  assertValidFrame(frame);
  return conf;
}
function validateSequence(seq) {
  const issues = [];
  if (seq === null || typeof seq !== "object") {
    return [{ path: "$", message: "sequence is not an object" }];
  }
  if (seq.schema !== "dance-sequence/v1") {
    issues.push({ path: "schema", message: `expected dance-sequence/v1, got ${String(seq.schema)}` });
  }
  if (!Array.isArray(seq.bones) || seq.bones.length !== BONE_COUNT) {
    issues.push({
      path: "bones",
      message: `expected ${BONE_COUNT} bone definitions, got ${Array.isArray(seq.bones) ? seq.bones.length : 0}`
    });
  } else {
    BONE_DEFS.forEach((def, i) => {
      const bone = seq.bones[i];
      if (bone === void 0 || bone.name !== def.name) {
        issues.push({ path: `bones[${i}]`, message: `expected bone ${def.name}, got ${bone ? bone.name : "undefined"}` });
      }
    });
  }
  if (seq.meta !== void 0 && typeof seq.meta.boneCount === "number" && seq.meta.boneCount !== BONE_COUNT) {
    issues.push({ path: "meta.boneCount", message: `expected ${BONE_COUNT}, got ${seq.meta.boneCount}` });
  }
  if (Array.isArray(seq.frames)) {
    seq.frames.forEach((frame, i) => {
      for (const issue of validateFrame(frame)) {
        issues.push({ path: `frames[${i}].${issue.path}`, message: issue.message });
      }
    });
  } else {
    issues.push({ path: "frames", message: "frames must be an array" });
  }
  return issues;
}
function assertValidSequence(seq) {
  const issues = validateSequence(seq);
  if (issues.length > 0) {
    const shown = issues.slice(0, 10).map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new Error(`invalid dance-sequence \u2014 ${shown}${issues.length > 10 ? ` (+${issues.length - 10} more)` : ""}`);
  }
}
export {
  assertValidFrame,
  assertValidSequence,
  resolveConf,
  validateFrame,
  validateSequence
};
