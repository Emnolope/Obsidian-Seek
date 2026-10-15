// The query pipeline, lifted out of SearchOrchestrator.search() so the plugin and the MCP server run ONE ranking implementation.
// Everything that touches IndexedDB, the embedder runtime, Obsidian, workers, or the log file sits behind SearchHost; the plugin and the MCP each supply their own.
import type { ChunkMeta, ScoredChunk, SearchEntry, QueryFilters, FilterContext, SeekSettings } from './types.ts';
import { cleanDenseText } from './dense-clean.ts';
import { MultiFieldBM25, FUZZY_BY_LENGTH, PREFIX_LAST_TOKEN, BM25_COVERAGE_POW } from './bm25.ts';
import { SYNONYM_WEIGHT, type SynonymMap } from './synonyms.ts';
import { rank, cosineScores, DEFAULT_RANKING_CONFIG } from './ranker.ts';
import { recencyDate } from './fusion.ts';
import { browseOrder } from './fusion.ts';
import { topNIndices } from './binary.ts';
import { selectTopNIndices } from './select.ts';
import { poolCaps, POOL_FLOORS } from './pool.ts';
import { dequantizeInt8 } from './quant.ts';
import { calibratedConfidence } from './dense-stats.ts';
import { parseQuery, compileMatcher, excludedNotePaths } from './query-parser.ts';
import { buildPassageTerms } from './passage.ts';
import { alignCandidate, buildSelectionMask, frameBm25Coherent, dedupByPath, topKByScore, makeSnippet, type ResidentFrame } from './search-helpers.ts';

// Per-call override of the recency knobs; a call argument, never written into settings, so concurrent searches can't see each other's override.
export interface RecencyOverride {
    epsilon?: number;
    halfLifeDays?: number;
}

export interface SearchHost {
    // Read live on every query so a settings change applies to the next search with no reindex.
    readonly settings: SeekSettings;
    // numericKeys is vault-specific (Obsidian's property registry), so the host owns it.
    filterCtx(override?: RecencyOverride): FilterContext;
    // null frame = no usable index yet. wasCached feeds the binaryCacheHit telemetry.
    frame(): Promise<{ frame: ResidentFrame | null; wasCached: boolean }>;
    bodies(ids: string[]): Promise<Array<string | null | undefined>>;
    bodiesMap(ids: string[]): Promise<Map<string, string>>;
    // Fallback when the frame carries no resident int8 block.
    embeddings(ids: string[]): Promise<Array<Float32Array | null>>;
    embed(text: string): Promise<{ vector: Float32Array; iframeLatencyMs: number }>;
    // Plugin runs this in a Worker; the MCP can run it inline. Same indices either way.
    binaryCandidates(gen: number, q: Float32Array, packed: Uint8Array, n: number, bytesPerVec: number, cap: number, mask: boolean[] | null): Promise<number[]>;
    // Loads a persisted index or fits one; true = served warm.
    prepareBm25(orderedChunks: ChunkMeta[]): Promise<boolean>;
    bm25(): MultiFieldBM25 | null;
    bm25Boosts(): Record<string, number>;
    synonyms(): SynonymMap | null;
    onCoherenceDrift(where: string): void;
    bgStats(): Promise<{ mean: number; std: number } | null>;
    log(entry: SearchEntry): Promise<void>;
    logError(tag: string, err: Error): Promise<void>;
}

async function hydrateBodies(host: SearchHost, results: ScoredChunk[]): Promise<void> {
    if (results.length === 0) return;
    const bodies = await host.bodies(results.map(r => r.chunk_id));
    for (let i = 0; i < results.length; i++) results[i].content = bodies[i] ?? '';
}

function topByRecency(settings: SeekSettings, chunks: ChunkMeta[], k: number, mask?: boolean[] | null): number[] {
    // NaN marks ineligible (masked out or undated) so selectTopNIndices skips it without building per-chunk objects.
    const n = chunks.length;
    const dates = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (mask && !mask[i]) { dates[i] = NaN; continue; }
        const raw = recencyDate(chunks[i], settings.recencyKey, settings.createdProp);
        const t = raw ? Date.parse(raw) : NaN;
        dates[i] = Number.isFinite(t) ? t : NaN;
    }
    return selectTopNIndices(n, k, i => dates[i], i => !Number.isNaN(dates[i]));
}

