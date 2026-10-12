import { describe, it, expect } from 'vitest';
import {
    buildClasses, buildSynonymMap, chunkDeclaresAlias, SYNONYM_DF_CEILING,
    buildPhraseMap, matchPhrases, isNameShaped, phraseKey, PHRASE_MAX_TOKENS, T2_MIN_COUNT,
    type PhraseSynonymMap,
} from './synonyms';
import type { LinkPairCount } from './link-dict';
import type { Chunk } from './types';

function makeChunk(id: string, title: string, content: string, aliases: string[] = []): Chunk {
    return {
        chunk_id: id,
        title,
        content,
        note_path: `${id}.md`,
        heading_path: [],
        metadata: { tags: [], aliases, created: null, modified: null, properties: {} },
        start_line: 0,
        end_line: 0,
    };
}

describe('buildClasses', () => {
    it('builds one class per note from single-token name + aliases', () => {
        const classes = buildClasses([
            makeChunk('a', 'Lr Home', 'body', ['Lr', 'Lightroom']),
        ]);
        // "Lr Home" is two tokens → not a member; the class is the aliases.
        expect(classes).toEqual([new Set(['lr', 'lightroom'])]);
    });

    it('dedupes chunks of the same note and skips junk members', () => {
        const classes = buildClasses([
            // multi-token alias, 1-char token, and numeric token all drop;
            // class falls below 2 members → no class at all.
            makeChunk('a', 'Alpha Beta', 'x', ['lightroom home', 'q', '2026']),
            { ...makeChunk('a2', 'Alpha Beta', 'second chunk', ['lightroom home']), note_path: 'a.md' },
        ]);
        expect(classes).toEqual([]);
    });

    it('runs members through the query term pipeline (lowercase + depluralize)', () => {
        const classes = buildClasses([
            makeChunk('a', 'Recs', 'body', ['Recommendations']),
        ]);
        expect(classes).toEqual([new Set(['rec', 'recommendation'])]);
    });

    it('keeps single-word camelCase members as ONE token (audit 2026-06-29 #3: derived:false)', () => {
        // singleToken now tokenizes with seekTokenize(derived:false): "MemGraph" /
        // "GraphDB" each stay one canonical token (the additive camelCase split is
        // OFF), so both survive the single-token gate and form a class. Under
        // derived:true they would split to 3 tokens and be rejected — the dropped-
        // alias regression this convergence deliberately avoids while still
        // retiring the last MiniSearch.getDefault('tokenize') caller.
        const classes = buildClasses([
            makeChunk('a', 'MemGraph', 'body', ['GraphDB']),
        ]);
        expect(classes).toEqual([new Set(['memgraph', 'graphdb'])]);
    });
});

describe('chunkDeclaresAlias (incremental rebuild gate)', () => {
    it('is true for any chunk whose note declares ≥1 alias', () => {
        expect(chunkDeclaresAlias(makeChunk('a', 'Lr Home', 'body', ['Lr', 'Lightroom']))).toBe(true);
    });

    it('is false for a no-alias note (a body-only edit cannot change the dictionary)', () => {
        expect(chunkDeclaresAlias(makeChunk('a', 'Plain Note', 'body', []))).toBe(false);
    });

    it('CONSERVATIVE: true even when the alias tokenizes to nothing usable (safe no-op rebuild)', () => {
        // "q" (1 char) and "2026" (numeric) both drop out of buildClasses, so this
        // note forms no class — yet the gate still fires. Over-triggering a no-op
        // rebuild is acceptable; UNDER-triggering would leave mates stale.
        const c = makeChunk('a', 'Alpha Beta', 'body', ['q', '2026']);
        expect(chunkDeclaresAlias(c)).toBe(true);
        expect(buildClasses([c])).toEqual([]); // ...the rebuild it triggers does nothing
    });

    it('agrees with buildClasses on which notes can contribute (no false negatives)', () => {
        // Every note that buildClasses turns into a class MUST be flagged by the
        // gate, or an alias edit could silently skip the rebuild.
        const contributing = makeChunk('a', 'Lr Home', 'body', ['Lr', 'Lightroom']);
        expect(buildClasses([contributing])).not.toEqual([]);
        expect(chunkDeclaresAlias(contributing)).toBe(true);
    });
});

