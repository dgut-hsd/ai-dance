import { createApp } from './app.js';
const service = await createApp();
const port = Number(process.env.PORT || 8000);
const server = service.app.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`DANCE ARENA: ${process.env.PUBLIC_BASE_URL || `http://localhost:${port}`}/web_dance/`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await service.close(); server.close(() => process.exit(0));
});
