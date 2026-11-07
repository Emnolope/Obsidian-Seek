// Why it exists: embed-smoke only embeds three tiny strings, so it can't show whether time grows with padding rung.
// The plugin times out on 348-463 token chunks (rungs 384/512) while a 32-rung embed takes ~1s; this runs every rung on the bot's own Chromium path.
// Run like embed-smoke.ts: SEEK_CHROMIUM_PATH=... node --experimental-strip-types mcp/device-tests/embed-ladder.ts
import { ChromiumSidecar } from '../src/chromium-sidecar.ts';
import { BotEmbedder } from '../src/bot-embedder.ts';
import { SEQ_BUCKETS } from '../../core/child-script.ts';

const sc = new ChromiumSidecar();
const e = new BotEmbedder(sc);
const say = (m: string) => console.log(`[ladder ${new Date().toISOString()}] ${m}`);
try {
  say('loading model via first tokenCounts call ...');
  const t0 = Date.now();
  say(`token counts for "parity": ${await e.tokenCounts(['parity'])} after ${Date.now() - t0}ms incl. model load`);
  for (const b of SEQ_BUCKETS) {
    const text = Array(Math.max(1, b - 4)).fill('word').join(' ');
    const n = (await e.tokenCounts([text]))[0];
    for (const rep of [1, 2]) {
      const t = Date.now();
      say(`bucket ${b} tokens ${n} rep ${rep}: starting ...`);
      try {
        const r = await e.embedBatch([text], b);
        say(`bucket ${b} tokens ${n} rep ${rep}: ${Date.now() - t}ms iframeLatencyMs=${r.iframeLatencyMs} dim=${r.vectors[0].length}`);
      } catch (err) {
        say(`bucket ${b} tokens ${n} rep ${rep}: ERROR after ${Date.now() - t}ms: ${(err as Error).message}`);
        break;
      }
    }
  }
  say('done');
} finally { await sc.close(); }