describe('buildSynonymMap', () => {
    it('maps each unambiguous token to its classmates', () => {
        const { mates, stats } = buildSynonymMap([
            makeChunk('a', 'Lr Home', 'body', ['Lr', 'Lightroom']),
        ]);
        expect(mates.get('lr')).toEqual(['lightroom']);
        expect(mates.get('lightroom')).toEqual(['lr']);
        expect(stats.classes).toBe(1);
        expect(stats.triggers).toBe(2);
    });

    it('strict guard: an ambiguous token never triggers', () => {
        // "rohit" is in both people's classes → querying it must not expand.
        const { mates, stats } = buildSynonymMap([
            makeChunk('a', 'Rohit Sharma', 'body', ['Rohit', 'rsharma']),
            makeChunk('b', 'Rohit Kumar', 'body', ['Rohit', 'rkumar']),
        ]);
        expect(mates.has('rohit')).toBe(false);
        expect(stats.droppedAmbiguous).toBe(1);
    });

    it('symmetric guard: an ambiguous token is never INJECTED as a mate either', () => {
        // The trigger guard alone leaves the reverse direction open: querying
        // the unique nickname would inject "rohit", whose postings hit every
        // Rohit in the vault. The mate set must come back empty.
        const { mates } = buildSynonymMap([
            makeChunk('a', 'Rohit Sharma', 'body', ['Rohit', 'rsharma']),
            makeChunk('b', 'Rohit Kumar', 'body', ['Rohit', 'rkumar']),
        ]);
        expect(mates.has('rsharma')).toBe(false);   // only mate was ambiguous → no entry
        expect(mates.has('rkumar')).toBe(false);
    });

    it('df ceiling refuses common-word triggers and mates', () => {
        const chunks = [makeChunk('a', 'Hub', 'body', ['hub', 'zzindex'])];
        const common = new Set(['zzindex']);
        const df = (t: string) => (common.has(t) ? SYNONYM_DF_CEILING + 0.01 : 0.001);
        const { mates, stats } = buildSynonymMap(chunks, df);
        expect(mates.has('zzindex')).toBe(false);   // trigger side refused
        expect(mates.has('hub')).toBe(false);       // its only mate was refused → no entry
        expect(stats.droppedDf).toBeGreaterThan(0);
    });

    it('version guard: a numeric-suffix mate is refused in BOTH directions', () => {
        // ckg4 is a RELEASE of ckg, not another name for it, so injecting it
        // narrows the query. Nothing upstream can tell the two apart — a note
        // declares "ckg"/"ckg4" exactly the way it declares "lr"/"lightroom" —
        // which is why this is a build-time guard and not a df threshold. It
        // was the df ceiling doing this job by accident, badly: at 10% the
        // pair comes back and costs three golds out of the top 3 on personal.
        const { mates, stats } = buildSynonymMap([
            makeChunk('a', 'CKG', 'body', ['ckg', 'ckg4']),
        ]);
        expect(mates.has('ckg')).toBe(false);    // no surviving mate → no entry
        expect(mates.has('ckg4')).toBe(false);   // and the reverse direction too
        expect(stats.droppedVersionPair).toBe(2);
    });

    it('version guard does not touch abbreviation pairs', () => {
        // The guard must be narrow enough to leave {lr, lightroom} — the pair
        // the ceiling bump exists to admit — completely alone.
        const { mates, stats } = buildSynonymMap([
            makeChunk('a', 'Example Lightroom', 'body', ['Lightroom', 'Lr']),
        ]);
        expect(mates.get('lr')).toEqual(['lightroom']);
        expect(mates.get('lightroom')).toEqual(['lr']);
        expect(stats.droppedVersionPair).toBe(0);
    });

    it('droppedDf counts unique terms, not checks (trigger + mate side = 1)', () => {
        // "zzindex" is checked twice: once as a trigger, once as hub's mate
        // candidate. The telemetry must report one dropped term, not two.
        const chunks = [makeChunk('a', 'Hub', 'body', ['hub', 'zzindex'])];
        const common = new Set(['zzindex']);
        const df = (t: string) => (common.has(t) ? SYNONYM_DF_CEILING + 0.01 : 0.001);
        const { stats } = buildSynonymMap(chunks, df);
        expect(stats.droppedDf).toBe(1);
    });
});

