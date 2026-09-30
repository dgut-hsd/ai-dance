/**
 * debug-detect-tail.mjs — 复现并定位「序列在视频末尾前几秒断掉」。
 *
 * 已排除:seek/解码没问题(debug-tail-seek.mjs 显示 seek 到 40.667s 都精确到位)。
 * 所以断的是识别:需要看清末尾那段是 world=null、还是 engine.detect 抛错、还是采到又被丢掉。
 *
 * 做法:完整跑一遍 window.__render(带逐帧钩子),把每一帧的
 * t / actual / world / error / frames.length 记下来,最后打印末尾 40 帧。
 */
import { openHarness } from "./video-import-core.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const url = arg("url", "/videos/舞蹈2.mp4");
const fps = Number(arg("fps", 15));

const harness = await openHarness({ onLog: (m) => process.stderr.write(m + "\n") });
try {
  // 直接照抄 harness 里的循环,但把每一帧的实况记下来
  const out = await harness.page.evaluate(async ({ url, fps }) => {
    const mod = await import("/pose_capture/pose-engine.js");
    const contract = await import("/pose_capture/contract.js");
    const { PoseSmoother } = await import("/pose_capture/filters.js");

    const video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.preload = "auto";
    video.src = url;
    video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px";
    document.body.appendChild(video);
    await new Promise((res, rej) => {
      video.addEventListener("loadedmetadata", res, { once: true });
      video.addEventListener("error", () => rej(new Error("加载失败")), { once: true });
    });
    const duration = video.duration;

    const seekTo = (t) => new Promise((resolve) => {
      const target = Math.max(0, Math.min(t, Math.max(0, duration - 0.001)));
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); video.removeEventListener("seeked", onSeeked); requestAnimationFrame(() => requestAnimationFrame(() => resolve(video.currentTime))); };
      const onSeeked = () => finish();
      const timer = setTimeout(finish, 20000);
      video.addEventListener("seeked", onSeeked);
      video.currentTime = target;
    });

    const m = contract.resolveMode("full-body");
    const engine = await mod.createPoseEngine(m.poseModel, { withHands: m.hands, handModelPath: m.handModel });
    const smoother = new PoseSmoother({ minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 });
    try { const w = document.createElement("canvas"); w.width = 64; w.height = 64; await engine.detect(await createImageBitmap(w), 0); } catch {}

    const rows = [];
    let ts = 1, kept = 0, errors = 0;
    const total = Math.floor(duration * fps) + 1;
    for (let i = 0; i < total; i++) {
      const want = i / fps;
      if (want > duration) break;
      const actual = await seekTo(want);
      let row = { i, want: +want.toFixed(3), actual: +actual.toFixed(3), world: null, err: null, kept: 0 };
      try {
        const bitmap = await createImageBitmap(video);
        const { world, img } = await engine.detect(bitmap, ts++);
        row.world = Boolean(world);
        if (world) {
          const rawJoints = contract.landmarksToJoints(world);
          const depthFixed = contract.constrainLimbDepth(rawJoints, img);
          const vis = contract.visibilitiesFromLandmarks(img);
          smoother.smooth(depthFixed, vis, want);
          kept++;
        }
      } catch (e) { row.err = String(e && e.message || e); errors++; }
      row.kept = kept;
      if (i % 5 === 0) rows.push(row);
    }
    return { duration, total, kept, errors, lastKeptAt: rows.filter((r) => r.world).at(-1), rows: rows.slice(-30) };
  }, { url, fps });

  console.log(JSON.stringify({ url, duration: out.duration, total: out.total, kept: out.kept, errors: out.errors, lastKept: out.lastKeptAt }, null, 1));
  for (const r of out.rows) console.log(JSON.stringify(r));
} finally {
  await harness.close();
}
