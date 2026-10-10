import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getFreePort } from './free-port.js';

const listenOn = (port: number) =>
  new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe('getFreePort', () => {
  it('returns a port that can be bound right away', async () => {
    const port = await getFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    await close(await listenOn(port));
  });

  it('does not return a port that is currently in use', async () => {
    const first = await listenOn(await getFreePort());
    const taken = (first.address() as { port: number }).port;
    for (let i = 0; i < 5; i++) expect(await getFreePort()).not.toBe(taken);
    await close(first);
  });
});