// ── Synonyms v2 Stage 1 ─────────────────────────────────────────────────────

// Pair factory mirroring makeChunk's role: T2_MIN_COUNT by default so a test
// only spells out a count when the count IS the subject.
function pair(target: string, display: string, count = T2_MIN_COUNT): LinkPairCount {
    return { target, display, count };
}

describe('isNameShaped', () => {
    it('accepts the three census shapes: all-caps / mixed-case acronym / Title-Cased word', () => {
        for (const d of ['QU', 'FF', 'SDC', 'DC', 'CKG', 'PsW', 'LrC', 'Acro', 'Lightroom']) {
            expect(isNameShaped(d), d).toBe(true);
        }
    });

    it('rejects lowercase prose, multi-word, pure digits, and over-long acronyms', () => {
        for (const d of ['eames', 'query understanding', '200', 'ROADMAPS7', 'x']) {
            expect(isNameShaped(d), d).toBe(false);
        }
    });
});

describe('phraseKey', () => {
    it('builds a 2–4-token key in processQueryTerm space (lowercase + depluralize)', () => {
        expect(phraseKey('Query Understanding')).toEqual(['query', 'understanding']);
        expect(phraseKey('Creative Knowledge Graphs')).toEqual(['creative', 'knowledge', 'graph']);
    });

    it('rejects 1-token (v1 territory) and >PHRASE_MAX_TOKENS names', () => {
        expect(phraseKey('Firefly')).toBeNull();
        expect(phraseKey('one two three four five')).toBeNull();
        expect(PHRASE_MAX_TOKENS).toBe(4);
    });

    it('a stopword inside the phrase makes it UNBUILDABLE, not skippable', () => {
        // The query scanner treats a stopword as a run BREAK, so a key that
        // silently dropped "the" could never be matched — a dead entry.
        expect(phraseKey('State of the Art')).toBeNull();
    });

    it('refuses CJK phrases (adjacency over segmented pieces is not a name declaration)', () => {
        expect(phraseKey('東京 旅行')).toBeNull();
    });
});

