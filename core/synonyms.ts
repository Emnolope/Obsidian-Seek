// fork 1.1.3: whole file moved from src/synonyms.ts (src/synonyms.ts is now a re-export shim)
// Query-side alias-dictionary synonym expansion (v1, default OFF).
//
// Motivation (eval pack 2026-06-10, alias_expansion.py + prefix_arm.py): a
// note's frontmatter aliases declare vault-specific equivalences ("Lr" ↔
// "Lightroom") that only help the alias OWNER — doc-side alias indexing can
// never lexically reach a note that spells the canonical form out. Expanding
// the QUERY with alias classmates closes that gap: personal 483q +0.0015 bin
// nDCG@10 over the shipped prefix baseline at w=0.8 (triggered-subset +0.017
// pre-prefix), D&D/code stress sets clean (vacuously — their vaults define
// almost no aliases, which is itself the safety property: no dictionary, no
// behavior change).
//
// The dictionary is per-note but index postings are GLOBAL — every guard here
// exists because of that scope mismatch (adversarial review 2026-06-10, vault
// note "Seek Synonym Expansion Plan"):
//   - strict trigger guard: a token in >1 class never expands (4 person pages
//     aliased "rohit" → querying "rohit" must not guess which one).
//   - SYMMETRIC mate guard: an ambiguous token is never INJECTED either.
//     Without it the trigger guard leaves the reverse direction open —
//     "rsharma" → mate "rohit" would score every Rohit in the vault. Measured
//     exactly free on the personal eval (32→30 triggers, no metric motion);
//     only binds in vaults where the collision actually exists.
//   - df ceiling: ambiguity is only visible INSIDE the dictionary. A junk
//     common-word alias ("index" on one note) is unambiguous by the class
//     check yet becomes a vault-wide query-time landmine. Refuse any trigger
//     or mate matching more than SYNONYM_DF_CEILING of all chunks.
//
// English-only posture: class members tokenize through the same ASCII-leaning
// stoplist + depluralizer pipeline as queries (bm25.ts processTerm); the
// feature is untested on non-English vaults by construction.

import type { ChunkMeta } from './chunker.ts';
import type { LinkPairCount } from './link-dict.ts';
import { extractNoteName, processQueryTerm } from './bm25.ts';
import { seekTokenize, hasCjk } from './tokenize.ts';

// Mate score discount, mirroring the harness arm (w=0.8 swept best on the
// personal eval; cf. MiniSearch's own fuzzy weight 0.45 / prefix 0.375).
// NOTE: the harness measured SOURCE-attributed scoring; the plugin's native
// MiniSearch path double-credits mates in the ×quality multiplier (see
// bm25.ts getScoresWithCoverage), so the gate requires a native-semantics
// re-sweep before default-ON (plan note, gate corrections).
export const SYNONYM_WEIGHT = 0.8;

// df sanity ceiling (review fix #3): a trigger or mate token matching more
// than this fraction of chunks is dropped at build time.
//
// Was 5%, on the premise that "real alias tokens (names, acronyms, products)
// are rare terms; only genuine junk gets near it". Measured 2026-08-31, that
// premise is false in the direction that matters: a vault's short names are
// frequent BECAUSE the vault is about them, so the ceiling refused precisely
// the entities worth expanding and every one of them had no entry at all —
//
//     class                          personal   usage08
//     {lr, lightroom}                6.7 / 2.9  8.3 / 3.1   both, via lr
//     {eval, evaluation}             5.9 / 6.3  4.6 / 5.8   both
//     {ckg, ckg4}                    7.3 / 1.4  9.2 / 1.4   ckg
//
// (chunk-level df, the same measure termDocFraction feeds in; absolute values
// move per corpus, the ordering does not.) lr <-> lightroom is the most-queried
// entity in the eval sets — 20+ queries in personal.jsonl plus `lr mobile
// release date` in every usage harvest — and it is single-to-single, so it has
// been v1 machinery, shipped and default ON, silently inert the whole time.
//
// 10% admits those and still refuses `intent` (12.0% on usage08), the nearest
// real hazard: a topic word whose class-mate `mint` is a COMPONENT of intent,
// not another name for it. That refusal is corpus-dependent (`intent` is 6.5%
// on the older personal corpus), so the ceiling is a blunt instrument holding
// a semantic distinction — see the version-pair guard in buildSynonymMap for
// the same lesson learned the other way.
//
// Gated by seek-eval-pack synonym_ceiling_arm.py (paired A/B, dense held
// byte-identical, v10 caches so deltas are honest and absolutes stale):
//     personal 483q    56 triggered  5W/5L  whole set +0.0010  gold into top-10 +3/-0
//     usage08 34q       4 triggered  2W/0L  whole set +0.0105  +1/-0
//     usage_miss08 52q  3 triggered  1W/0L  whole set +0.0025   0/-0
// Zero losses on both real-usage sets. personal is the honest caveat: it fails
// a strict sign test (p=1.0) and its worst single query is -0.369, two gold
// notes slipping rank 1 -> 2. The wins are recall (rank 23 -> 6, 22 -> 10) and
// the losses are within-top-3 shuffling, which nDCG@10 weights identically.
export const SYNONYM_DF_CEILING = 0.10;

