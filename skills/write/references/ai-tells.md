# AI-Tells Rubric (living document)

Curated from a 2026-07 web research pass (sources inline). Used by /write step 5: audit every
draft against this before presenting. Refresh on evidence, not vibes; lists churn as models change.

## a. How to use

Clustering, not single tells. No single tell proves AI authorship; confidence rises when
several signals co-occur within a few hundred words (the "3+" number is folklore, the clustering
logic is sound). A lone "robust" or one tidy triad is a weak signal. As a provisional editing
heuristic, not a binding threshold: when roughly three or more tell classes co-occur in one
paragraph, rewrite that passage. Also remember the bias caveat: many tells
false-positive on ESL and formal human writing, so treat this as a rewrite aid, never a verdict.
(matthewvollmer.substack.com "A Field Guide to AI Tells"; gptzero.me)

## b. Lexical kill list

**Well-evidenced (peer-reviewed corpus shift, ACL/COLING 2025 aclanthology.org/2025.coling-main.426/, arXiv 2412.11385, news.fsu.edu 2025/02/17):**
the paper's ~21 focal words, delve class: delve, intricate, underscore, pivotal, meticulous(ly),
realm, navigate (figurative), showcasing, commendable, adept, and kin. Scope caveat: the corpus
evidence covers scientific abstracts specifically; transfer to posts, articles, and newsletters is
assumed here, not established.

**Consensus, not rigorous (widely cross-referenced practitioner lists):** tapestry, resonate,
testament, compelling, paramount, crucial, foster, elevate, robust, seamless(ly), vibrant, dynamic,
comprehensive, multifaceted, nuanced, holistic, cutting-edge, transformative, groundbreaking,
unparalleled, innovative, leverage, utilize, harness, streamline, facilitate, optimize, empower,
illuminate, bolster, unlock (walterwrites.ai; alstonantony.com). The tapestry-class prestige metaphor
nouns: landscape, mosaic, ecosystem, symphony, labyrinth, beacon, cornerstone, bedrock, cacophony,
kaleidoscope, odyssey (matthewvollmer.substack.com). Signposting clichés: "It's important to note",
"When it comes to", "In today's fast-paced world", "At its core", "At the end of the day",
"Let's unpack this", "One of the most [important/crucial]..." (kompozy.io/brand-voice/banned-words;
useaiwriter.com/articles/ai-words-to-avoid-2026).

**Outdated/churning:** "boasts" was a GPT-4 era flag, reportedly no longer overrepresented;
"underscore" climbing (walterwrites.ai/most-common-chatgpt-words-to-avoid/). Causal stories for
the lexical shift (RLHF annotators etc.) are unconfirmed folklore (ACL/COLING 2025 tested and
found no clean cause).

## c. Syntactic and structural tells

- **Contrastive binary "it's not X, it's Y"**: well evidenced, genre-inherited from
  LinkedIn/TED-style RLHF preference data; Claude leads in this pattern (refsmmat.com/notebooks/llm-style.html;
  linkandth.ink/p/catalog-of-claude-cliches, code [CB]).
- **Tricolon / rule of three** ("Fast. Simple. Effective."), often negated ("No fluff. No filler.
  No stress."): consensus across nearly every source (matthewvollmer; github.com/avectats7/anti-ai-writing).
- **Uniform sentence rhythm / low burstiness**: real average tendency, weak as a single signal;
  vary sentence length deliberately (see section e).
- **Mechanical hedging**: LLMs are flatly assertive on stance overall, but Claude specifically
  sprinkles uniform local hedges ("almost", "tends to", "roughly"): Claude-specific, linkandth.ink
  "Reflexive hedging"; refsmmat.
- **Aphoristic enders / tidy summary conclusions**: Claude-tagged [AE] (linkandth.ink; matthewvollmer).
- **Listicle-itis / five-paragraph default**: intro + rule-of-three body + recap regardless of
  genre; bullets and bolded headers for non-list ideas (matthewvollmer).
- **Over-signposting**: "First... Second... Finally"; Claude-specific meta-signposting [MS]
  (narrating the structure) and significance-signaling [SS] ("This matters because...") (linkandth.ink).
- **"In conclusion" class openers/closers**: consensus folklore, on every banned list.

## d. Discourse tells

- **Mirrored-clause symmetry**: parallel grammatical frames with swapped elements; Claude-tagged
  [MCS] (linkandth.ink).
- **Both-sides-ism / false concession**: "While critics argue X, supporters maintain Y. The truth
  lies somewhere between." Appearance of nuance while avoiding commitment (matthewvollmer).
- **Strategic vagueness / no first-person specificity**: arguably the single most cited discourse
  tell: generic nouns, hypothetical examples, no proper names, dates, places, or brand-specific
  detail (matthewvollmer). The fix is upstream: front-load real material (skill step 3).
- **Flat affect / uniform register**: no emotional variance across a piece (matthewvollmer; refsmmat).
- **No digressions**: tidy single-track structure; human writing tolerates ambiguity, asides, and
  temporal messiness (refsmmat; arXiv 2604.03136).

## e. Outdated or contested

- **Em-dash as a reliable signal**: real 2023 to 2025, weakened by 2025 to 2026 (OpenAI shipped a
  suppression fix Nov 2025; public pushback that em-dashes are legitimate human punctuation).
  Model nuance: ChatGPT additive em-dashes, Claude mid-sentence asides, Gemini suppresses. Treat
  "em-dash = AI" as folklore for late-2025+ text (Rolling Stone; techbuzz.ai; theringer.com 2025/08/20).
  Note: the cockpit bans dash punctuation for its own style reasons regardless, so this stays a
  rewrite target here either way.
- **Raw perplexity/burstiness as a detection method**: GPTZero moved off it after autumn 2023;
  detectors degrade badly against lightly modified AI text (average accuracy falls from 39.5% to 17.4%) and
  false-positive on ESL and formal human writing (gptzero.me/news/how-ai-detectors-work;
  pangram.com/blog/why-perplexity-and-burstiness-fail-to-detect-ai; arXiv 2310.05030; PMC12331776).
  This is also why the skill never chases detector scores.

## f. Living-list note

Word and phrase lists churn as models change ("boasts" already rotated out). Mature banned-word
guides converge on 150 to 250 entries after ~6 months of refinement (kompozy.io). Refresh this file
periodically on corpus evidence; the best-evidenced tell class overall remains the delve-class
word-frequency shift (ACL/COLING 2025). Useful public references: github.com/avectats7/anti-ai-writing
(MIT, most directly reusable); linkandth.ink "22 Claude Clichés" (best Claude-specific taxonomy);
matthewvollmer.substack.com (richest structured field guide).