describe('buildPhraseMap', () => {
    it('maps a name-shaped display to its 2-token target phrase', () => {
        const { byHead, stats } = buildPhraseMap([pair('Query Understanding', 'QU')]);
        expect(byHead.get('query')).toEqual([{ tokens: ['query', 'understanding'], mate: 'qu' }]);
        expect(stats.phrases).toBe(1);
    });

    it('count threshold: a single piped usage is an accident, not a convention', () => {
        const { byHead, stats } = buildPhraseMap([pair('Query Understanding', 'QU', 1)]);
        expect(byHead.size).toBe(0);
        expect(stats.droppedBelowCount).toBe(1);
    });

    it('T1 cross-confirmation bypasses the count floor (two sources beat two repetitions)', () => {
        // The note "Lightroom Classic" declares BOTH "LrC" and "Lightroom" as
        // frontmatter aliases → v1 maps lrc→[lightroom]. A count-1 piped
        // [[Lightroom Classic|LrC]] is then corroborated: mate "lrc" is a T1
        // trigger whose declared mates include a phrase token.
        const t1 = buildSynonymMap([makeChunk('a', 'Lightroom Classic', 'body', ['LrC', 'Lightroom'])]);
        expect(t1.mates.get('lrc')).toEqual(['lightroom']);
        const { byHead } = buildPhraseMap([pair('Lightroom Classic', 'LrC', 1)], undefined, t1);
        expect(byHead.get('lightroom')).toEqual([{ tokens: ['lightroom', 'classic'], mate: 'lrc' }]);
        // ...but an UNRELATED count-1 pair is still refused.
        const { byHead: other } = buildPhraseMap([pair('Query Understanding', 'QU', 1)], undefined, t1);
        expect(other.size).toBe(0);
    });

    it('mate must survive singleToken: multi-word and pure-digit displays drop', () => {
        const { byHead, stats } = buildPhraseMap([
            pair('Query Understanding', 'Q U'),         // 2 raw tokens
            pair('Screenshot Archive', '200'),          // all-digits
        ]);
        expect(byHead.size).toBe(0);
        expect(stats.droppedNotName).toBe(2);
    });

    it('mate must be name-shaped: lowercase prose displays drop', () => {
        const { byHead, stats } = buildPhraseMap([pair('Charles Eames', 'eames')]);
        expect(byHead.size).toBe(0);
        expect(stats.droppedNotName).toBe(1);
    });

    it('DC collision: a display naming >1 target note is refused EVERYWHERE (strict-drop)', () => {
        const { byHead, stats } = buildPhraseMap([
            pair('Acrobat Cloud', 'DC'),
            pair('DC Home', 'DC'),
        ]);
        expect(byHead.size).toBe(0);
        expect(stats.droppedTargetCollision).toBe(1);   // one COLLIDED TOKEN, not two pairs
    });

    it('collision census is scope-blind: a below-count pair still poisons its token', () => {
        // The v1 symmetric guard computes ambiguity BEFORE any other guard; the
        // T2 analog must too — a count-1 [[DC Home|DC]] proves "DC" ambiguous
        // even though that pair itself would be refused by the count floor.
        const { byHead } = buildPhraseMap([
            pair('Acrobat Cloud', 'DC', 5),
            pair('DC Home', 'DC', 1),
        ]);
        expect(byHead.size).toBe(0);
    });

    it('multiple displays for ONE note is NOT ambiguity — ordinary multi-mate', () => {
        const { byHead, stats } = buildPhraseMap([
            pair('Acrobat Cloud', 'DC'),
            pair('Acrobat Cloud', 'Acro'),
        ]);
        expect(byHead.get('acrobat')).toEqual([
            { tokens: ['acrobat', 'cloud'], mate: 'dc' },
            { tokens: ['acrobat', 'cloud'], mate: 'acro' },
        ]);
        expect(stats.droppedPhraseAmbiguous).toBe(0);
        expect(stats.phrases).toBe(2);
    });

    it('phrase ambiguity: one phrase key spanning >1 target with >1 mate never fires', () => {
        // Distinct notes "Query Understanding" and "Query-Understanding"
        // normalize to the SAME phrase key with different mates — firing it
        // would guess which note the query means.
        const { byHead, stats } = buildPhraseMap([
            pair('Query Understanding', 'QU'),
            pair('Query-Understanding', 'QUE'),
        ]);
        expect(byHead.size).toBe(0);
        expect(stats.droppedPhraseAmbiguous).toBe(1);
    });

    it('all-generic refusal: a phrase of nothing but df-common tokens is a topic, not a name', () => {
        const common = new Set(['meeting', 'note']);
        const df = (t: string) => (common.has(t) ? SYNONYM_DF_CEILING + 0.01 : 0.001);
        const { byHead, stats } = buildPhraseMap([pair('Meeting Notes', 'MN')], df);
        expect(byHead.size).toBe(0);
        expect(stats.droppedGeneric).toBe(1);
        // ...one rare token rescues the phrase (soft, like v1's 5% looseness).
        const df2 = (t: string) => (t === 'meeting' ? SYNONYM_DF_CEILING + 0.01 : 0.001);
        expect(buildPhraseMap([pair('Meeting Notes', 'MN')], df2).byHead.size).toBe(1);
    });

    it('all-generic exemption: a 3+-token phrase of common tokens survives (the QU shape)', () => {
        // "query understanding home" → qu: every token is individually
        // df-common in the live vault, yet the pair is the census's
        // highest-value entry (×72, single target). The trigger requires the
        // full adjacent phrase in the query — a surface that shrinks
        // geometrically with length — so 3+-token phrases are exempt from
        // the token-level genericity test (2026-08-08 live-dictionary find).
        const common = new Set(['query', 'understanding', 'home']);
        const df = (t: string) => (common.has(t) ? SYNONYM_DF_CEILING + 0.01 : 0.001);
        const d = buildPhraseMap([pair('Query Understanding Home', 'QU')], df);
        expect(d.byHead.size).toBe(1);
        expect(d.stats.droppedGeneric).toBe(0);
        expect(matchPhrases('query understanding home evals', d)[0]?.mate).toBe('qu');
    });

    it('df ceiling on the mate refuses a common-word display', () => {
        const df = (t: string) => (t === 'index' ? SYNONYM_DF_CEILING + 0.01 : 0.001);
        const { byHead, stats } = buildPhraseMap([pair('Query Understanding', 'Index')], df);
        expect(byHead.size).toBe(0);
        expect(stats.droppedDf).toBe(1);
    });

    it('k>4 target names are rejected (sentence-shaped, not names)', () => {
        const { byHead, stats } = buildPhraseMap([pair('Very Long Plan Name Overflow', 'VL')]);
        expect(byHead.size).toBe(0);
        expect(stats.droppedNotName).toBe(1);
    });
});

