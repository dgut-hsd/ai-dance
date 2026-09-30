const id = location.pathname.split('/').pop();
const status = document.getElementById('view-status');
const video = document.getElementById('highlight-video');
const download = document.getElementById('download-highlight');
const downloadFull = document.getElementById('download-full');
const fullStatus = document.getElementById('full-status');
const retry = document.getElementById('refresh-highlight');
const story = document.getElementById('view-story');
let timer, refreshes = 0;
async function update() {
  clearTimeout(timer); retry.hidden = true;
  try {
    if (!/^[\w-]{32}$/.test(id)) throw new Error('领取链接不正确');
    const response = await fetch(`/api/highlights/${id}`, { signal: AbortSignal.timeout(15000) });
    const info = await response.json();
    if (!response.ok) {
      video.hidden = true; video.pause(); video.removeAttribute('src'); video.load(); download.hidden = true;
      status.textContent = info.error || '视频不可用'; return;
    }
    document.getElementById('view-expiry').textContent = `保留至 ${new Date(info.expiresAt).toLocaleString('zh-CN')}，请及时下载。`;
    if (info.status === 'ready') {
      status.textContent = '你的高光已就绪'; video.hidden = false;
      if (!video.getAttribute('src')) { video.src = info.videoUrl; video.poster = info.posterUrl; }
      download.href = `${info.videoUrl}?download=1`; download.hidden = false;
      fullStatus.hidden = false;
      if (info.fullStatus === 'ready') {
        downloadFull.href = `${info.fullVideoUrl}?download=1`; downloadFull.hidden = false;
        fullStatus.textContent = `完整纪念版已就绪 · 约 ${Math.round(info.fullDuration || 0)} 秒`;
      } else if (info.fullStatus === 'failed' || info.fullStatus === 'unavailable') {
        downloadFull.hidden = true;
        fullStatus.textContent = info.fullError || '本局暂时没有完整纪念版，高光成片不受影响。';
      } else {
        downloadFull.hidden = true;
        fullStatus.textContent = '完整纪念版正在后台生成，高光版可以先下载。';
      }
      story.hidden = false;
      document.getElementById('view-title').textContent = info.highlightTitle || '你的舞台时刻';
      document.getElementById('view-moments').textContent = info.highlightCount > 1 ? `${info.highlightCount} 个最佳动作 · 卡点剪辑` : '自动精选高光';
      document.getElementById('view-result').textContent = `${info.result.grade} 级 · 得分 ${info.result.score} · 最大连击 ${info.result.maxCombo}`;
      timer = setTimeout(update, info.fullStatus === 'processing' || info.fullStatus === 'waiting' ? 3000 : 60000);
    } else if (info.status === 'failed') {
      status.textContent = '生成暂时失败，请联系现场工作人员重试。'; retry.hidden = false;
    } else {
      status.textContent = info.status === 'uploading' ? '设备正在上传，请保持游戏设备联网。此页面会自动更新。' : '正在为你剪辑精彩时刻，完成后会自动显示。';
      timer = setTimeout(update, 3000);
    }
  } catch (e) { status.textContent = `暂时无法连接：${e.message}`; retry.hidden = false; }
}
retry.onclick = update;
video.addEventListener('error', () => {
  if (refreshes++ < 2) { video.removeAttribute('src'); update(); }
  else { status.textContent = '播放遇到问题，请重新连接或下载后观看。'; retry.hidden = false; }
});
update();