export interface SynonymStats {
    classes: number;
    triggers: number;
    droppedAmbiguous: number;   // tokens removed as triggers by the strict guard
    droppedDf: number;          // tokens removed (trigger or mate side) by the df ceiling
    droppedVersionPair: number; // trigger->mate directions refused as versions
}

export interface SynonymMap {
    // trigger token -> mate tokens, all in processTerm space. Mates are
    // ordered (stable build) and each mate is unambiguous (symmetric guard),
    // so a mate maps back to exactly one source class per query.
    mates: Map<string, string[]>;
    stats: SynonymStats;
}

// A class member is usable only if it survives the query pipeline as exactly
// ONE token (multi-token alias phrases are v2), ≥2 chars, not purely numeric.
//
// Tokenized with seekTokenize — the SAME analyzer the index AND query use — in its
// CANONICAL stream (derived:false): possessive-strip + CJK segmentation, but NOT
// the additive glue/camelCase recall forms (which would mis-reject a single
// camelCase alias like "MemGraph" as multi-token). This retires the last caller of
// MiniSearch.getDefault('tokenize') (audit 2026-06-29 #3), so tokenize.ts's "sole
// tokenizer" invariant is true again, and a CJK alias no longer forms a dead class
// the segmented query side can never trigger. Eval-gated as a strict no-op:
// identical synonym dictionary AND retrieval on personal/dnd/myvault
// (synonym_tokenizer_arm.py) — those vaults carry no possessive/CJK/\p{Sm} alias,
// the only members where the two tokenizers' single-token verdict diverges.
function singleToken(member: string): string | null {
    const raw = seekTokenize(member, { derived: false });
    if (raw.length !== 1) return null;
    const t = processQueryTerm(raw[0]);
    if (t === null || t.length < 2 || /^\d+$/.test(t)) return null;
    return t;
}

// Cheap, CONSERVATIVE "could this chunk's note affect the dictionary?" probe
// for the incremental rebuild gate (search.ts applyDelta). The dictionary is a
// pure function of alias-bearing notes: buildClasses keeps a class only when it
// has ≥2 single-token members, and a note's name supplies at most one, so a
// note with no frontmatter aliases NEVER forms a class. A delta that adds or
// removes no alias-bearing row therefore cannot change the dictionary.
//
// Conservative on purpose: a declared alias that tokenizes to nothing usable
// still returns true here, so the gate may over-trigger a harmless no-op
// rebuild — but it never UNDER-triggers, which would be a correctness bug
// (stale mates). Mirrors the `c.metadata?.aliases` access buildClasses uses;
// aliases is a normalized string[] (chunker extractAliases).
export function chunkDeclaresAlias(c: ChunkMeta): boolean {
    return (c.metadata?.aliases?.length ?? 0) > 0;
}

