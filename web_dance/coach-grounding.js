import * as THREE from "three";

// 教练动作算完以后，用蒙皮后的鞋底顶点做单向贴地校正。
// 只抬起穿入舞台的角色，不压低正常抬脚或跳跃的姿态。
export function createCoachGrounding(root, floorY = 0.01) {
  const soles = [];
  root.traverse((mesh) => {
    if (!mesh.isSkinnedMesh || !mesh.skeleton) return;
    const skinIndex = mesh.geometry.getAttribute("skinIndex");
    const skinWeight = mesh.geometry.getAttribute("skinWeight");
    if (!skinIndex || !skinWeight) return;

    const footBones = new Set();
    mesh.skeleton.bones.forEach((bone, index) => {
      if (/(?:left|right)(?:foot|toe)/i.test(bone.name)) footBones.add(index);
    });
    if (!footBones.size) return;

    const indices = [];
    for (let vertex = 0; vertex < skinIndex.count; vertex++) {
      let weight = 0;
      for (let slot = 0; slot < 4; slot++) {
        if (footBones.has(skinIndex.getComponent(vertex, slot))) {
          weight += skinWeight.getComponent(vertex, slot);
        }
      }
      if (weight > 0.1) indices.push(vertex);
    }
    if (indices.length) soles.push({ mesh, indices });
  });

  const vertex = new THREE.Vector3();
  return function keepShoesAboveStage() {
    if (!soles.length) return 0;
    root.updateMatrixWorld(true);
    let lowest = Infinity;
    for (const { mesh, indices } of soles) {
      for (const index of indices) {
        mesh.getVertexPosition(index, vertex);
        vertex.applyMatrix4(mesh.matrixWorld);
        if (vertex.y < lowest) lowest = vertex.y;
      }
    }
    if (lowest >= floorY) return 0;
    const lift = floorY - lowest;
    root.position.y += lift;
    root.updateMatrixWorld(true);
    return lift;
  };
}
