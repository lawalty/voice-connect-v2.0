import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { updaterTools, hostRequest } from './tools.mjs';

test('only a trusted, current owner receives updater tools', () => {
  for (const context of [{}, { senderIsOwner: false }, { senderIsOwner: true }]) assert.deepEqual(updaterTools(context), []);
  assert.equal(updaterTools({ senderIsOwner: true, assertInvocationCurrent() {} }).length, 2);
});

test('update binds the native session and cannot pass model commands to the host', async () => {
  let submitted;
  const context = { senderIsOwner: true, sessionKey: 'agent:northpointe:qa', assertInvocationCurrent() {} };
  const transport = (_options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = body => {
      submitted = JSON.parse(body);
      const response = new EventEmitter();
      response.statusCode = 202;
      response.setEncoding = () => {};
      callback(response);
      response.emit('data', JSON.stringify({ phase: 'queued' }));
      response.emit('end');
    };
    return req;
  };
  await hostRequest('update', context, undefined, transport);
  assert.deepEqual(submitted, { action: 'update', sessionKey: context.sessionKey });
});

test('expired authority fails before a host request is created', () => {
  let called = false;
  assert.throws(() => hostRequest('update', { assertInvocationCurrent() { throw new Error('expired'); } }, undefined, () => { called = true; }));
  assert.equal(called, false);
});

test('status is read-only and does not reveal the private notification session', async () => {
  const context = { senderIsOwner: true, assertInvocationCurrent() {} };
  let action;
  const tools = updaterTools(context, async value => { action = value; return { phase: 'completed', sessionKey: 'agent:northpointe:private' }; });
  const result = await tools[1].execute('call', {});
  assert.equal(action, 'status');
  assert.equal(result.details.phase, 'completed');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
