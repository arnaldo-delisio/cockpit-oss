# Voice Craft (profile, seeding, calibration)

Distilled from a 2026-07 web research pass (sources inline). Used by /write steps 2, 4, and 6:
the voice layer that accretes. The profile itself is data, so it lives in your memory repo as
`voice.md` inside whichever scope holds your personal writing (`memory/scopes/<scope>/voice.md`),
never in the engine tree.

## a. Evidence base in brief

- Few-shot examples beat abstract style descriptions: 2 to 5 concrete on-voice samples over
  adjective lists; returns diminish past ~5 to 10; representativeness beats quantity
  (aiforanything.io; datacamp.com few-shot tutorial).
- Load-bearing finding: naive few-shot imitation fails hardest on informal personal genres.
  arXiv 2509.14543 ("Catch Me If You Can? Not Yet") tested GPT-4o, Gemini-2.0-Flash,
  Llama-4-Maverick, DeepSeek-V3 imitating everyday authors: strong on formal genres (email
  verification ~96%) but ~19 to 21% on informal blogs, with minimal gain from 2 to 10 shots.
  Founder content is exactly this regime, so the audit and rewrite pass (skill step 5) is
  mandatory, not optional.
- Fine-tuning only wins with a large corpus; not viable for a founder with no published articles
  (arXiv 2606.16778; prompthub.us).

## b. The voice profile artifact

The ghostwriting-standard voice bible (rivereditor.com how-ghostwriters-capture-client-voice),
one page cap:
- 20 to 30 direct quotes from relaxed storytelling moments (the ground truth everything else is
  built from, never invented adjectives).
- Distinctive recurring phrases and verbal tics.
- Vocabulary, including never-words (words he never uses).
- Emotional tone description; preferred metaphor domains.
- Topic gravity: themes he keeps returning to.
- Contrarian claims he actually holds (so drafts keep them strong).

## c. Seeding from chat/speech (no published writing exists)

- **Register bridging is the core move.** Spoken/chat register differs systematically from
  written (fillers, false starts, backchannels, repetition); raw transcript few-shots carry these
  inappropriately, while generic cleaning strips the authentic texture (ISCA Interspeech 2025;
  arXiv 2408.09688). Curate and upgrade spoken patterns into written-informal: neither raw dumps
  nor sanitized prose.
- **Extraction targets** (foundera.co/blog/founder-voice-ai-content-authenticity, single
  practitioner source, candidate procedure not gospel): vocabulary signatures (words favored over
  synonyms), sentence-rhythm mapping (fragments vs staccato vs long clauses), register and
  code-switching patterns, topic gravity, contrarian claims and verbal tics.
- **Elicit via storytelling questions, not reflective ones.** "Take me to the day you decided to
  start the company", not "what does leadership mean to you": reflective/meaning questions trigger
  a formal un-voice-like register; voice comes out truest in relaxed storytelling
  (rivereditor.com; nicolascole77.medium.com).

## d. The calibration loop

Generate 2 to 3 short variants per piece early; have the author mark WHICH LINE feels wrong and why,
not thumbs up or down; fold the marks into the profile, which accretes over runs (the standard
ghostwriting draft, feedback, refine-profile loop; rivereditor.com). Forced-choice ("which of A/B
is closer to my voice") beats open-ended rating (marktechpost.com Bayesian preference elicitation;
arXiv 2606.31371).

## e. The edit workflow

Generate, then audit against the profile and `ai-tells.md`, then rewrite mismatched lines (expect
a meaningful fraction; the single Foundera source reports 30 to 50% of a first draft), then
strengthen contrarian positions the model softened, then read aloud for rhythm, targeting
self-recognition ("that sounds like me", practitioner bar ~80%) (foundera.co). AI-assisted, not AI-generated: real stories and
opinions go in before generation, every call (forbes.com/sites/jodiecook 2026/06).

## f. Why no humanizer pass

StealthGPT/Undetectable-class tools target detector statistics (perplexity, burstiness) by
injecting unpredictability, not voice fidelity; content drifts semantically while "reading human"
(stealthgpt.ai). Optimizing a detector proxy is a different objective from sounding like a person,
and detectors themselves are unreliable and biased (see ai-tells.md section e). The fix is
grounding generation in real voice material plus the manual audit pass, never post-hoc obfuscation.
