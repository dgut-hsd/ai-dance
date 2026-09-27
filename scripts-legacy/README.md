# scripts-legacy — 已移除的运行时硬编码源(备份)

以下文件曾是 `web_dance/` 里「挑战模式运行时生成参考序列/谱面」的硬编码数据源，
在 songs/ 持久化落地(每曲一文件夹平铺 + 离线导出)后被删除，此处原样备份：

- `challenge-library.js` — FBX 动作 → dance-sequence/v1 转换 + `SONGS`/`CHALLENGE_DANCES`/`FBX_DANCES` 配对表 + `loadFbxSequence`。
- `demo-sequence.js` — `buildDemoSequence()` 合成 24s 示例舞(关键姿态 + smoothstep 插值)。

现行等价物(离线构建期使用,浏览器运行时不加载):

- `scoring/examples/song-sources.js` — 收纳全部转换逻辑与舞曲定义(合成 demo / FBX→序列 / 配对表)。
- `scoring/examples/export-songs-cli.js` — 一次性落盘 `songs/<danceId>/`(参考序列 + 独立谱面 + 音频 + fbx 源)。

运行时的唯一数据来源 = `songs/` 目录文件(song-library.js 读取)。