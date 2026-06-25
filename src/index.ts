import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export default function grapevine(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'grapevine_status',
    label: 'Grapevine Status',
    description: 'Show local pi-grapevine status.',
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [{ type: 'text', text: 'pi-grapevine is installed. Broker not implemented yet.' }],
        details: { implemented: false },
      };
    },
  });
}
