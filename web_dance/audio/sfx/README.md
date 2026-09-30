# 打击音素材(web_dance/audio/sfx/)

这里的 wav 不是手工做的,是从 **CC0(公共领域)** 素材库里挑出来、裁切、转码、电平平衡后的结果。
选材依据是实测数据,不是听文件名好看 —— 详见 `tools/analyze-sfx-samples.mjs` 与
`tools/build-sfx-samples.mjs` 里的注释。

## 来源与许可

| 素材包 | 来源页面 | 许可 |
|---|---|---|
| Kenney Interface Sounds | https://kenney.nl/assets/interface-sounds | **CC0 1.0** |
| Kenney Impact Sounds | https://kenney.nl/assets/impact-sounds | **CC0 1.0** |

CC0 1.0 意为作者放弃全部著作权:可商用、可修改、**无需署名**。
我们仍然保留来源说明,并把它一并放进仓库 —— 以后有人问"这些音频哪来的、
能不能商用",答案就在这个目录里,不用再查网。抓取时间与原始下载地址见
`LICENSE-interface.txt` / `LICENSE-impact.txt`。

## 四档是怎么配的

选材依据来自 `tools/analyze-sfx-samples.mjs` 的实测(起音时间 / 时长 / 低频占比 / 尾部能量):

| 档位 | 素材 | 为什么选它(实测) |
|---|---|---|
| PERFECT | `impactPlate_heavy_*` | 余韵最长(0.46s 时仍有 1.3% 能量)、金属感 |
| GREAT | `impactWood_light_*` | 起音 0.77~1.1ms 极快、时长 55~57ms 干脆、木头体感 |
| GOOD | `impactGeneric_light_*` | 存在感明显弱于 GREAT |
| MISS | `impactSoft_medium_*` | 低频占比 0.84~0.88(最闷) |

每档 5 个同类变体 → 运行时轮换,避免连打变成"机关枪"。

## 电平是怎么定的(三个旋钮,分工不能混)

| 位置 | 管什么 |
|---|---|
| `hitsound.js` 的 `MASTER_GAIN` | **整体**电平 |
| `hitsound.js` 的 `TIER_RMS_CAL` | **档位之间**的平衡(把四档都拉回合成层的参考响度) |
| `index.json` 的 `variantGain` | **同档内** 5 个变体彼此的平衡 |

曾经把 `MASTER_GAIN` 和 `TIER_RMS_CAL` 一起往上调,结果整体过响 2 倍 —— 这三个数
是三个独立的旋钮,必须分开调。最终取值由 `tools/sfx-tune-levels.mjs` **闭环迭代**出来:
它渲染运行时的真实输出、量每档每变体的 RMS、反推增益再写回清单,反复几轮。

为什么要闭环而不是一次算准:总线里的 tanh 软限幅是**非线性**的,越响的样本被压得越多,
所以"按 RMS 线性归一"不可能一次到位(实测一次归一后同档内仍残留 9~25% 极差)。
实测收敛结果:四档相对合成层 0.99~1.12×,同档内极差 ≤8%(余下的波动来自有意的
±2% 音高抖动)。

**削波验证**:四档 × 三首真实歌曲(含真实谱面音符时刻)共 12 个组合,全部零削波,
最坏合成峰值 0.9744(音乐本身峰值最高 0.907)。

## 重新生成

```bash
node tools/fetch-sfx-samples.mjs      # 下载 CC0 原始素材到 tmp/sfx-src/
node tools/analyze-sfx-samples.mjs    # 转码 + 测量,输出候选排序
node tools/build-sfx-samples.mjs      # 挑选 + 裁切 + 电平平衡 → 本目录
node tools/sfx-tune-levels.mjs        # 闭环标定,把最终系数写回 index.json
```

依赖 `ffmpeg-static`(已在 package.json 的依赖里,无需额外安装)。

- **48kHz / 单声道 / 16bit PCM WAV**。
  WAV 是硬要求:osu! 的规范明确 hitsound 只用 wav(mp3 有 0~20ms 解码/循环间隙),
  而且 WAV 的 `decodeAudioData` 起音最干脆。
  单声道省一半体积;立体声宽度交给混响层做,素材本身不需要。
- **裁掉头部静音**。素材自带 0~2ms 静音,不裁就等于白送延迟;
  成品实测起音 0.21~0.85ms。
- **两端 3ms 淡入淡出**。裁切后不淡出会在样本末端产生"咔"的爆音。
- **不逐个归一化峰值**。档位之间的响度差是设计的一部分(打得越好越响),
  逐个拉到 1.0 会把区分度抹平。电平平衡统一在 `index.json` 的 `gain`
  与 `hitsound.js` 的 `TIER_RMS_CAL` 里做。

## 重新生成

```bash
node tools/fetch-sfx-samples.mjs      # 下载 CC0 原始素材到 tmp/sfx-src/
node tools/analyze-sfx-samples.mjs    # 转码 + 测量,输出候选排序
node tools/build-sfx-samples.mjs      # 挑选 + 裁切 + 电平平衡 → 本目录
```

依赖 `ffmpeg-static`(已在 package.json 的依赖里,无需额外安装)。

## 其余音效

里程碑(每 10 连)、开场/结算音效仍是**程序合成**(`web_dance/sfx.js`)——
采样库里没有合适的琶音/riser 素材,而这类音效对音色真实度不敏感。
