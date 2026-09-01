#!/usr/bin/env node
// Post-build: make dist/cli/index.js runnable as a `bin` executable.
// tsc emits plain JS without a shebang or exec bit, which breaks npm link /
// `npm install -g`. Prepends `#!/usr/bin/env node` and chmod +x.

import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'dist', 'cli', 'index.js');

if (!existsSync(target)) {
  console.error('dist/cli/index.js not found. Run `npm run build` first.');
  process.exit(1);
}

const SHEBANG = '#!/usr/bin/env node\n';
const raw = readFileSync(target, 'utf8');

if (!raw.startsWith(SHEBANG)) {
  writeFileSync(target, SHEBANG + raw);
}

chmodSync(target, 0o755);
console.log(`made executable: ${target}`);