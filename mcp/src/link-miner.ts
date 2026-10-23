// fork 1.2.1 new; relates to src/link-dict.ts:46 mineLinkPairsByPath and :68 mineLinkPairsForPaths
// The bot's twin of the metadataCache miners: same output (path -> piped pairs), but it parses the markdown itself because Node has no metadataCache.
// Sync on purpose: ResidentPorts.mineLinkPairs and ApplyCtx.patchLinkPairs are sync in the plugin, and the files are already on local disk.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractPipedPairs, scanWikiLinks, type LinkPairCount } from '../../core/link-dict.ts';

function pairsOf(root: string, path: string): LinkPairCount[] {
  try { return extractPipedPairs(scanWikiLinks(readFileSync(join(root, path), 'utf8'))); } catch { return []; }
}

export function mineLinkPairsByPath(root: string, paths: Iterable<string>, include: (p: string) => boolean): Map<string, LinkPairCount[]> {
  const out = new Map<string, LinkPairCount[]>();
  for (const p of paths) {
    if (!p.endsWith('.md') || !include(p)) continue;
    const pairs = pairsOf(root, p);
    if (pairs.length > 0) out.set(p, pairs);
  }
  return out;
}
