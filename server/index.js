import { createApp } from './app.js';
import { runFFmpeg } from './media.js';
try {
  await runFFmpeg(['-version'], 10000);
} catch {
  console.error('视频处理程序未就绪。请运行 npm install，或在 .env 中设置有效的 FFMPEG_PATH。');
  process.exit(1);
}
const service = await createApp();
const port = Number(process.env.PORT || 8000);
const server = service.app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`DANCE ARENA: ${process.env.PUBLIC_BASE_URL || `http://localhost:${port}`}/web_dance/`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await service.close(); server.close(() => process.exit(0));
});
