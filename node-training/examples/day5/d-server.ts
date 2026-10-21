import { buildApp } from './d-app.js';

const app = buildApp();
await app.listen({ port: 3000 });
console.log('Server đang chạy ở http://localhost:3000');
