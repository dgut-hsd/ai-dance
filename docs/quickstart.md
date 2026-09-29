# 本地启动与运行指南

> 适用项目:**DANCE ARENA**(`ai-dance-main`)——浏览器端 AI 舞蹈动捕 + 音乐游戏。
> 项目为**纯前端静态站点**,**没有需要安装的 npm 运行时依赖**;页面运行只需「静态文件服务器 + 现代浏览器」。
> 架构背景参见 [system-architecture.md](system-architecture.md)。

---

## 1. 前置环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| 浏览器 | Chrome / Edge 最新版 | 需支持 ES Module、WebGL(模型渲染)、`getUserMedia`(摄像头)、Web Audio API、WebAssembly |
| 静态服务器 | 任意一种(见 §3) | 推荐 Python 3 自带的 `http.server`,零依赖 |
| Node.js | **18+**(推荐 20 LTS) | **仅运行自动化测试时需要**;运行页面本身不需要 |
| 联网 | 需要 | three.js、MediaPipe wasm、默认舞者模型均从 CDN 加载 |

> **无需 `npm install`**。`package.json` 中没有任何 `dependencies` / `devDependencies`,
> 页面依赖全部通过 `<script type="importmap">` 与 `import()` 从 jsdelivr CDN 加载。

---

## 2. 项目依赖说明

本项目依赖分两类,**均无需本地安装**:

1. **运行时依赖(CDN,联网即用)**
   - three.js:`https://cdn.jsdelivr.net/npm/three@0.160.0/`(定义于 [web_dance/index.html](../web_dance/index.html) 的 importmap)
   - MediaPipe Tasks Vision:`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14`(定义于 [pose_capture/pose-engine.js](../pose_capture/pose-engine.js))
2. **模型文件(已就绪)**
   - `pose_capture/models/pose_landmarker_full.task`(全身,默认)
   - `pose_capture/models/pose_landmarker_lite.task`(低配 / 手势舞身体)
   - `pose_capture/models/hand_landmarker.task`(手势舞手部)
   - 缺失时按 [models/README.md](../pose_capture/models/README.md) 的地址下载补齐。

---

## 3. 启动本地开发服务器

在**仓库根目录**(`ai-dance-main/`)执行以下任一命令。

### 方式 A:Python(推荐,零依赖)

```bash
python -m http.server 8000
```

### 方式 B:Node.js(npx)

```bash
npx serve -l 8000
# 或
npx http-server -p 8000
```

### 方式 C:VS Code Live Server

安装 "Live Server" 插件后,右键 `web_dance/index.html` → **Open with Live Server**。

> 三者本质相同:提供一份 http 静态托管。**必须走 http(localhost),不能用 `file://`**
> 直接双击打开 —— ES Module 无法从 `file://` 加载,且摄像头需要安全上下文。

---

## 4. 访问入口

服务启动后,在浏览器打开:

| 页面 | 地址 | 用途 |
|---|---|---|
| 主游戏 | http://localhost:8000/web_dance/ | DANCE ARENA(自由模式 / 跟跳挑战 / 舞者表演) |
| 动捕验证页 | http://localhost:8000/pose_capture/ | 实时动捕 + 视频导出 JSON |
| 动效实验台 | http://localhost:8000/web_dance/ui-lab/ | 命中判定动效调试 |

---

## 5. 运行自动化测试(可选)

仅在有 Node.js 18+ 时执行:

```bash
npm test
# 等价于:node --test --test-isolation=none "test/*.test.js"
```

覆盖 `audio.js` 的音频引擎 / 谱面 / 节拍逻辑(`test/audio.test.js`、`test/audio-file.test.js`、`test/integration.test.js`)。

---

## 6. 常见问题与解决方案

### 6.1 双击 `index.html` 打开一片空白 / 控制台报 module 错误
- **原因**:ES Module 不允许从 `file://` 加载。
- **解决**:按 §3 用 `python -m http.server` 走 http 访问。

### 6.2 摄像头无法打开 / 被拒绝
- **原因**:`getUserMedia` 只在安全上下文(localhost 或 https)可用;浏览器未授权。
- **解决**:确认地址是 `http://localhost`(而非 `file://`);点击地址栏摄像头图标授权;检查系统级摄像头隐私设置。

### 6.3 加载模型报错 / 找不到 `.task`
- **原因**:`pose_capture/models/` 下缺少模型文件。
- **解决**:确认三个 `.task` 文件存在;缺失则按 [models/README.md](../pose_capture/models/README.md) 的官方地址下载,文件名保持一致。

### 6.4 首次加载慢 / MediaPipe wasm 下载失败
- **原因**:wasm 从 jsdelivr CDN 拉取,网络环境会影响速度。
- **解决**:将 `@mediapipe/tasks-vision@0.10.14` 的 `wasm/` 自托管到本地,并修改 [pose-engine.js](../pose_capture/pose-engine.js) 顶部 `TASKS_VISION` 常量指向本地路径。

### 6.5 GPU delegate 报错
- **原因**:设备/浏览器 WebGL 受限,GPU 不可用。
- **解决**:无需手动处理 —— [pose-engine.js](../pose_capture/pose-engine.js) 已内置 GP​​U→CPU 自动降级(控制台会打印 `GPU delegate 不可用,退回 CPU`),仅表现为帧率略降。

### 6.6 "使用默认舞者"卡住 / 不显示
- **原因**:默认舞者(Michelle)从 `threejs.org` CDN 下载,需联网。
- **解决**:确认网络可达;或改用「加载本地 FBX / GLB」上传自己的模型(支持 ReadyPlayerMe 的 `.glb`)。

### 6.7 手势舞手指不动
- **原因**:已知取舍 —— 手势舞只还原上半身,手指未逐节 retarget(见架构文档 §10)。
- **解决**:属预期行为,暂不处理。

### 6.8 主线程卡顿 / 掉帧
- **原因**:MediaPipe 跑在主线程,尚未迁 Web Worker(0.10.14 限制)。
- **解决**:关闭其他占 GPU 的页签;或后续用 Vite/esbuild 打包迁移到 Worker。

---

## 7. 一步到位速查

```bash
# 1) 仓库根目录
cd ai-dance-main

# 2) 起静态服务(二选一)
python -m http.server 8000        # Python
npx serve -l 8000                 # Node

# 3) 浏览器打开
start http://localhost:8000/web_dance/

# 4)(可选)跑测试
npm test
```

前置检查清单:
- [ ] 浏览器为 Chrome/Edge 最新版
- [ ] 能联网(CDN 依赖)
- [ ] `pose_capture/models/` 下已有三个 `.task` 文件
- [ ] 地址是 `http://localhost`(非 `file://`)
- [ ] 摄像头已授权