"""smooth.py — One-Euro 时序平滑(纯 numpy),对齐 pose_capture/filters.js 语义。

对每帧 3D 关节点按时间做因果 One-Euro 滤波,压低单目/模型逐帧深度抖动。
默认参数与 PoseSmoother({minCutoff:1.5, beta:0.5, dCutoff:1.0}) 对齐;
可选择更平滑(dCutoff 调小、beta 调大)以进一步安定膝盖深度。
"""

import numpy as np


class OneEuro:
    """单变量(可向量)因果 One-Euro 滤波。x 形如 (3,) 或标量。"""

    def __init__(self, min_cutoff=1.5, beta=0.5, d_cutoff=1.0):
        self.min_cutoff = float(min_cutoff)
        self.beta = float(beta)
        self.d_cutoff = float(d_cutoff)
        self.x_prev = None
        self.dx_prev = None
        self.t_prev = None

    @staticmethod
    def _alpha(cutoff, dt):
        tau = 1.0 / (2.0 * np.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, x, t):
        x = np.asarray(x, dtype=np.float64)
        if self.x_prev is None:
            self.x_prev = x.copy()
            self.dx_prev = np.zeros_like(x)
            self.t_prev = t
            return x.copy()
        dt = max(float(t) - float(self.t_prev), 1e-6)
        dx = (x - self.x_prev) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        dx_hat = a_d * dx + (1.0 - a_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * np.abs(dx_hat)
        a = self._alpha(cutoff, dt)
        x_hat = a * x + (1.0 - a) * self.x_prev
        self.x_prev = x_hat.copy()
        self.dx_prev = dx_hat.copy()
        self.t_prev = t
        return x_hat


def smooth_joint_sequence(frames_joints, ts, min_cutoff=1.5, beta=0.5, d_cutoff=1.0):
    """对「关节点 dict 序列」做逐关节点时序平滑。

    frames_joints: list[dict(name -> (3,))]（相机系或 canonical 系均可，仅随时间平滑）
    ts: list[float] 各帧时间戳（升序）
    返回平滑后的 list[dict]。首帧原样（无历史）。
    """
    names = list(frames_joints[0].keys())
    filters = {n: OneEuro(min_cutoff, beta, d_cutoff) for n in names}
    out = []
    for joints, t in zip(frames_joints, ts):
        smoothed = {
            n: filters[n](np.asarray(joints[n], dtype=np.float64), t)
            for n in names
        }
        out.append(smoothed)
    return out