function emptySearchEntry(
    settings: SeekSettings, query: string, cleanedQuery: string, filters: QueryFilters | null,
    topK: number, searchId: string, idbReadMs: number, totalMs: number,
): SearchEntry {
    return {
        type: 'search',
        timestamp: new Date().toISOString(),
        query, topK,
        cleanedQuery, filters,
        idbReadMs: parseFloat(idbReadMs.toFixed(2)),
        binaryMs: 0,
        selectFetchMs: 0,
        alignMs: 0,
        queryEmbedMs: 0, iframeEmbedMs: 0,
        cosineMs: 0,
        bm25Ms: 0, bm25CacheHit: false,
        fusionMs: 0, snippetMs: 0,
        totalMs: parseFloat(totalMs.toFixed(2)),
        totalChunks: 0,
        binaryTopN: POOL_FLOORS.binary,
        bm25TopM: POOL_FLOORS.bm25,
        recencyTopK: POOL_FLOORS.recency,
        binaryCount: 0, bm25Count: 0, recencyCount: 0,
        candidateUnionSize: 0,
        binaryCacheHit: false,
        rawDenseTop5: [], rawBm25Top5: [], fusedTop50: [],
        alpha: settings.denseWeight,
        recencyWeight: settings.recencyEpsilon,
        recencyKey: settings.recencyKey,
        searchId,
    };
}

