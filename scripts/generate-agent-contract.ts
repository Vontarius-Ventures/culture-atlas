import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAgentContract } from '../packages/agent-gateway/src/contract';
export { buildAgentContract } from '../packages/agent-gateway/src/contract';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateAgentContract(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
