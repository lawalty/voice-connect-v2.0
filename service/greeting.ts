import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerEvent } from '../contract/types.js';
import { VOICE_GREETING_PROMPT } from '../contract/greeting.js';
import type { GatewayPort } from './gateway.js';
import type { Store } from './store.js';

export function registerGreetingRoute(app: FastifyInstance, store: Store, gateway: GatewayPort, observers: Set<(event: ServerEvent) => void>) {
  const cancellations = new Set<() => void>();
  app.addHook('preClose', async () => { for (const cancel of cancellations) cancel(); });
  const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
  app.post('/api/conversations/:id/greeting', { config: { rateLimit: { max: 12, timeWindow: 60000 } } }, async (req, reply) => {
    const params = z.object({ id }).parse(req.params);
    const body = z.object({ id }).strict().parse(req.body);
    if (!store.conversation(params.id)) return reply.code(404).send({ error: 'Conversation not found.' });
    if (store.active(params.id) || store.turn(body.id)) return reply.code(409).send({ error: 'A conversation turn is already in progress.' });
    let settle!: (text?: string) => void;
    const finished = new Promise<string | undefined>(resolve => { settle = resolve; });
    const observe = (event: ServerEvent) => {
      if (event.type === 'turn' && event.conversationId === params.id && event.turnId === body.id && ['failed', 'cancelled', 'uncertain'].includes(event.delivery)) settle();
      if (event.type === 'complete' && event.conversationId === params.id && event.turnId === body.id)
        settle(event.failed || event.cancelled ? undefined : event.text);
    };
    const cancel = () => {
      settle();
      const turn = store.turn(body.id);
      if (turn && !turn.cancelRequested && ['pending', 'accepted', 'uncertain'].includes(turn.delivery)) void gateway.abort(params.id, body.id).catch(() => {});
    };
    const closed = () => { if (!reply.raw.writableEnded) cancel(); };
    const timer = setTimeout(cancel, 25000);
    observers.add(observe); cancellations.add(cancel); reply.raw.once('close', closed);
    try {
      // A gateway admission timeout must not outlive the greeting deadline.
      const receipt = await Promise.race([gateway.send(params.id, { id: body.id, text: VOICE_GREETING_PROMPT }), finished.then(() => undefined)]);
      if (receipt && !['pending', 'accepted', 'complete'].includes(receipt.delivery)) settle();
      const text = (await finished)?.trim();
      if (!text || text.length > 500) { cancel(); return reply.code(503).send({ error: 'The greeting was unavailable. Listening can begin.' }); }
      return { turnId: body.id, text };
    } catch {
      cancel();
      return reply.code(503).send({ error: 'The greeting was unavailable. Listening can begin.' });
    } finally {
      clearTimeout(timer); observers.delete(observe); cancellations.delete(cancel); reply.raw.removeListener('close', closed);
    }
  });
}