// Search path (two-stage, v7+):
//
//   S0  resident frame (corpus + binary index, cached by dataGeneration —
//       listAllChunks runs only on a cache miss, i.e. after a reindex)
//   S1  union of three candidate gens, fed by the resident tier:
//         a. binary-top-N — asymmetric float·sign-bit dot product
//         b. bm25-top-M   — multi-field BM25F (cached)
//         c. recency-top-K — newest by frontmatter `created` (mtime fallback)
//   S2  fp32 exact rerank ONLY over the union: load fp32 vectors for the
//       union ids, cosine, then run the shipped α-min-max-hybrid + recency
//       + title boost over the subset
//   S3  file-level max-aggregation dedup, snippet, log
//
// The S1 union — not just binary — is mandatory per the design note: BM25
// and recency arms exist precisely to recover the ~9% dense-unreachable
// gold that exact dense itself caps at. Skipping them would regress
// recall vs the old all-chunks scorer.
//
// recencyOverride: the seek:search CLI's per-query recencyWeight/
// recencyHalflife params (see main.ts). Resolved locally into filterCtx/
// rankConfig below — deliberately NEVER written into host.settings.
// host.settings is a single live object shared by every concurrent
// caller (other CLI calls, the search modal, openTopResult), so an
// earlier version that mutated it for the override's duration let a
// plain concurrent search silently rank against someone else's override
// (2026-07-02 review). Passing the override as a call-local argument
// instead makes overlapping searches independent by construction — no
// shared mutable state, so nothing to race or leak.
export async function runSearch(host: SearchHost, query: string, topK = 10, recencyOverride?: RecencyOverride): Promise<{ results: ScoredChunk[]; entry: SearchEntry }> {
    const t0 = performance.now();
    const searchId = `${Date.now()}-${query.slice(0, 20)}`;

    // Parse inline filter syntax (#tag / tag: / path: / [k:v] / numeric /
    // dates). `cleanedQuery` is the residual text we embed + BM25; `filters`
    // drives the candidate-selection match-mask below. A null `filters` means a
    // plain query — the mask stays undefined and the path is unchanged. The
    // FilterContext threads vault-specific facts (Number-typed props, the
    // Recency date field) into the otherwise-pure parser/matcher; same object
    // is reused by compileMatcher so parse and match agree on types/field.
    const filterCtx = host.filterCtx(recencyOverride);
    const { cleanedQuery, filters } = parseQuery(query, filterCtx);

    // ---- S0: resident-tier read ------------------------------------
    // listAllChunks is unavoidable: BM25 needs all chunks to build its
    // inverse index, and the result UI needs chunk text/metadata. But it's
    // pure text — no fp32 vectors traverse the cursor anymore (that was a
    // full-embeddings dequant scan, removed from the hot path).
    // ---- S0: resident frame (cached by dataGeneration) -------------
    // The frame is the corpus in binary-index order with its aligned packed
    // buffer; all three S1 arms and S2 index into it, so "candidate index i"
    // has one meaning. ensureFrame() reads the full chunk store + assembles
    // the frame only on a cache miss (reindex); a warm keystroke returns the
    // cached frame with zero IDB traffic — this is what removes the old
    // per-query listAllChunks read (2026-06-03: ~55% of warm latency).
    // Orphans (binary row without chunk sibling) are dropped inside
    // ensureFrame; they're not retrievable anyway since the UI needs text.
    const idbStart = performance.now();
    const { frame, wasCached: frameWasCached } = await host.frame();
    const idbReadMs = performance.now() - idbStart;
    // Frame and binary index are built together under one dataGeneration, so
    // a frame hit implies the binary index was served from cache too.
    const binaryCacheHitFlag = frameWasCached;

    if (!frame) {
        const entry: SearchEntry = emptySearchEntry(host.settings, query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
        await host.log(entry);
        return { results: [], entry };
    }

    const orderedChunks = frame.orderedChunks;
    const orderedIds = frame.orderedIds;
    const activePacked = frame.activePacked;
    const bytesPerVec = frame.bytesPerVec;
    const residentInt8 = frame.residentInt8;
    const residentScales = frame.residentScales;
    const embDim = frame.embDim;
    const frameGen = frame.generation;

    // ---- Corpus-scaled candidate-pool caps (scaling-doc C) ----------
    // liveN = rows minus incremental-delete tombstones (orderedChunks still
    // carries them until compaction), so a churned vault doesn't inflate the
    // pool. poolCaps grows binary + bm25 by √N and holds recency flat; at our
    // current scale this returns exactly the legacy 200/100/50 (see pool.ts).
    const liveN = orderedChunks.length - frame.tombstoneCount;
    const caps = poolCaps(liveN);

    // ---- Inline-filter pre-filter (match-mask) ---------------------
    // Build a boolean mask over orderedChunks. Filtering is applied at
    // candidate SELECTION (topNIndices / topByRecency below), NOT by
    // shrinking orderedChunks — that keeps the BM25 + binary indexes
    // (built over the full corpus) cache-valid across filtered queries.
    // null filters → undefined mask → byte-identical to a no-filter build.
    const matcher = filters ? compileMatcher(filters, filterCtx) : null;
    // buildSelectionMask folds frame liveness (validRows) AND the inline
    // filter into one mask, so a single downstream `mask` carries BOTH to
    // every consumer: the binary scan, the bm25/recency selection arms, the
    // filter-only browse loop, and the negation AND below. Tombstoned rows
    // (incremental deletes awaiting compaction) are excluded everywhere —
    // including the browse path, whose `!mask ||` short-circuit would
    // otherwise admit holes. undefined only when fully-live AND unfiltered
    // (the byte-identical no-filter fast path).
    let mask = buildSelectionMask(orderedChunks, frame.validRows, frame.tombstoneCount, matcher);

    // Note-level negation (`-term`). compileMatcher is metadata-only and a
    // per-chunk predicate, so it can't express "drop the whole note if any
    // chunk contains X" — we resolve that here over the full corpus and AND
    // it into the same selection mask. Obsidian's `-` is file-level, so we
    // exclude every chunk of a matched note, not just the matching chunk.
    // Folded into `mask`, it costs nothing downstream and covers both the
    // main path and the filter-only fast path below.
    if (filters?.exclude && filters.exclude.length > 0) {
        // Negation matches on body text, but the frame is metadata-only — so
        // fetch the corpus bodies on demand. Paid ONLY on a `-term` query.
        const bodyMap = await host.bodiesMap(orderedIds);
        const excludedNotes = excludedNotePaths(orderedChunks, filters.exclude, id => bodyMap.get(id));
        if (excludedNotes.size > 0) {
            if (!mask) mask = new Array<boolean>(orderedChunks.length).fill(true);
            for (let i = 0; i < orderedChunks.length; i++) {
                if (mask[i] && excludedNotes.has(orderedChunks[i].note_path ?? '')) {
                    mask[i] = false;
                }
            }
        }
    }

    // ---- Filter-only fast path ------------------------------------
    // The query was nothing but operators (e.g. "#meetings", "path:X/*").
    // With no semantic/lexical text there is no relevance signal — this is
    // a BROWSE, ordered by the explicit recency-desc sort in browseOrder
    // (fusion.ts; keyed by the vault's recencyKey setting), NOT the ranking
    // formula. It must stay independent of rank()/RankingConfig so ranking
    // changes can never park the ordering out from under it again (audit
    // 2026-06-09 §1). Scores are honest zeros: nothing is scored here.
    if (cleanedQuery === '') {
        const matchedChunks: ChunkMeta[] = [];
        for (let i = 0; i < orderedChunks.length; i++) {
            if (!mask || mask[i]) matchedChunks.push(orderedChunks[i]);
        }
        // Inline dedup-by-note over the sorted chunks (dedupByPath wants
        // pre-scored input; building ScoredChunks for every match just to
        // throw most away would copy the whole matched set).
        const seenPaths = new Set<string>();
        const results: ScoredChunk[] = [];
        for (const c of browseOrder(matchedChunks, host.settings.recencyKey, host.settings.createdProp)) {
            if (seenPaths.has(c.note_path)) continue;
            seenPaths.add(c.note_path);
            results.push({
                ...c,
                content: '',   // frame-lite: hydrated below from chunk_body
                score: 0,
                ranking_signals: { dense: 0, bm25: 0, hybrid: 0, recency: 0, title_boost: 0, denseRaw: 0 },
            });
            if (results.length >= topK) break;
        }
        await hydrateBodies(host, results);
        for (const r of results) r.snippet = makeSnippet(r.content, [], 200);
        const entry = emptySearchEntry(host.settings, query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
        entry.totalChunks = orderedChunks.length;
        entry.candidateUnionSize = matchedChunks.length;
        entry.recencyCount = matchedChunks.length;
        await host.log(entry);
        return { results, entry };
    }

    // ---- S0.5: query embedding ------------------------------------
    // granite-r2 is symmetric (no query/doc prompt), so the query takes the
    // SAME pass as the doc side. As of v8 (2026-06-28) the doc side is no
    // longer raw: cleanDenseBody/cleanDenseText run in the chunker (wikilinks
    // → alias, URLs → readable words, HTML stripped), so the query must be
    // dense-cleaned too or the two vectors drift on any query carrying [[…]],
    // a URL, or markdown syntax. cleanDenseText is a no-op on a plain-text
    // query, so ordinary queries are byte-identical to before. (BM25 below
    // keeps the raw cleanedQuery: seekTokenize fragments that same syntax
    // symmetrically on both index and query side, so the lexical channel
    // needs no parallel cleaning pass.)
    const qStart = performance.now();
    const embedded = await host.embed(cleanDenseText(cleanedQuery));
    const queryVec = embedded.vector;
    const iframeEmbedMs = embedded.iframeLatencyMs;
    const queryEmbedMs = performance.now() - qStart;

    // Vector sanity: a NaN/Inf query embedding (WASM numeric fault, torn
    // model load) poisons every cosine downstream — comparisons all come
    // back false and results render in frame order scored 0, which reads as
    // silent ranking corruption rather than an error. Every dense score
    // derives from this one vector, so this single gate closes the class;
    // embed() declines to cache a non-finite vector, so a retry re-embeds.
    if (!queryVec.every(Number.isFinite)) {
        await host.logError(
            'searchQueryVectorNonFinite',
            new Error(`Query embedding contains non-finite values (dim ${queryVec.length}) — corrupt embedder output; retry the search.`),
        );
        const entry: SearchEntry = emptySearchEntry(host.settings, query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
        await host.log(entry);
        return { results: [], entry };
    }

    // Dim sanity: the binary index was packed at the dim of whatever the
    // last reindex wrote. If the live model now emits a different dim, the
    // asymmetric scorer will throw — surface the actionable error instead
    // of letting it crash the search.
    if (bytesPerVec !== ((queryVec.length + 7) >> 3)) {
        await host.logError(
            'searchDimMismatch',
            new Error(
                `Binary index was packed for ${bytesPerVec * 8}-d vectors but the loaded model emits ` +
                `${queryVec.length}-d. Run "Seek: Full reindex" to rebuild.`,
            ),
        );
        const entry: SearchEntry = emptySearchEntry(host.settings, query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
        await host.log(entry);
        return { results: [], entry };
    }

    // ---- S1a: binary candidate-gen (off-thread when available) ------
    // Asymmetric float·sign-bit dot product across the whole resident index.
    // The score order is what matters (asymmetric is a biased estimator of
    // cosine — see binary.ts) so we use it only to pick the top-N; the actual
    // relevance score in stage 2 comes from real cosine.
    //
    // Dispatched as a promise so the worker's O(corpus) scan OVERLAPS the
    // main-thread BM25 + recency work below; awaited just before the union.
    // binaryCandidatesAsync resolves to the IDENTICAL indices the synchronous
    // path would (the shared binaryCandidates), via the worker or its fallback.
    const binaryStart = performance.now();
    const binaryPromise = host.binaryCandidates(
        frameGen, queryVec, activePacked,
        orderedChunks.length, bytesPerVec, caps.binary, mask ?? null,
    );

    // ---- S1b: BM25 candidate-gen (cached) ---------------------------
    // BM25 fits over orderedChunks (parallel to the binary array — same
    // index space) so its score array slots directly alongside the binary
    // arm. The dataGeneration cache pattern is unchanged from v0.
    const bm25Start = performance.now();
    // Cold cache → try the local persisted MiniSearch index (IDB), then the
    // cross-device sidecar artifact, before fitting. Guarded on bm25CacheValid so
    // a WARM keystroke skips the await/IDB entirely. The cross-device fallback only
    // runs when the local blob is ABSENT (a fresh/evicted device whose IDB has no
    // BM25 yet) — for a normal device with a local blob it never executes, so the
    // hot path pays zero. bm25Ms therefore times the load-or-fit, whichever ran.
    const bm25CacheHit = await host.prepareBm25(orderedChunks);
    const bm25 = host.bm25();
    // Query-entry drift guard (Seek scaling A1): the frame and BM25 index are
    // about to be jointly indexed by a single row id (the candidate union
    // below), so verify that coupling holds before trusting it. A trip should
    // be impossible — applyDelta verifies + re-stamps under the delta mutex, and
    // the caches are mutated nowhere else — so on the off chance one slips
    // through, serve nothing for THIS keystroke and drop to a full rebuild
    // rather than return silently mis-joined scores; the next search hits the
    // rebuilt cache.
    if (bm25 && !frameBm25Coherent(frame, bm25)) {
        host.onCoherenceDrift('search');
        const entry = emptySearchEntry(host.settings, query, cleanedQuery, filters, topK, searchId, idbReadMs, performance.now() - t0);
        await host.log(entry);
        return { results: [], entry };
    }
    const synEnabled = host.settings.synonymExpansion;
    // Coverage = per-doc fraction of distinct query terms matched (soft-AND).
    // Multiplied into raw BM25 just before fusion (candidate loop below) when
    // settings.bm25Coverage is on, so a doc that matched only part of a multi-
    // term query is discounted vs one that matched all of it — without hard
    // AND's recall cliff. Both arrays come from one MiniSearch pass. Candidate
    // SELECTION (bm25TopIdx) still uses the un-weighted scores, so coverage
    // re-ranks the pool without shrinking recall.
    const { scores: bm25Scores, coverage: bm25Coverage, bound: bm25Bound } = bm25!.getScoresWithCoverage(cleanedQuery, {
        boosts: host.bm25Boosts(),
        // Explicit on/off so the toggles deterministically override the
        // index's baked-in fuzzy:false / prefix:false. Fuzzy "on" = edit
        // distance scaled by term length (≤2 exact / 3–5 = 1 / ≥6 = 2),
        // skipping CJK + digit-bearing tokens — edit-1 on a 2-char token or
        // a year is uncontrolled expansion, not typo tolerance (see bm25.ts
        // FUZZY_BY_LENGTH); prefix "on" = expand only the final query token
        // at ≥3 chars (see bm25.ts PREFIX_LAST_TOKEN).
        fuzzy: host.settings.fuzzyEnabled ? FUZZY_BY_LENGTH : false,
        prefix: host.settings.prefixLastToken ? PREFIX_LAST_TOKEN : false,
        // Alias-dictionary expansion (experimental, default off): mates
        // query at the eval-tuned discount; empty dictionary = inert.
        ...(synEnabled && host.synonyms() && host.synonyms()!.mates.size > 0 && {
            synonyms: { map: host.synonyms()!.mates, weight: SYNONYM_WEIGHT },
        }),
    });
    const bm25TopIdx = topNIndices(bm25Scores, caps.bm25, mask);
    const bm25Ms = performance.now() - bm25Start;

    // ---- S1c: recency candidate-gen ---------------------------------
    // Sorts by frontmatter `created` (mtime fallback), descending — same
    // source the reranker scores on (see topByRecency / ranker.ts). Cheap
    // (one pass + sort) and the arm is purely for *coverage* of recent notes
    // that may not surface via
    // dense/BM25; recency *blending* in the rerank still does the heavy
    // lifting via recency_weight (see ranker.ts DEFAULT_RANKING_CONFIG).
    const recencyTopIdx = topByRecency(host.settings, orderedChunks, caps.recency, mask);

    // Await the (possibly off-thread) binary candidates now that the main
    // thread has finished BM25 + recency. binaryMs spans the dispatch→await
    // window, so it reflects time-to-availability (incl. the overlap), not
    // raw scan cost. Identical indices to the synchronous path.
    const binaryTopIdx = await binaryPromise;
    const binaryMs = performance.now() - binaryStart;

    // ---- S1 union ---------------------------------------------------
    // Per-arm counts measure the unique contribution of each arm BEFORE
    // dedup; useful for telemetry that asks "is the recency arm actually
    // contributing anything new, or is dense already covering it?"
    const unionSet = new Set<number>();
    for (const i of binaryTopIdx) unionSet.add(i);
    const binaryCount = unionSet.size;
    for (const i of bm25TopIdx) unionSet.add(i);
    const bm25Count = unionSet.size - binaryCount;
    for (const i of recencyTopIdx) unionSet.add(i);
    const recencyCount = unionSet.size - binaryCount - bm25Count;
    const candidateIndices = Array.from(unionSet);

    // ---- S2 prep: rerank vectors for the candidate union -----------
    // The whole point of stage 1 is to avoid touching every rerank vector.
    // Prefer the RESIDENT int8 block (assembled in ensureFrame, aligned to
    // the frame index space): dequantize each candidate from RAM by its
    // frame index, dropping the per-keystroke IDB round-trip (selectFetchMs,
    // the one controllable warm cost). Bit-identical to the IDB path — same
    // {q,s} bytes, same dequantizeInt8, Float64 scale — so only the fetch
    // location changes. Falls back to getEmbeddingsByIds when the block is
    // absent (cold/empty/half-migrated index), which keeps the original
    // per-id null handling. Either way fp32Maybe[i] is the vector for
    // candidateIndices[i], so the align loop below is unchanged.
    const fetchStart = performance.now();
    let fp32Maybe: Array<Float32Array | null>;
    if (residentInt8 && residentScales) {
        fp32Maybe = candidateIndices.map(idx =>
            dequantizeInt8(residentInt8.subarray(idx * embDim, (idx + 1) * embDim), residentScales[idx]));
    } else {
        const candidateIds = candidateIndices.map(i => orderedIds[i]);
        fp32Maybe = await host.embeddings(candidateIds);
    }
    const selectFetchMs = performance.now() - fetchStart;

    // See alignCandidate: a missing/mismatched fp32 row degrades to the
    // lexical-only floor instead of dropping the candidate. The zero vector's
    // cosine is discarded — rank() floors denseScores for any lexicalOnly
    // chunk to the real-candidate min before it's used.
    const zeroFp32 = new Float32Array(queryVec.length);
    const alignStart = performance.now();
    const candidateChunks: ChunkMeta[] = [];
    const candidateFp32: Float32Array[] = [];
    const candidateBm25: number[] = [];
    const applyCoverage = host.settings.bm25Coverage;
    for (let i = 0; i < candidateIndices.length; i++) {
        const idx = candidateIndices[i];
        const aligned = alignCandidate(orderedChunks[idx], fp32Maybe[i], queryVec.length);
        if (!aligned) continue;
        candidateChunks.push(aligned.chunk);
        candidateFp32.push(aligned.missingFp32 ? zeroFp32 : (fp32Maybe[i] as Float32Array));
        // Soft-AND: discount a partial multi-term match by its coverage^P (the
        // coordination-level penalty; see BM25_COVERAGE_POW in bm25.ts). The weight
        // is 1 for single-term queries and full-coverage docs (no-op regardless of P),
        // and never 0 for a real partial match (recall-safe). P=2 hardens the discount
        // so a rare-place-token-only match can't out-rank a full-coverage answer
        // ("bars in sf"/"bars in austin" fix). rank() then TM2C2-normalizes this.
        candidateBm25.push(applyCoverage ? bm25Scores[idx] * Math.pow(bm25Coverage[idx], BM25_COVERAGE_POW) : bm25Scores[idx]);
    }
    const alignMs = performance.now() - alignStart;

    // ---- S2 score: exact cosine over the candidate set --------------
    const cosineStart = performance.now();
    const denseScoresCand = cosineScores(queryVec, candidateFp32);
    const cosineMs = performance.now() - cosineStart;

    // ---- S2 fuse + rank ---------------------------------------------
    // Same ranker with one settings-driven lever: navTitleBoost raises the
    // exact basename/alias match weight (the 2026-06-02 study's free win —
    // the entity page outranking pages that merely mention it). Everything
    // else (min-max norm, recency decay, hybrid alpha) is the v0 pipeline.
    const rankConfig = {
        ...DEFAULT_RANKING_CONFIG,
        alpha: host.settings.denseWeight,
        titleBoost: host.settings.navTitleBoost,
        // Recency (2026-06-19): ε weight, half-life, AND the definition of
        // "recent" are all settings-driven now — read fresh from host.settings
        // every query, so a UI change takes effect on the NEXT search with no
        // reindex. ε defaults to the 0.02 tiebreaker; raise it for a deliberate
        // high-recency mode. A query-time override (recencyOverride, from the
        // seek:search CLI params) is resolved here, per-call, falling back to
        // host.settings when absent — see the search() doc comment for why
        // it's a local argument and not a host.settings mutation.
        recencyEpsilon: recencyOverride?.epsilon ?? host.settings.recencyEpsilon,
        recencyHalfLifeDays: recencyOverride?.halfLifeDays ?? host.settings.recencyHalfLifeDays,
        recencyKey: host.settings.recencyKey,
        createdProp: host.settings.createdProp,
    };
    const fusionStart = performance.now();
    // Dedup over the FULL scored candidate union, not a topK-proportional
    // slice. rank() already scores+sorts every candidate (cheap arithmetic
    // over the ≤~350-chunk stage-1 union), so returning the whole sorted
    // list lets dedupByPath reliably reach topK UNIQUE notes. The old
    // topK×3 pool starved dedup whenever one large multi-chunk note
    // dominated the head (e.g. "evaluation" → Evaluation.md's many chunks
    // filled a 9-chunk pool → only 1 doc at topK=3). dedupByPath still caps
    // the displayed rows at topK.
    const rankPoolSize = candidateChunks.length;
    const { results: rankedPool, breakdown } = rank(
        candidateChunks,
        denseScoresCand,
        new Float64Array(candidateBm25),
        cleanedQuery,
        rankPoolSize,
        rankConfig,
        // Theoretical bound from the same MiniSearch pass — fusion divides
        // by it instead of the empirical max (falls back when 0; fusion.ts).
        bm25Bound,
    );
    const fusionMs = performance.now() - fusionStart;

    // ---- S3: dedup + snippet ----------------------------------------
    const results = dedupByPath(rankedPool, topK);

    // Frame-lite: rank() set content to the '' placeholder; fetch the ≤topK
    // bodies now so snippets (and the modal's click-time highlight) have text.
    await hydrateBodies(host, results);

    // Display-only confidence: each result's raw cosine expressed relative to
    // this corpus's dense background (read once per generation; absent on a
    // pre-stats index → field stays undefined and the UI shows no conf). This
    // is the ONLY place the calibration is consumed; it never touched ranking
    // above — rankedPool was already final. Independent of hydrateBodies (it
    // reads denseRaw, a ranking signal, not the body).
    const bgStats = await host.bgStats();
    if (bgStats) {
        for (const r of results) {
            r.ranking_signals.confidence = calibratedConfidence(
                r.ranking_signals.denseRaw, bgStats.mean, bgStats.std);
        }
    }

    const snippetStart = performance.now();
    // IDF from the SAME BM25F index that just ranked these results, so the
    // window chooser weighs terms exactly like the retrieval scorer did
    // (termDocFraction returns 0 on a missing index/term → uniform default
    // weight inside buildPassageTerms, never a throw).
    const passageTerms = buildPassageTerms(
        cleanedQuery, t => bm25?.termDocFraction(t) ?? 0);
    for (const r of results) r.snippet = makeSnippet(r.content, passageTerms, 200);
    const snippetMs = performance.now() - snippetStart;

    // ---- Telemetry ---------------------------------------------------
    // Raw-top-5 traces are reported over the CANDIDATE set, not all chunks
    // — that's what the binary/bm25 arms actually saw. The cross-vault
    // headline "did stage 1 see this candidate at all" is the candidate
    // arm counts above; rawDenseTop5/rawBm25Top5 are for "given the
    // candidate set, what did exact rerank rank highest pre-fusion."
    const rawDenseTop5 = topKByScore(denseScoresCand, candidateChunks, 5);
    const rawBm25Top5 = topKByScore(new Float64Array(candidateBm25), candidateChunks, 5);
    // Persisted ranking-trace depth. The report only ever renders the top 10
    // (generateReport → rows.slice(0, 10)), so normal runs persist 10 — a ~5×
    // smaller search row that keeps the append-only NDJSON from ballooning.
    // verboseTrace keeps the full 50-deep tail for offline pandas/eval. The field
    // name stays `fusedTop50` for log-schema stability; it now holds ≤50 rows.
    const traceDepth = host.settings.verboseTrace ? 50 : 10;
    const fusedTop50 = rankedPool.slice(0, traceDepth).map((r, i) => ({
        chunk_id: r.chunk_id,
        note_path: r.note_path,
        rank: i + 1,
        score: r.score,
        dense: r.ranking_signals.dense,
        denseRaw: r.ranking_signals.denseRaw,
        bm25: r.ranking_signals.bm25,
        recency: r.ranking_signals.recency,
        title_boost: r.ranking_signals.title_boost,
        title: r.title,
    }));

    const totalMs = performance.now() - t0;
    const entry: SearchEntry = {
        type: 'search',
        timestamp: new Date().toISOString(),
        query, topK,
        cleanedQuery, filters,
        idbReadMs: parseFloat(idbReadMs.toFixed(2)),
        binaryMs: parseFloat(binaryMs.toFixed(2)),
        selectFetchMs: parseFloat(selectFetchMs.toFixed(2)),
        alignMs: parseFloat(alignMs.toFixed(2)),
        queryEmbedMs: parseFloat(queryEmbedMs.toFixed(2)),
        iframeEmbedMs: parseFloat(iframeEmbedMs.toFixed(2)),
        cosineMs: parseFloat(cosineMs.toFixed(2)),
        bm25Ms: parseFloat(bm25Ms.toFixed(2)),
        bm25CacheHit,
        fusionMs: parseFloat(fusionMs.toFixed(2)),
        snippetMs: parseFloat(snippetMs.toFixed(2)),
        totalMs: parseFloat(totalMs.toFixed(2)),
        totalChunks: orderedChunks.length,
        binaryTopN: caps.binary,
        bm25TopM: caps.bm25,
        recencyTopK: caps.recency,
        binaryCount,
        bm25Count,
        recencyCount,
        candidateUnionSize: candidateChunks.length,
        binaryCacheHit: binaryCacheHitFlag,
        rawDenseTop5,
        rawBm25Top5,
        fusedTop50,
        alpha: rankConfig.alpha,
        recencyWeight: rankConfig.recencyEpsilon,
        recencyKey: rankConfig.recencyKey,
        // blendMode/rrfK no longer written (RRF deleted 2026-06-11; the
        // optional SearchEntry fields remain so historical rows parse).
        bm25Coverage: applyCoverage,
        prefixLastToken: host.settings.prefixLastToken,
        synonymExpansion: synEnabled,
        searchableProperties: host.settings.searchableProperties,
        headingsField: host.settings.headingsField,
        // Theoretical BM25 bound for this query (0 = bound had no opinion →
        // fusion used the empirical-max fallback). Diagnoses weak-lexical
        // queries: max(rawBm25)/bm25Bound is the channel's confidence.
        bm25Bound: parseFloat(bm25Bound.toFixed(4)),
        searchId,
    };
    await host.log(entry);

    // Catch-up is deliberately NOT triggered here. Firing a foreground embed
    // per keystroke piled embed load onto the shared iOS WebContent process at
    // the exact moment it was busiest (model warm, frame built, a query in
    // flight) → jetsam. The drain now fires from onSearchSessionEnd (query
    // settled / modal closed), wired by the plugin — see drainCatchUp.

    void breakdown;
    return { results, entry };
}

// Pure dense search for callers that hold only a vector (no query text, so nothing lexical to fuse). Exact cosine over every live row,
// per-chunk results (no note dedup), same as the MCP's original vector path. True cosine rather than ranker.cosineScores' dot product,
// because a caller-supplied vector isn't guaranteed unit-length.
export async function runDenseSearch(host: SearchHost, query: Float32Array, topK: number, pathPrefix?: string): Promise<ScoredChunk[]> {
    const { frame } = await host.frame();
    if (!frame) return [];
    const { orderedChunks, orderedIds, residentInt8, residentScales, embDim, validRows } = frame;
    if (query.length !== embDim && residentInt8) throw new Error(`query vector has dimension ${query.length}, index has ${embDim}`);
    let qq = 0;
    for (let d = 0; d < query.length; d++) qq += query[d] * query[d];
    const rows = orderedChunks.length;
    const scores = new Float64Array(rows);
    const fallback = residentInt8 ? null : await host.embeddings(orderedIds);
    for (let i = 0; i < rows; i++) {
        const live = validRows[i] && (!pathPrefix || (orderedChunks[i].note_path ?? '').startsWith(pathPrefix));
        if (!live) { scores[i] = -Infinity; continue; }
        const v = residentInt8 ? dequantizeInt8(residentInt8.subarray(i * embDim, (i + 1) * embDim), residentScales![i]) : fallback![i];
        if (!v) { scores[i] = -Infinity; continue; }
        let dot = 0, vv = 0;
        for (let d = 0; d < query.length; d++) { dot += query[d] * v[d]; vv += v[d] * v[d]; }
        scores[i] = qq && vv ? dot / Math.sqrt(qq * vv) : 0;
    }
    const picked = Array.from(scores.keys()).filter(i => scores[i] > -Infinity).sort((a, b) => scores[b] - scores[a]).slice(0, topK);
    const results: ScoredChunk[] = picked.map(i => ({
        ...orderedChunks[i],
        content: '',
        score: scores[i],
        ranking_signals: { dense: scores[i], bm25: 0, hybrid: scores[i], recency: 0, title_boost: 0, denseRaw: scores[i] },
    }));
    await hydrateBodies(host, results);
    for (const r of results) r.snippet = makeSnippet(r.content, [], 200);
    return results;
}
