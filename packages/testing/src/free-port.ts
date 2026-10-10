import { createServer, type AddressInfo } from 'node:net';

/** Một cổng TCP đang trống trên 127.0.0.1. Có khoảng hở rất nhỏ giữa lúc đóng và lúc dùng; chỉ dùng cho test. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
