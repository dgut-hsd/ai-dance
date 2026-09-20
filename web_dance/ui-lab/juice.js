/**
 * juice.js — 游戏手感层:震屏、闪光、暗角、冲击波环、定向火花、hit-stop。
 * 独立全屏 fx canvas,叠加在 UI 之上,不干扰 Three.js 相机。
 */
import { ticker } from "./tween.js";

export function createJuice({ canvas, shakeTarget }) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  const rings = [];  // 冲击波环
  const parts = [];  // 粒子:kind = 'ray'(火花射线) | 'dot'(碎屑)
  let flash = null;  // 全屏闪光
  let vig = 0;       // 暗角强度(衰减)
  let shakeAmp = 0;

  const cap = () => { if (parts.length > 800) parts.splice(0, parts.length - 800); };

  /** 冲击波:从 hit 点扩散的描边圆环(easeOutCubic 半径 + 淡出)。 */
  function ring(x, y, {
    size = 140, color = "57,255,207", width = 3, duration = 320, delay = 0, alpha = 1,
  } = {}) {
    rings.push({ x, y, size, color, width, duration, delay, life: -delay, alpha });
  }

  /** 定向火花:星形射线 + 碎屑(比均匀圆点更有"游戏"结构感)。 */
  function sparks(x, y, {
    count = 24, rays = 10, speed = 380, gravity = 700, ttl = 0.6,
    colors = ["57,255,207", "77,124,255", "255,213,74"],
  } = {}) {
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + (Math.random() * 0.24 - 0.12);
      const sp = speed * (0.9 + Math.random() * 0.5);
      parts.push({
        kind: "ray", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, ttl: 0.16 + Math.random() * 0.12, color: colors[(Math.random() * colors.length) | 0],
      });
    }
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.25 + Math.random() * 0.8);
      parts.push({
        kind: "dot", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - speed * 0.1,
        life: 0, ttl: ttl * (0.5 + Math.random() * 0.6), g: gravity,
        color: colors[(Math.random() * colors.length) | 0], size: 2 + Math.random() * 2.6,
      });
    }
    cap();
  }

  /** 均匀爆点(用于里程碑 confetti 等)。 */
  function burst(x, y, {
    count = 48, speed = 300, gravity = 900, ttl = 0.9,
    colors = ["255,61,129", "77,124,255", "57,255,207", "255,213,74"], size = 4,
  } = {}) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.35 + Math.random() * 0.85);
      parts.push({
        kind: "dot", x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - speed * 0.15,
        life: 0, ttl: ttl * (0.6 + Math.random() * 0.6), g: gravity,
        color: colors[(Math.random() * colors.length) | 0], size: size * (0.6 + Math.random() * 0.8),
      });
    }
    cap();
  }

  function shake(amount = 8) { shakeAmp = Math.max(shakeAmp, amount); }
  function flashScreen(color = "255,255,255", alpha = 0.5, ttl = 0.18) { flash = { color, alpha, life: 0, ttl }; }
  function vignette(strength = 0.3) { vig = Math.max(vig, strength); }
  function hitStop(ms = 80) { ticker.hitStop(ms); }

  ticker.add({
    update(_now, dt) {
      shakeAmp = Math.max(0, shakeAmp - dt * 55);
      vig = Math.max(0, vig - dt * 1.4);
      let sx = 0, sy = 0;
      if (shakeAmp > 0) {
        sx = (Math.random() * 2 - 1) * shakeAmp;
        sy = (Math.random() * 2 - 1) * shakeAmp;
      }
      if (shakeTarget) shakeTarget.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;

      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      // 暗角
      if (vig > 0.01) {
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const g = ctx.createRadialGradient(
          cx, cy, Math.min(window.innerWidth, window.innerHeight) * 0.28,
          cx, cy, Math.max(window.innerWidth, window.innerHeight) * 0.72
        );
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, `rgba(0,0,0,${Math.min(0.7, vig)})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      }

      // 冲击波环
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        r.life += dt;
        if (r.life >= r.duration) { rings.splice(i, 1); continue; }
        if (r.life < 0) continue;
        const t = r.life / r.duration;
        const rad = r.size * (0.08 + 0.92 * (1 - Math.pow(1 - t, 3)));
        ctx.globalAlpha = r.alpha * (1 - t);
        ctx.strokeStyle = `rgb(${r.color})`;
        ctx.lineWidth = r.width * (1 - t * 0.5);
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 粒子
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.life += dt;
        if (p.life >= p.ttl) { parts.splice(i, 1); continue; }
        const k = 1 - p.life / p.ttl;
        if (p.kind === "ray") {
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          ctx.globalAlpha = k;
          ctx.strokeStyle = `rgb(${p.color})`;
          ctx.lineWidth = 2 * k + 0.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
          ctx.stroke();
        } else {
          p.vy += (p.g || 0) * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          ctx.globalAlpha = k;
          ctx.fillStyle = `rgb(${p.color})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * k, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 闪光
      if (flash) {
        flash.life += dt;
        if (flash.life >= flash.ttl) {
          flash = null;
        } else {
          const k = 1 - flash.life / flash.ttl;
          ctx.globalAlpha = flash.alpha * k;
          ctx.fillStyle = `rgb(${flash.color})`;
          ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
        }
      }
      ctx.globalAlpha = 1;
      return true;
    },
  });

  return { ring, sparks, burst, shake, flash: flashScreen, vignette, hitStop };
}
