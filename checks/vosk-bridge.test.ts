import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { VoskHost } from '../service/vosk';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
it('authenticates the private recognizer and forwards ordered segments and finalization without provider turn commits', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  cleanup.push(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const events: unknown[] = [], messages: unknown[] = [];
  let credential = '', authorized = true;
  server.on('connection', (ws, request) => {
    credential = request.headers.authorization || '';
    ws.send(JSON.stringify({ type: 'ready' }));
    ws.on('message', (data, binary) => {
      if (binary && Buffer.isBuffer(data)) { messages.push(data.length); ws.send(JSON.stringify({ type: 'ack', bytes: data.length })); }
      else {
        const message = JSON.parse(data.toString()); messages.push(message);
        ws.send(JSON.stringify({ type: 'stt', text: 'a complete thought', final: true, turnComplete: true }));
        ws.send(JSON.stringify({ type: 'finished', id: message.id }));
      }
    });
  });
  const client = Object.assign(new EventEmitter(), { readyState: 1, send: (raw: string) => events.push(JSON.parse(raw)), close: vi.fn() });
  new VoskHost('http://127.0.0.1:' + port, 'private-test-token').bridge(client as unknown as WebSocket, () => authorized);
  await vi.waitFor(() => expect(events).toContainEqual({ type: 'ready', sampleRate: 16000 }));
  expect(credential).toBe('Bearer private-test-token');
  client.emit('message', Buffer.alloc(1024), true);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'finish', id: 1 })), false);
  await vi.waitFor(() => expect(events).toContainEqual({ type: 'finished', id: 1 }));
  expect(messages).toEqual([1024, { type: 'finish', id: 1 }]);
  expect(events).toContainEqual({ type: 'stt', text: 'a complete thought', final: true, turnComplete: false });
  authorized = false; client.emit('message', Buffer.alloc(1024), true);
  expect(client.close).toHaveBeenCalled();
  client.emit('close');
});
