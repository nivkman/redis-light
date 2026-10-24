import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';

// Uses REDIS_URL when set (CI service); otherwise spawns a throwaway redis-server.
export async function startRedis() {
  if (process.env.REDIS_URL) return { url: process.env.REDIS_URL, stop: async () => {} };
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no']);
  await waitForPort(port);
  return { url: `redis://127.0.0.1:${port}`, stop: async () => { server.kill(); } };
}

async function waitForPort(port) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await canConnect(port)) return;
    await sleep(100);
  }
  throw new Error(`redis-server did not start on port ${port}`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}
