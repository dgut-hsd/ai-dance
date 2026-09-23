"""时机判定：离散档位（音游式分段函数）或连续指数衰减。

游戏/表演模式缺省用离散 4 档宽松值：
    Perfect |Δt|≤0.05 → 1.00
    Great   |Δt|≤0.12 → 0.80
    Good    |Δt|≤0.20 → 0.60
    Miss    |Δt|≤0.25 → 0.00   （窗口边缘兜底）
教学/诊断模式可切 exp 连续曲线（更细粒度反馈）。

档位边界与判定窗口（window）是两回事：
- window 框定"给不给你算分"（窗口外最佳帧 → 整事件 Miss）；
- 档位只规定窗口内时机贡献怎么取值。
"""

import math
from dataclasses import dataclass

MISS_NAME = "Miss"


@dataclass(frozen=True)
class TimingConfig:
    fn: str = "discrete"  # "discrete" | "exponential"
    bands: tuple = ((0.05, "Perfect", 1.00),
                    (0.12, "Great", 0.80),
                    (0.20, "Good", 0.60))
    window: float = 0.25
    timing_scale: float = 0.20  # fn == "exponential" 时的 ατ


DEFAULT_TIMING = TimingConfig()


def grade_of(dt, config=DEFAULT_TIMING):
    """|Δt| → (档位名, 时机值)。

    |Δt| 超出窗口返回 (None, 0.0)，表示该事件不参与计时计分。
    dt 传 None / NaN 时按未计时处理。
    """
    if dt is None:
        return None, 0.0
    adt = abs(float(dt))
    if not math.isfinite(adt) or adt > config.window:
        return None, 0.0
    if config.fn == "exponential":
        return "continuous", math.exp(-adt / config.timing_scale)
    for edge, name, val in config.bands:
        if adt <= edge:
            return name, float(val)
    return MISS_NAME, 0.0