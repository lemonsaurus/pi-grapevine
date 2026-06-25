import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { grapevinePaths } from './paths.js';

export default function grapevine(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'grapevine_status',
    label: 'Grapevine Status',
    description: 'Show local pi-grapevine status.',
    parameters: Type.Object({}),
    async execute() {
      const paths = grapevinePaths();
      return {
        content: [
          {
            type: 'text',
            text: [
              'pi-grapevine is installed.',
              'Broker: not implemented yet.',
              `Socket: ${paths.socket}`,
              `Audit log: ${paths.auditLog}`,
            ].join('\n'),
          },
        ],
        details: { implemented: false, paths },
      };
    },
  });
}
