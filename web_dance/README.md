# web_dance/ — DANCE ARENA(three.js 网页版舞蹈系统)

把 `pose_capture/` 的舞蹈动捕管线(摄像头 → MediaPipe → 契约帧)搬进网页,
用 **Three.js** 驱动 **FBX / GLB 人形模型**,并套上一个**游戏化**的舞台界面。

> 与 `backend_process` / `frontend_dis` 完全无关,不依赖 Python。
> 直接复用 `pose_capture/` 的 `contract / mocap / export / playback / pose-engine`。

## 快速运行

```bash
# 在仓库根目录
python -m http.server 8000
# 浏览器打开 http://localhost:8000/web_dance/
```

- 必须走 http(localhost 即可),`file://` 打不开 ES module 且拿不到摄像头。
- 模型 / three.js / MediaPipe wasm 都从 CDN 加载,需要联网。

## 使用

1. 点「使用默认舞者」加载 three.js 官方示例(Michelle,Mixamo 骨架);或点「加载本地 FBX / GLB」
   用自己的模型(也支持 ReadyPlayerMe,把 `.glb` 文件或 URL 填进去即可)。
   (本地建议用 `.glb` / `.fbx`;`.gltf` 若含外部 bin/贴图,本地 objectURL 加载可能失败。)
2. **自由模式**:点「开始」,3D 舞者实时镜像你的动作。
3. **跟跳挑战**:点「跟跳挑战」→「开始」,舞台上会出现**两位舞者**——左侧是跳参考舞的
   3D 教练(由 `dance-sequence/v1` JSON 逐帧驱动),右侧是你(实时动捕);先 3-2-1-GO 倒计时,
   跟着教练跳,右下角实时计分(分数 / 连击 / 匹配度 / 评级)。底部「舞蹈」「歌曲」下拉可切换
   舞曲:内置「合成示例舞」+ 仓库根 `fbx/` 里的 Mixamo 动作(Hip Hop / Salsa,已转成挑战序列,
   短片段循环到 24s);也可「加载参考 JSON」(即 `pose_capture` 导出的文件)。
4. **舞者表演**:底部「动画」下拉可切换舞蹈。默认列出**内置舞曲**(仓库根 `fbx/` 目录里的
   Mixamo 动作,如 Hip Hop Dancing / Salsa Dancing),加上模型**内嵌的 FBX/GLB 动画**
   (默认 Michelle 自带桑巴舞 SambaDance)。内置舞曲做**世界空间重定向**(先按骨骼名匹配,
   再用源/目标骨架的休息姿态差对齐朝向,避免 Mixamo FBX 与 glTF 骨架的 90° 朝向错位),
   只保留旋转轨道(原地跳),短片段自动循环播放。想加新舞:把 FBX 丢进仓库根 `fbx/`,
   在 `dance-library.js` 的 `BUILTIN_DANCES` 里补一行。
5. 快捷键:`空格` 开始/停止,`M` 切换左右镜像。

## 目录结构

| 文件 | 职责 |
|---|---|
| `index.html` / `style.css` | 游戏化 UI 壳(霓虹舞台 + HUD) |
| `main.js` | 编排:场景、模式、动捕、评分、HUD、渲染循环 |
| `scene.js` | 三渲二舞池(灯光、地板、粒子、相机) |
| `avatar.js` | 加载 FBX/GLB、归一化身高、摆正位置 |
| `retarget.js` | 契约帧 → 骨架(脊柱方向对齐 + 四肢两骨 IK + 头偏差 + 根运动:水平位移/跳跃) |
| `ik.js` | 两骨 IK 求解器(位置级,带 pole 弯折方向约束) |
| `score.js` | 舞蹈挑战实时评分 |
| `demo-sequence.js` | 内置合成示例舞(开箱即玩) |
| `dance-library.js` | 内置舞曲库:加载 `fbx/` 里的 Mixamo 动作并重定向到当前骨架 |
| `challenge-library.js` | 挑战舞曲库:FBX 动作 → `dance-sequence/v1` 序列 + 歌曲列表 |

## 原理(把「契约帧」搬到 3D 骨架)

`pose_capture` 产出的契约帧只有**骨骼单位向量**(+ `conf`),不含绝对位置。`retarget.js`
先用 `reconstructJoints` 把单位向量重建成目标关节点(髋为原点),再套到任意人形骨架
(Mixamo / ReadyPlayerMe 命名):

1. 加载时测出模型的 `right/up/forward` 休息基(前方用脚趾方向校正)与各骨长度。
2. **四肢**用位置级**两骨 IK**(`ik.js`):末端(腕/踝)精确到位,肘/膝用 pole 朝正确方向弯折。
3. **脊柱**方向对齐,`setFromUnitVectors(restDir, targetDir)` 求增量四元数转回局部空间。
4. **头**用相对中性朝向的偏差;**根运动**水平位移由 `rootVel` 积分、垂直在贴地时用脚踝
   反推髋高(蹲下)、腾空时用速度积分(跳跃);脚掌做简单 foot-IK。

## 已知取舍 / 后续

- **四肢两骨 IK(位置级)**:腕/踝精确到位,肘/膝朝正确方向弯折;髋部横向(hip joint)
  因骨架无独立髋骨,有厘米级近似。手腕/脚踝的绕轴 roll 仍是最小扭转解。
- **根运动(方案 C)**:契约帧已带 `rootVel`(髋中点速度)+ `grounded`(贴地标志),
  `retarget.js` 积分出水平位移并还原跳跃;`grounded` 抑制积分漂移,评分仍只比 `bones`(平移不变)。
- **手势舞的手指**未做 retarget(身体会动,手指不逐节驱动);手势舞模式主要还原上半身。
- MediaPipe 跑在主线程(与 `pose_capture` 一致),可后续用 Vite 打包丢进 Web Worker。
- 朝向/镜像若有偏差,用底部控制条里的「镜像」/「朝向」按钮一键切换
  (对应 `main.js` 的 `state.mirror` / `state.flipFacing`)。

## 动效实验台(ui-lab/)

`ui-lab/` 是独立于主页面之外的「动效实验台」:复用主页面的三渲二舞池作背景,
把一次「命中判定」做成一份**多轨动效谱**(判定文字 / 冲击波环 / 定向火花 / 震屏 / hit-stop / 闪光 / 暗角 / 里程碑),
一个 **Juice 总控**(0=扁平,10=全开)+ 每轨倍率微调,调好后点「复制配方」把参数回填到 `main.js`。

- 打开 `http://localhost:8000/web_dance/ui-lab/`
- 按 `P` / `G` / `M` 触发 PERFECT / GREAT / MISS,空格开自动连打看连击热度与里程碑。
- 核心原语在 `tween.js`(统一 rAF 时钟 + 缓动/弹簧 + hit-stop)和 `juice.js`(震屏/闪光/暗角/冲击波/定向火花),
  这两份文件设计为可直接搬回主页面复用。
