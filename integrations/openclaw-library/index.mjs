import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { configuredLibraryTools, libraryToolDefinitions } from './library-tools.js';

export default definePluginEntry({
  id: 'vc-shared-library',
  name: 'Voice Connect Shared Library',
  description: 'Access the existing private document library alongside agent memory.',
  register(api) {
    // Bind each tool set to the trusted native session, never to model-supplied routing.
    api.registerTool((context) => {
    const tools = configuredLibraryTools(api.pluginConfig, context.sessionKey).catch(() => null);
    return libraryToolDefinitions().map(definition => ({
      ...definition,
      async execute(id, args, signal) {
        const tool = (await tools)?.find(item => item.name === definition.name);
        if (!tool) return {isError:true,content:[{type:'text',text:'The shared library connection is unavailable.'}]};
        return tool.execute(id,args,signal);
      },
    }));
    }, {names: libraryToolDefinitions().map(tool => tool.name)});
  },
});
