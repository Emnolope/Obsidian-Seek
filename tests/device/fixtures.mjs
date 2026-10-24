// Single source for the fixture vault: the human script embeds it, the bot script seeds from it, so both halves read byte-identical input.
import { createHash } from 'node:crypto';

export const VAULT_NAME = 'SeekTest'; // seeding refuses any other vault name; it overwrites .obsidian settings

const rows = Array.from({ length: 160 }, (_, i) => `| r${i} | ${'cell '.repeat(6)}| ${i * 7} |`).join('\n');
const deep = `e/deep/er/nest ed/ünï.md`;
const long = `f/${'x'.repeat(100)} very long name.md`;

export const files = {
  'a/alpha.md': `---\ntags: [alpha, fixture]\nstatus: draft\nscore: 7\nwhen: 2026-01-15\n---\n# Alpha\n\nZebrafish orchids grow here. See [[béta note]].\n\n## Second heading\n\nA body #bodytag line.\n`,
  'b/béta note.md': `# Béta\n\nA completely different passage about soil fungi and decomposition.\n\nBack to [[alpha]].\n`,
  'c/gamma.md': `# Gamma\n\n\`\`\`js\nconst x = "[[not-a-link]]"; // quartz_marker_77\n\`\`\`\n\nReal link: [[alpha]]. Embed: ![[béta note]]\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> [!note] A callout\n> with two lines\n`,
  'c/oversize.md': `# Oversize\n\n${rows}\n`,
  'd/empty.md': '',
  'd/notes.base': `filters:\n  and:\n    - file.hasTag("alpha")\nviews:\n  - type: table\n    name: Alpha notes\n`,
  'd/readme.txt': 'not markdown; never indexed\n',
  [deep]: `# Deep\n\nNested folder with a space and a diaeresis.\n`,
  [long]: `# Long\n\nA very long file name.\n`,
  'ignored/secret.md': `# Secret\n\nExcluded by userIgnoreFilters.\n`,
};

// Dot folders: Obsidian does not list them and neither should the bot. Parity on that is part of the test.
export const hidden = { '.dot/hid.md': `# Hidden\n\nIn a dot folder.\n` };

export const ignoreFilters = ['ignored/'];
export const config = { '.obsidian/app.json': JSON.stringify({ userIgnoreFilters: ignoreFilters }) };

// Hand-written, not computed from the indexing rules: a rule bug must not be able to bless itself.
export const indexable = [
  'a/alpha.md', 'b/béta note.md', 'c/gamma.md', 'c/oversize.md', 'd/empty.md', 'd/notes.base', deep, long,
].sort();

export const pathCases = { unicode: 'b/béta note.md', deep, long, spaces: 'b/béta note.md', empty: 'd/empty.md' };

export const sha = s => createHash('sha256').update(s, 'utf8').digest('hex');
export const hashes = Object.fromEntries([...Object.entries(files), ...Object.entries(hidden)].map(([p, c]) => [p, sha(c)]));

for (const p of Object.keys({ ...files, ...hidden })) if (p !== p.normalize('NFC')) throw new Error('fixture path not NFC: ' + p);
