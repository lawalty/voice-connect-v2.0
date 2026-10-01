import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { updaterTools, readHostStatus, completionNotice } from './tools.mjs';
import fs from 'node:fs/promises';

export default definePluginEntry({
  id: 'openclaw-host-updater',
  name: 'OpenClaw Host Updater',
  description: 'Owner-requested, verified OpenClaw updates on the Docker host.',
  register(api) {
    api.registerTool({ contextVersion: 2, create: updaterTools }, {
      names: ['openclaw_update', 'openclaw_update_status'],
    });
    let timer;
    let stopped = false;
    const marker = '/home/node/.openclaw/host-updater-notifications.json';
    const poll = async () => {
      try {
        const job = await readHostStatus();
        if (stopped || !['completed', 'rolled_back', 'failed', 'rollback_failed'].includes(job.phase) || !job.sessionKey || !job.id) return;
        let previous;
        try { previous = JSON.parse(await fs.readFile(marker, 'utf8')); } catch {}
        if (stopped || previous?.id === job.id) return;
        const notice = completionNotice(job);
        api.runtime.system.enqueueSystemEvent(notice.text, notice.eventOptions);
        await fs.writeFile(marker, JSON.stringify({ id: job.id }), { mode: 0o600 });
        if (!stopped) api.runtime.system.requestHeartbeatNow(notice.wakeOptions);
      } catch { /* The updater or gateway may be restarting; retry quietly. */ }
    };
    api.registerService({
      id: 'openclaw-host-updater-result',
      start() { stopped = false; timer = setInterval(poll, 5000); timer.unref(); void poll(); },
      stop() { stopped = true; clearInterval(timer); },
    });
  },
});
