// External broker with its own response CSP. The pinned legacy binding's Embind
// code generation is permitted only here and in its nested worker, never in the UI.
// No source strings, script paths, credentials, or arbitrary commands are accepted.
importScripts('/runtime/vosk.js');

let model;
let recognizer;
let started = false;
let closing = false;
let flushing = false;

function send(message) { if (!closing) self.postMessage(message); }
function fail(message) { send({ type: 'error', message }); }
function createRecognizer() {
  if (!model || closing) return;
  const current = recognizer = new model.KaldiRecognizer(16000);
  current.on('partialresult', (message) => {
    if (current !== recognizer || closing || message.event !== 'partialresult') return;
    send({ type: 'result', text: message.result.partial, final: false }); send({ type: 'ack' });
  });
  current.on('result', (message) => {
    if (current !== recognizer || closing || message.event !== 'result') return;
    send({ type: 'result', text: message.result.text, final: true });
    if (flushing) {
      flushing = false; current.remove(); recognizer = undefined;
      createRecognizer(); send({ type: 'finished' });
    } else send({ type: 'ack' });
  });
  current.on('error', (message) => { if (message.event === 'error') fail(message.error); });
}

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || closing) return;
  try {
    if (message.type === 'start') {
      if (started || typeof message.url !== 'string') throw new Error('Invalid local speech startup.');
      const url = new URL(message.url);
      if (url.protocol !== 'blob:' || url.origin !== self.location.origin) throw new Error('The local speech model must be a verified same-origin archive.');
      started = true;
      model = new self.Vosk.Model(url.href, -1);
      model.on('load', (result) => {
        if (closing) return;
        if (result.event !== 'load' || !result.result) { fail('Local speech model failed to load.'); return; }
        try { createRecognizer(); send({ type: 'ready' }); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
      });
      model.on('error', (error) => { if (error.event === 'error') fail(error.error); });
    } else if (message.type === 'audio') {
      if (!recognizer || flushing || !(message.samples instanceof Float32Array) || message.samples.length > 16000) throw new Error('Invalid local speech audio frame.');
      recognizer.acceptWaveformFloat(message.samples, 16000);
    } else if (message.type === 'finish') {
      if (!recognizer || flushing) throw new Error('Local speech is not ready to finalize.');
      flushing = true; recognizer.retrieveFinalResult();
    } else if (message.type === 'stop') {
      closing = true; recognizer?.remove(); recognizer = undefined; model?.terminate(); model = undefined;
      self.close();
    }
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
};