// One equivalence class per note: single-token members of {note name} +
// frontmatter aliases. Chunk metadata is file-level (duplicated across a
// note's chunks), so the first chunk per note suffices.
export function buildClasses(chunks: ChunkMeta[]): Set<string>[] {
    const seen = new Set<string>();
    const classes: Set<string>[] = [];
    for (const c of chunks) {
        if (seen.has(c.note_path)) continue;
        seen.add(c.note_path);
        const members = [extractNoteName(c), ...(c.metadata?.aliases ?? [])];
        const singles = new Set<string>();
        for (const m of members) {
            const t = singleToken(String(m));
            if (t !== null) singles.add(t);
        }
        if (singles.size >= 2) classes.push(singles);
    }
    return classes;
}

// dfFraction(term) -> fraction of chunks containing the term in any field
// (bm25.ts termDocFraction). Optional so the builder is testable standalone;
// absent means the df guard is skipped.
// A mate that is its trigger plus a numeric suffix is a VERSION, not another
// name for the same thing: ckg4 is a release of ckg, so injecting it NARROWS
// the query instead of restating it. Declared aliases carry both shapes with no
// syntactic difference — a note lists "ckg" and "ckg4" exactly the way it lists
// "lr" and "lightroom" — so nothing upstream can tell them apart.
//
// This is the distinction the df ceiling was standing in for and getting wrong
// in both directions. Raising the ceiling to 10% (see SYNONYM_DF_CEILING) let
// {lr, lightroom} in, which is the point, but it also let {ckg, ckg4} in, which
// cost two of personal's losses and three golds out of the top 3. With this
// guard the same 10% ceiling is the best arm on all three eval corpora at once,
// which no flat constant could manage: `lr` needs >=8.3% on usage08 while `ckg`
// at 7.3% has to stay out on personal.
//
// Deliberately narrow. It refuses "mp"/"mp3" too, which would be wrong if a note
// declared those as aliases of each other; that trade is accepted because the
// version shape is common in this corpus (ckg/ckg4, CKG 4.0, CKG 5.0) and the
// abbreviation-with-trailing-digit shape is not.
function isVersionPair(a: string, b: string): boolean {
    const [lo, hi] = a.length <= b.length ? [a, b] : [b, a];
    return hi.length > lo.length && hi.startsWith(lo) && /^\d+$/.test(hi.slice(lo.length));
}

export function buildSynonymMap(
    chunks: ChunkMeta[],
    dfFraction?: (term: string) => number,
): SynonymMap {
    const classes = buildClasses(chunks);
    const membership = new Map<string, Set<string>[]>();
    for (const cls of classes) {
        for (const t of cls) {
            let m = membership.get(t);
            if (!m) membership.set(t, m = []);
            m.push(cls);
        }
    }
    const ambiguous = new Set<string>();
    for (const [t, clss] of membership) {
        if (clss.length > 1) ambiguous.add(t);
    }

    const stats: SynonymStats = {
        classes: classes.length, triggers: 0,
        droppedAmbiguous: ambiguous.size, droppedDf: 0, droppedVersionPair: 0,
    };
    // A term can be checked once as a trigger and again as a mate candidate of
    // other triggers — count unique dropped terms, not checks.
    const droppedDfTerms = new Set<string>();
    const overDf = (t: string): boolean => {
        if (!dfFraction) return false;
        const over = dfFraction(t) > SYNONYM_DF_CEILING;
        if (over) droppedDfTerms.add(t);
        return over;
    };

    const mates = new Map<string, string[]>();
    for (const [t, clss] of membership) {
        if (ambiguous.has(t)) continue;             // strict trigger guard
        if (overDf(t)) continue;                    // df guard, trigger side
        const out: string[] = [];
        for (const cls of clss) {
            for (const m of cls) {
                if (m === t || ambiguous.has(m)) continue;   // symmetric mate guard
                if (isVersionPair(t, m)) {                   // version, not a name
                    stats.droppedVersionPair++;
                    continue;
                }
                if (overDf(m)) continue;                     // df guard, mate side
                if (!out.includes(m)) out.push(m);
            }
        }
        if (out.length > 0) {
            mates.set(t, out);
            stats.triggers++;
        }
    }
    stats.droppedDf = droppedDfTerms.size;
    return { mates, stats };
}