// Dictionary shared by the matcher tests.
function pm(pairs: LinkPairCount[]): PhraseSynonymMap {
    return buildPhraseMap(pairs);
}

describe('matchPhrases', () => {
    it('fires on a contained phrase with exact per-token sources', () => {
        const hits = matchPhrases('query understanding roadmap', pm([pair('Query Understanding', 'QU')]));
        expect(hits).toEqual([{ mate: 'qu', sources: ['query', 'understanding'] }]);
    });

    it('longest match wins: the 3-token entry beats its 2-token prefix', () => {
        const dict = pm([
            pair('Creative Knowledge', 'CK'),
            pair('Creative Knowledge Graph', 'CKG'),
        ]);
        expect(matchPhrases('creative knowledge graph plans', dict))
            .toEqual([{ mate: 'ckg', sources: ['creative', 'knowledge', 'graph'] }]);
    });

    it('non-overlapping, left-to-right: a consumed token cannot start a second phrase', () => {
        const dict = pm([
            pair('Alpha Bravo', 'AB'),
            pair('Bravo Charlie', 'BC'),
        ]);
        expect(matchPhrases('alpha bravo charlie', dict))
            .toEqual([{ mate: 'ab', sources: ['alpha', 'bravo'] }]);
    });

    it('adjacent distinct phrases both fire', () => {
        const dict = pm([
            pair('Feature Flags', 'FF'),
            pair('Query Understanding', 'QU'),
        ]);
        expect(matchPhrases('feature flags query understanding', dict)).toEqual([
            { mate: 'ff', sources: ['feature', 'flag'] },
            { mate: 'qu', sources: ['query', 'understanding'] },
        ]);
    });

    it('no partial fire: a lone phrase token or a typo never triggers', () => {
        const dict = pm([pair('Query Understanding', 'QU')]);
        expect(matchPhrases('query roadmap', dict)).toEqual([]);
        expect(matchPhrases('query undersXanding', dict)).toEqual([]);
    });

    it('a stopword BREAKS the adjacency run', () => {
        const dict = pm([pair('Query Understanding', 'QU')]);
        expect(matchPhrases('query of understanding', dict)).toEqual([]);
    });

    it('derived-form isolation: camelCase/glue joins do NOT manufacture adjacency (pins derived:false)', () => {
        // Under derived:true, "QueryUnderstanding" tokenizes to
        // [queryunderstanding, query, understanding] — the ADDITIVE split parts
        // would sit adjacent and fire the phrase from a token the user never
        // typed as two words. The canonical stream keeps it one token.
        const dict = pm([pair('Query Understanding', 'QU')]);
        expect(matchPhrases('QueryUnderstanding roadmap', dict)).toEqual([]);
        // The hyphenated form's CANONICAL split IS two adjacent frags — that
        // one legitimately fires (same enumeration phraseKey used to build it).
        expect(matchPhrases('query-understanding roadmap', dict))
            .toEqual([{ mate: 'qu', sources: ['query', 'understanding'] }]);
    });

    it('a repeated phrase fires its mate once', () => {
        const dict = pm([pair('Query Understanding', 'QU')]);
        expect(matchPhrases('query understanding vs query understanding', dict)).toHaveLength(1);
    });
});

