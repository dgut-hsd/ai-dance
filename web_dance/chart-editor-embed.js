// chart-editor-embed.js — 把谱面编辑器作为内嵌组件挂载进工作台(去掉 iframe 边界)。
// 复用 chart-editor.js 的 mountChartEditor;这里只负责注入 scoped 样式 + 结构。
//
// 与独立页 chart-editor.html 的区别:
//  - 所有选择器加 .chart-embed 前缀,且把会与 studio 冲突的 .left/.right/.props 改名为
//    .ce-left/.ce-right/.ce-props(JS 只按 id 取元素,改 class 不影响逻辑);
//  - 省略「舞曲文件夹 / 曲子」两个选择器(草稿模式本就隐藏它们)。

const CSS = `
.chart-embed { --bg:#0c0e14; --panel:#151927; --line:#2a3150; --text:#dfe5ff;
  --dim:#7d87ab; --accent:#4cc2ff; --warn:#ffb347; --good:#6fe3a1; --sel:#ff5c8a;
  box-sizing:border-box; margin:0; background:var(--bg); color:var(--text);
  font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;
  height:100%; overflow:hidden; display:flex; flex-direction:column; }
.chart-embed * { box-sizing:border-box; }
.chart-embed .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  padding:10px 14px; background:var(--panel); border-bottom:1px solid var(--line); flex:none; }
.chart-embed .toolbar label { display:inline-flex; align-items:center; gap:4px; color:var(--dim); }
.chart-embed .toolbar .spacer { flex:1; }
.chart-embed .sp { width:6px; height:20px; border-left:1px solid var(--line); margin:0 4px; }
.chart-embed select, .chart-embed input[type=number], .chart-embed input[type=text], .chart-embed button {
  background:#0f1322; color:var(--text); border:1px solid var(--line);
  border-radius:6px; padding:4px 8px; font:inherit; }
.chart-embed button { cursor:pointer; }
.chart-embed button:hover { border-color:var(--accent); }
.chart-embed button.primary { background:#14506b; border-color:#1d75a0; }
.chart-embed button.bpm-cands { margin-left:2px; }
.chart-embed main { display:grid; grid-template-columns:240px 1fr; gap:12px; padding:12px;
  flex:1; min-height:0; overflow:hidden; }
.chart-embed .ce-left { display:flex; flex-direction:column; gap:8px; overflow:auto; min-height:0; }
.chart-embed .posebox { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px; }
.chart-embed .posebox canvas { display:block; width:100%; image-rendering:pixelated; }
.chart-embed #pose, .chart-embed #notePose { background:#10141f26; }
.chart-embed .ce-props { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px; }
.chart-embed .ce-props h3 { margin:0 0 6px; font-size:12px; color:var(--dim); font-weight:600; }
.chart-embed .ce-props .grid { display:grid; grid-template-columns:auto 1fr; gap:5px 8px; align-items:center; }
.chart-embed .ce-props .bones { display:flex; flex-wrap:wrap; gap:4px; padding-top:6px; }
.chart-embed .ce-props .bonechips button { padding:2px 6px; font-size:11px; }
.chart-embed .ce-props .bonechips button.on { background:#14506b; border-color:var(--accent); }
.chart-embed ul#noteList { list-style:none; margin:0; padding:0; max-height:260px; overflow:auto;
  background:var(--panel); border:1px solid var(--line); border-radius:8px; }
.chart-embed ul#noteList li { display:flex; gap:6px; align-items:center; padding:4px 8px;
  border-bottom:1px solid #202741; cursor:pointer; }
.chart-embed ul#noteList li.sel { background:#1a2240; }
.chart-embed ul#noteList li b { color:var(--accent); min-width:52px; font-weight:600; }
.chart-embed ul#noteList li .tag { font-size:11px; color:var(--dim); }
.chart-embed ul#noteList li .del { margin-left:auto; color:var(--sel); background:none; border:none; cursor:pointer; }
.chart-embed .ce-right { display:flex; flex-direction:column; gap:8px; min-width:0; min-height:0; }
.chart-embed #legend { display:flex; gap:14px; color:var(--dim); font-size:11px; flex:none; }
.chart-embed #timelineWrap { position:relative; overflow:hidden; background:var(--panel);
  border:1px solid var(--line); border-radius:8px; height:auto; min-height:0; }
.chart-embed #timelineScroll { overflow-x:auto; overflow-y:hidden; padding:8px; }
.chart-embed #playhead { position:absolute; left:72px; top:8px; width:2px;
  background:#6fe3a1; box-shadow:0 0 8px #6fe3a199; z-index:3; pointer-events:none; }
.chart-embed #playheadKnob { position:absolute; left:-4px; top:0; width:0; height:0;
  border-left:5px solid transparent; border-right:5px solid transparent; border-top:7px solid #6fe3a1; }
.chart-embed #timeline { display:block; }
.chart-embed #waveform { display:block; margin-top:6px; background:#10141f26; border-radius:6px; }
.chart-embed .dot { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:4px; vertical-align:-1px; }
.chart-embed .status { color:var(--good); }
.chart-embed .err { color:#ff6b6b; font-weight:600; }
.chart-embed.no-seq .needs-seq { display:none; }
.chart-embed.no-seq main { display:none; }
.chart-embed #lanePreviewWrap { flex:none; }
.chart-embed #lanePreviewWrap > h3 { margin:0 0 6px; font-size:12px; color:var(--dim); font-weight:600; }
.chart-embed #lanePreviewBox { background:#10141f66; border:1px solid var(--line); border-radius:8px; padding:10px 12px 12px; }
`;