// ── Synonyms v2 Stage 1: T2 phrase-trigger → single-token mate ──────────────
//
// v1 is single-token ↔ single-token by construction (singleToken gate); the
// alias-gap census (2026-07-23) showed the REAL gap is multi-word aliases —
// "query understanding" ↔ "QU" — declared not in frontmatter but in PIPED
// WIKILINK displays, mined by link-dict.ts. A phrase mate cannot ride
// MiniSearch's per-term processTerm/boostTerm hooks at all (each hook sees ONE
// token; adjacency is gone), so the phrase side is resolved by the CALLER
// (search.ts pre-scans the query with matchPhrases) and handed to
// getScoresWithCoverage as SearchOverrides.synonyms.phraseMates — bm25.ts
// injects the mate once and credits EVERY phrase token's coverage slot.
//
// Every v1 guard has a Stage-1 analog (see buildPhraseMap), plus two new ones:
// an all-generic refusal (a phrase of nothing but common words is a topic, not
// a name) and a CJK refusal (adjacency over dictionary-segmented pieces is not
// a name declaration this feature can vouch for).

// Phrase length bounds: 2..4 processed tokens. k=1 is v1's job; k>4 piped
// displays are sentence-shaped ("see the full plan here"), not names.
export const PHRASE_MAX_TOKENS = 4;

// Vault-wide pair-count floor: one piped link is an accident of phrasing, two
// are a convention. The T1 cross-confirmation in buildPhraseMap bypasses this
// for pairs the note ALSO declares as a frontmatter alias (two independent
// sources beat two repetitions of one).
export const T2_MIN_COUNT = 2;

export interface PhraseEntry {
    tokens: string[];   // the phrase, in processQueryTerm space, in order
    mate: string;       // the single-token display mate, same space
}

export interface PhraseStats {
    phrases: number;                  // entries in the map (one per phrase→mate rule)
    droppedBelowCount: number;        // pairs under T2_MIN_COUNT (and not T1-confirmed)
    droppedNotName: number;           // mate/phrase shape failures (singleToken, isNameShaped, phraseKey, CJK)
    droppedGeneric: number;           // phrases where EVERY token is above the df ceiling
    droppedDf: number;                // mate tokens above the df ceiling (unique terms, like v1)
    droppedTargetCollision: number;   // display tokens naming >1 distinct target note (unique tokens)
    droppedPhraseAmbiguous: number;   // phrase keys spanning >1 target note with >1 distinct mate
}

export interface PhraseSynonymMap {
    // First-phrase-token → entries starting with it. Head-keyed (the plan
    // sketch said "byTail") so the left-to-right scanner does ONE lookup per
    // query position and only then compares windows per length.
    byHead: Map<string, PhraseEntry[]>;
    stats: PhraseStats;
}

// Display-side name filter, on the RAW display string (case is the signal —
// it runs BEFORE tokenization lowercases). Accepts the three shapes the census
// found in real piped displays: an all-caps acronym (QU, FF, SDC, DC), a
// mixed-case acronym (PsW), or a single Title-Cased word (Acro, Lightroom).
// Everything else — lowercase prose ("eames"), multi-word, pure digits — is
// refused: a piped display is often just a grammatical rephrase, and only the
// name-shaped ones are safe to inject vault-wide.
export function isNameShaped(display: string): boolean {
    const d = display.trim();
    if (/^\d+$/.test(d)) return false;                                  // "200" — never a name
    if (/^[A-Z][A-Z0-9]{1,5}$/.test(d)) return true;                    // all-caps acronym ≤6
    if (d.length <= 6 && /^[A-Za-z0-9]+$/.test(d)
        && (d.match(/\p{Lu}/gu)?.length ?? 0) >= 2) return true;        // mixed-case acronym ≤6 (PsW)
    if (/^[A-Z][a-z0-9]+$/.test(d)) return true;                        // single Title-Cased word
    return false;
}