describe('Stage-1 micro-suite (census 2026-07-23)', () => {
    // The census shapes, one dictionary: acronyms of 2–3 caps (QU/FF/SDC/DC),
    // a mixed-case acronym (PsW), a 3-token phrase (CKG).
    const CENSUS: LinkPairCount[] = [
        pair('Query Understanding', 'QU', 70),
        pair('Feature Flags', 'FF', 12),
        pair('Search Discovery Content', 'SDC', 9),
        pair('Photoshop Web', 'PsW', 4),
        pair('Creative Knowledge Graph', 'CKG', 6),
    ];
    const dict = pm(CENSUS);

    it('builds every census pair (no guard misfires on the real shapes)', () => {
        expect(dict.stats.phrases).toBe(5);
        expect(dict.stats.droppedNotName).toBe(0);
        expect(dict.stats.droppedTargetCollision).toBe(0);
    });

    it('forward direction: each spelled-out phrase yields its short form', () => {
        expect(matchPhrases('query understanding eval', dict)[0]?.mate).toBe('qu');
        expect(matchPhrases('feature flags rollout', dict)[0]?.mate).toBe('ff');
        expect(matchPhrases('search discovery content org', dict)[0]?.mate).toBe('sdc');
        expect(matchPhrases('photoshop web launch', dict)[0]?.mate).toBe('psw');
        expect(matchPhrases('creative knowledge graph schema', dict)[0]?.mate).toBe('ckg');
    });

    it('reverse direction does NOT fire — single-token triggers are v1/Stage-2 territory', () => {
        // Stage 1 is phrase-trigger → single-mate ONLY: querying the short form
        // must not phrase-expand ("qu roadmap" injecting "query understanding"
        // would need multi-token mates, which processTerm cannot emit).
        for (const q of ['qu roadmap', 'ff rollout', 'sdc org chart', 'psw launch', 'ckg schema']) {
            expect(matchPhrases(q, dict), q).toEqual([]);
        }
    });

    it('adversarial: a topical (lowercase prose) alias never enters the dictionary', () => {
        const d = pm([...CENSUS, pair('Query Understanding', 'relevance', 30)]);
        const hits = matchPhrases('query understanding eval', d);
        expect(hits).toEqual([{ mate: 'qu', sources: ['query', 'understanding'] }]);
    });

    it('adversarial: an all-generic phrase is refused even at high count', () => {
        const common = new Set(['weekly', 'note']);
        const df = (t: string) => (common.has(t) ? SYNONYM_DF_CEILING + 0.01 : 0.001);
        const d = buildPhraseMap([...CENSUS, pair('Weekly Notes', 'WN', 50)], df);
        expect(matchPhrases('weekly notes review', d)).toEqual([]);
        expect(d.stats.droppedGeneric).toBe(1);
        // ...while the census entries ride through the same df closure.
        expect(matchPhrases('query understanding eval', d)[0]?.mate).toBe('qu');
    });
});
