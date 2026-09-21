/**
 * stage.js — 舞台实验入口:创建舞台、渲染循环、控制开关接线。
 */
import * as THREE from "three";
import { createStage } from "./stage-scene.js";

const stage = createStage(document.getElementById("stage"));
const clock = new THREE.Clock();

function loop() {
  requestAnimationFrame(loop);
  stage.update(clock.getDelta());
  stage.render();
}
loop();

document.getElementById("tgl-bloom").addEventListener("change", (e) => stage.setBloom(e.target.checked));
document.getElementById("tgl-env").addEventListener("change", (e) => stage.setEnv(e.target.checked));
document.getElementById("tgl-mannequin").addEventListener("change", (e) => stage.setMannequin(e.target.checked));
