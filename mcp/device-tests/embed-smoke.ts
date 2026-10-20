// Phone/desktop smoke for the bot's index-path embedder: starts the Chromium sidecar, counts tokens,
// embeds a batch, and checks the vectors. Run: node --experimental-strip-types mcp/device-tests/embed-smoke.ts
import { ChromiumSidecar } from '../src/chromium-sidecar.ts';
import { BotEmbedder } from '../src/bot-embedder.ts';
import { selectIndexBucket } from '../../core/child-script.ts';

const sc = new ChromiumSidecar();
const e = new BotEmbedder(sc);
const texts = ['The quick brown fox.', 'Sidecar format three, int8 plus sign bits.', 'Hello world'];
const t0 = Date.now();
try {
  const counts = await e.tokenCounts(texts);
  console.log('token counts', counts, `(+${Date.now() - t0}ms incl. model load)`);
  const bucket = selectIndexBucket(Math.max(...counts));
  const r = await e.embedBatch(texts, bucket);
  const norms = r.vectors.map(v => Math.hypot(...v));
  console.log('bucket', bucket, 'vectors', r.vectors.length, 'dim', r.vectors[0].length, 'norms', norms.map(n => n.toFixed(3)), 'iframeLatencyMs', r.iframeLatencyMs);
  const ok = r.vectors.length === 3 && r.vectors.every(v => v.length === 384) && norms.every(n => Math.abs(n - 1) < 0.01);
  console.log(ok ? 'OK' : 'FAIL: unexpected vectors');
  process.exitCode = ok ? 0 : 1;
} finally { await sc.close(); }