// Phrase text → its dictionary key: 2..PHRASE_MAX_TOKENS tokens in
// processQueryTerm space, or null when unbuildable. Tokenized with the
// CANONICAL stream (derived:false) — the additive glue/camelCase recall forms
// interleave positions and would destroy adjacency — the same choice as
// singleToken above, and the SAME rule matchPhrases applies to the query, so
// key and scan enumerate identically by construction. A stopword token makes
// the phrase unbuildable (not skippable): the query-side scanner treats a
// stopword as a run BREAK, so a key that silently dropped it could never be
// matched — a dead entry pretending to be coverage. CJK tokens are refused
// outright (see the section comment).
export function phraseKey(text: string): string[] | null {
    const raw = seekTokenize(text, { derived: false });
    if (raw.length < 2 || raw.length > PHRASE_MAX_TOKENS) return null;
    const tokens: string[] = [];
    for (const r of raw) {
        if (hasCjk(r)) return null;
        const t = processQueryTerm(r);
        if (t === null || t.length === 0) return null;
        tokens.push(t);
    }
    return tokens;
}

// Build the T2 phrase dictionary from vault-wide (aggregated) pair counts.
// Guard order mirrors buildSynonymMap's build (count floor first, cheap shape
// checks next, df last), with stats attributing each dropped pair to the FIRST
// guard that refused it. `dfFraction` as in buildSynonymMap; `t1` (the v1
// dictionary, when built) enables the cross-source confirmation.
export function buildPhraseMap(
    pairs: LinkPairCount[],
    dfFraction?: (term: string) => number,
    t1?: SynonymMap,
): PhraseSynonymMap {
    const stats: PhraseStats = {
        phrases: 0, droppedBelowCount: 0, droppedNotName: 0, droppedGeneric: 0,
        droppedDf: 0, droppedTargetCollision: 0, droppedPhraseAmbiguous: 0,
    };
    const overDf = (t: string): boolean => dfFraction !== undefined && dfFraction(t) > SYNONYM_DF_CEILING;

    // Pass 1 — display-collision census over ALL pairs (the v1 symmetric-mate
    // guard's analog, and just as scope-blind: computed before any count/shape
    // guard, so a below-count pair still poisons its token). A display token
    // naming >1 distinct target note (the DC case — "DC" piped at both Acrobat
    // and DC Home) is refused EVERYWHERE: strict-drop shipped over a majority
    // rule until live data argues otherwise. Multiple displays for ONE note
    // (Acrobat → DC, Acro) is NOT ambiguity — ordinary multi-mate.
    const mateTargets = new Map<string, Set<string>>();
    for (const p of pairs) {
        const mate = singleToken(p.display);
        if (mate === null) continue;
        let t = mateTargets.get(mate);
        if (!t) mateTargets.set(mate, t = new Set());
        t.add(p.target.toLowerCase());
    }
    const collided = new Set<string>();
    for (const [m, targets] of mateTargets) {
        if (targets.size > 1) collided.add(m);
    }
    stats.droppedTargetCollision = collided.size;

    // Pass 2 — per-pair guards.
    const droppedDfTerms = new Set<string>();
    const survivors: Array<{ tokens: string[]; mate: string; target: string }> = [];
    for (const p of pairs) {
        const mate = singleToken(p.display);
        const tokens = phraseKey(p.target);
        // Cross-source confirmation: the pair's mate is a v1 trigger whose
        // declared mates include a phrase token (e.g. "Lightroom Classic"
        // aliases both "LrC" AND "Lightroom" → the piped [[Lightroom
        // Classic|LrC]] is corroborated by frontmatter). Two independent
        // declaration channels outweigh the repetition floor.
        const t1Confirmed = mate !== null && tokens !== null
            && (t1?.mates.get(mate)?.some(m => tokens.includes(m)) ?? false);
        if (p.count < T2_MIN_COUNT && !t1Confirmed) { stats.droppedBelowCount++; continue; }
        if (mate === null || hasCjk(mate) || !isNameShaped(p.display)) { stats.droppedNotName++; continue; }
        if (collided.has(mate)) continue;                      // counted per-token in pass 1
        if (tokens === null) { stats.droppedNotName++; continue; }
        // All-generic refusal, 2-token phrases only: when BOTH tokens are
        // df-common the phrase is a topic ("meeting notes"), not a name —
        // expanding it would spray the mate over an enormous trigger surface.
        // Phrases of 3+ tokens are exempt even when every token is common:
        // the trigger requires the FULL phrase adjacent in the query, a
        // surface that shrinks geometrically with length, and the mate-side
        // df ceiling below still guards the injection. The live vault's
        // highest-value pair is exactly this shape — "query understanding
        // home" → qu (×72, single target) is three individually-common
        // tokens whose adjacency is a name, and the token-level test alone
        // refused it (2026-08-08 live-dictionary probe).
        if (dfFraction && tokens.length === 2 && tokens.every(t => overDf(t))) { stats.droppedGeneric++; continue; }
        if (overDf(mate)) { droppedDfTerms.add(mate); continue; }
        survivors.push({ tokens, mate, target: p.target.toLowerCase() });
    }
    stats.droppedDf = droppedDfTerms.size;

    // Pass 3 — phrase-ambiguity guard (the v1 strict-trigger analog) + map
    // assembly. Distinct raw targets can normalize to ONE phrase key ("Query
    // Understanding" vs "Query-Understanding" as different notes): if such a
    // key's pairs span >1 target AND >1 mate, firing it would guess which note
    // the query means — refuse the whole key. One target with several mates
    // (case-variant displays, sibling acronyms) keeps them all.
    const byPhrase = new Map<string, Array<{ tokens: string[]; mate: string; target: string }>>();
    for (const s of survivors) {
        const key = s.tokens.join(' ');
        let g = byPhrase.get(key);
        if (!g) byPhrase.set(key, g = []);
        g.push(s);
    }
    const byHead = new Map<string, PhraseEntry[]>();
    for (const group of byPhrase.values()) {
        const targets = new Set(group.map(g => g.target));
        const mates = [...new Set(group.map(g => g.mate))];
        if (targets.size > 1 && mates.length > 1) { stats.droppedPhraseAmbiguous++; continue; }
        for (const mate of mates) {
            const head = group[0].tokens[0];
            let list = byHead.get(head);
            if (!list) byHead.set(head, list = []);
            list.push({ tokens: group[0].tokens, mate });
            stats.phrases++;
        }
    }
    return { byHead, stats };
}