const HTML = `
<header class="toolbar">
  <span class="err" id="err" style="display:none"></span>
  <label class="needs-seq">目录名(ID) <input type="text" id="danceId" maxlength="64" spellcheck="false" placeholder="songs/ 下的目录名" style="width:150px"></label>
  <span class="sp needs-seq"></span>
  <label class="needs-seq">BPM <input type="number" id="bpm" step="1" min="20" max="300" style="width:64px"></label>
  <button class="needs-seq" id="btnDetectBpm" title="从当前音频自动测 BPM，列出候选供挑选">测定</button>
  <label class="needs-seq">偏移s <input type="number" id="offset" step="0.01" style="width:72px"></label>
  <label class="needs-seq">LPB <input type="number" id="lpb" step="1" min="1" max="32" value="4" style="width:52px" title="Lines Per Beat：每拍划分的网格数，决定音符可多精细地定位在节拍之间"></label>
  <label class="needs-seq"><input type="checkbox" id="snap" checked> 吸附节拍</label>
  <label class="needs-seq" title="播放时经过判定点发出提示音，方便对音"><input type="checkbox" id="clickSound" checked> 判定点音效</label>
  <span class="sp needs-seq"></span>
  <button class="needs-seq" id="btnFill1">每拍</button>
  <button class="needs-seq" id="btnFill2">每2拍</button>
  <button class="needs-seq" id="btnFill4">每4拍</button>
  <button class="needs-seq" id="btnClear">清空</button>
  <button class="needs-seq primary" id="btnPlay">播放 ▶</button>
  <button class="needs-seq" id="btnReset">放弃草稿</button>
  <button class="needs-seq" id="btnFit">适应窗口</button>
  <label class="needs-seq">缩放 <input type="range" id="zoom" min="2" max="300" step="1" value="210" style="width:110px"></label>
  <span class="needs-seq spacer"></span>
  <button class="needs-seq primary" id="btnSave">保存到歌单</button>
</header>
<main>
  <section class="ce-left">
    <div class="posebox">
      <canvas id="pose" width="220" height="286"></canvas>
      <div class="status" id="info">未载入</div>
    </div>
    <div class="ce-props" id="props">
      <h3>未选中音符</h3>
    </div>
    <h3 style="margin:2px 2px 0;color:var(--dim);font-size:12px">判定点簿</h3>
    <ul id="noteList"></ul>
  </section>
  <section class="ce-right">
    <div id="legend">
      <span><i class="dot" style="background:var(--accent)"></i>pose 判定点</span>
      <span><i class="dot" style="background:#ff5c8a"></i>选中</span>
      <span>弱拍 / 强拍 / 播放头</span>
    </div>
    <div id="timelineWrap">
      <div id="playhead"><div id="playheadKnob"></div></div>
      <div id="timelineScroll">
        <canvas id="timeline"></canvas>
        <canvas id="waveform"></canvas>
      </div>
    </div>
    <div id="lanePreviewWrap">
      <h3>判定轨道预览 · 玩家右下角看到的就是这张卡片(所见即所得)</h3>
      <div id="lanePreviewBox">
        <div id="pose-hint" class="lane-embed">
          <div id="judge-lane">
            <div id="judge-stage"></div>
            <div id="judge-track"></div>
          </div>
        </div>
      </div>
    </div>
  </section>
</main>
`;

export async function mountChartEditorEmbed(container, { draftId = null, onSaved = null } = {}) {
  container.classList.add("chart-embed", "no-seq");
  container.innerHTML = "";
  const style = document.createElement("style");
  style.textContent = CSS;
  container.appendChild(style);
  container.insertAdjacentHTML("beforeend", HTML);
  // 先注入结构,再 import:chart-editor.js 的模块顶层会绑定各按钮事件(靠 id 找元素)
  // 版本号必须带:static 挂载没发 Cache-Control,浏览器会走启发式缓存(文件年龄的 10%),
  // 改完 chart-editor.js 不动这个 ?v= 就会继续跑旧代码(内嵌模式尤其容易踩)。
  const { mountChartEditor } = await import("./chart-editor.js?v=20260930d");
  await mountChartEditor(container, { draftId, onSaved });
  return container;
}
