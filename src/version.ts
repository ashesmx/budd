import { createRequire } from 'node:module';

// package.json sits one level above both src/ and dist/.
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export const BUDD_VERSION = pkg.version;
/** Version of the agent-facing tool contract, reported by `whoami`. */
export const BUDD_PROTOCOL_VERSION = '1';