// Query pre-scan: which dictionary phrases does this query CONTAIN? Pure and
// query-scoped by design — phrase detection must never key off a single token
// in a persistent map ("creative knowledge graph"→ckg keyed on "graph" would
// fire for "graph database"). Longest match wins, left-to-right,
// non-overlapping; a stopword BREAKS the adjacency run (symmetric with
// phraseKey, which refuses stopword-bearing phrases). Each result carries the
// mate plus the phrase tokens as `sources` — bm25.ts credits every source's
// coverage slot, so a mate-only doc counts as having matched the whole phrase.
export function matchPhrases(
    query: string,
    pm: PhraseSynonymMap,
): Array<{ mate: string; sources: string[] }> {
    if (pm.byHead.size === 0) return [];
    // Canonical stream + processQueryTerm: identical enumeration to phraseKey.
    // Nulls (stopwords) are KEPT in the positional stream as run breaks.
    const toks = seekTokenize(query, { derived: false }).map(r => processQueryTerm(r));
    const out: Array<{ mate: string; sources: string[] }> = [];
    const seenMates = new Set<string>();
    let i = 0;
    while (i < toks.length) {
        const head = toks[i];
        if (head === null) { i++; continue; }
        let matchedLen = 0;
        const entries = pm.byHead.get(head);
        if (entries) {
            for (let k = Math.min(PHRASE_MAX_TOKENS, toks.length - i); k >= 2 && matchedLen === 0; k--) {
                const window: string[] = [];
                for (let j = i; j < i + k; j++) {
                    const t = toks[j];
                    if (t === null) break;         // stopword breaks the run
                    window.push(t);
                }
                if (window.length !== k) continue;
                for (const e of entries) {
                    if (e.tokens.length !== k) continue;
                    if (!e.tokens.every((t, j) => t === window[j])) continue;
                    // All mates of the matched phrase fire (multi-mate is one
                    // note's several displays); dedupe across repeats of the
                    // phrase in one query.
                    if (!seenMates.has(e.mate)) {
                        seenMates.add(e.mate);
                        out.push({ mate: e.mate, sources: [...e.tokens] });
                    }
                    matchedLen = k;
                }
            }
        }
        i += matchedLen > 0 ? matchedLen : 1;      // non-overlapping: consume the match
    }
    return out;
}
