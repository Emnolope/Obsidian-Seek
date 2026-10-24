// Regenerates section1.human.js so the console script can never drift from the fixtures the bot uses.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fx from './fixtures.mjs';

const d = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(join(d, '../../manifest.json'), 'utf8'));
const data = { vaultName: fx.VAULT_NAME, version, files: fx.files, hidden: fx.hidden, ignoreFilters: fx.ignoreFilters, indexable: fx.indexable, pathCases: fx.pathCases, sha: fx.hashes };
const tpl = await readFile(join(d, 'section1.human.tpl.js'), 'utf8');
await writeFile(join(d, 'section1.human.js'), tpl.replace('__FIXTURES__', JSON.stringify(data)));
console.log('wrote section1.human.js');
