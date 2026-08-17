export const meta = {
  name: 'research-storm',
  description: 'Faithful port of Stanford STORM: per-topic personas -> grounded interviews -> two-pass outline -> cited article',
  phases: [
    { title: 'Personas' },
    { title: 'Interviews' },
    { title: 'Outline' },
    { title: 'Draft' },
    { title: 'Polish' },
  ],
}

// Tolerate args arriving as a JSON-encoded string instead of a parsed object
// (observed in practice) as well as the documented plain-object form.
let runArgs = args
if (typeof runArgs === 'string') {
  try {
    runArgs = JSON.parse(runArgs)
  } catch {
    runArgs = {}
  }
}

// Depth presets. "quick" re-enables the source's own `disable_perspective` fast path
// (single basic-writer interview, no persona-discovery call). "standard" matches the
// source's own STORMWikiRunnerArguments defaults exactly. "deep" widens all three.
// maxSections is NOT in the source (real STORM never bounds outline size) -- a labeled
// Cockpit-only cost control, since section count is what actually drives agent count.
const DEPTH_PRESETS = {
  quick: { disablePerspective: true, maxPerspective: 0, maxConvTurn: 2, maxQueriesPerTurn: 2, searchTopK: 2, maxSections: 4 },
  standard: { disablePerspective: false, maxPerspective: 3, maxConvTurn: 3, maxQueriesPerTurn: 3, searchTopK: 3, maxSections: 8 },
  deep: { disablePerspective: false, maxPerspective: 6, maxConvTurn: 4, maxQueriesPerTurn: 4, searchTopK: 4, maxSections: 18 },
}
const preset = DEPTH_PRESETS[runArgs?.depth] ?? DEPTH_PRESETS.standard

const DISABLE_PERSPECTIVE = runArgs?.disablePerspective ?? preset.disablePerspective
const MAX_PERSPECTIVE = runArgs?.maxPerspective ?? preset.maxPerspective
const MAX_CONV_TURN = runArgs?.maxConvTurn ?? preset.maxConvTurn
const MAX_QUERIES_PER_TURN = runArgs?.maxQueriesPerTurn ?? preset.maxQueriesPerTurn
const SEARCH_TOP_K = runArgs?.searchTopK ?? preset.searchTopK
const MAX_SECTIONS = runArgs?.maxSections ?? preset.maxSections
const DEDUP_THRESHOLD = runArgs?.dedupThreshold ?? 6000

const topic = runArgs?.topic
if (!topic) throw new Error('research-storm requires args.topic')

const PERSONA_SCHEMA = {
  type: 'object',
  properties: {
    personas: {
      type: 'array',
      items: { type: 'string' },
      description: 'Each entry: "Name: one-sentence description of what they will focus on"',
    },
  },
  required: ['personas'],
}

const INTERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    transcript: { type: 'string', description: 'Full Q&A transcript, inline [n] citations' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'number' }, url: { type: 'string' } },
        required: ['index', 'url'],
      },
    },
  },
  required: ['transcript', 'citations'],
}

// --- Stage 1: persona discovery (persona_generator.py) ---
// disable_perspective (source's real flag): skip discovery, one basic-writer interview only.
phase('Personas')
let personas
if (DISABLE_PERSPECTIVE) {
  personas = ['Basic fact writer: broad, basic-facts coverage of the topic.']
  log('disablePerspective set -- skipping persona discovery, single basic-writer interview.')
} else {
  const personaResult = await agent(
    `Topic: "${topic}". First, use web search to find a handful of existing overviews/writeups of closely ` +
      `related topics, and note their structure (section headings). Then, in the manner of assembling a group ` +
      `of editors to write a comprehensive article together, propose up to ${MAX_PERSPECTIVE} distinct personas ` +
      `-- each a different perspective, role, or affiliation relevant to researching "${topic}" -- inspired by ` +
      `the structure of those related-topic overviews. For each persona, give a short name and a one-sentence ` +
      `description of what they will focus on.`,
    { label: 'persona-discovery', schema: PERSONA_SCHEMA },
  )
  const discovered = (personaResult?.personas ?? []).slice(0, MAX_PERSPECTIVE)
  personas = ['Basic fact writer: broad, basic-facts coverage of the topic.', ...discovered]
}
log(`${personas.length} personas: ${personas.map((p) => p.split(':')[0]).join(', ')}`)

// --- Stage 2: knowledge curation via simulated conversation (knowledge_curation.py) ---
// Adaptation: the source alternates two distinct LM roles (WikiWriter asks, TopicExpert
// answers) turn by turn. Here one agent per persona runs the same capped, grounded loop
// internally (ask -> real web search -> answer-from-snippets-only-or-refuse -> repeat) --
// behaviorally equivalent, mechanically simpler given agent() is already a full tool-using
// agent, not a bare completion call.
phase('Interviews')
const transcripts = await parallel(
  personas.map((persona) => () =>
    agent(
      `You are an interviewer researching "${topic}" from this specific angle: ${persona}\n` +
        `Ask yourself one focused question at a time, up to ${MAX_CONV_TURN} questions total, each building ` +
        `on what you've learned so far. For each question: break it into up to ${MAX_QUERIES_PER_TURN} web ` +
        `search queries, run them, take the top ${SEARCH_TOP_K} results per query, and answer using ONLY the ` +
        `retrieved snippets, with inline [n] citations mapped to source URLs. If nothing relevant turns up, ` +
        `answer exactly "I cannot answer this question based on the available information" -- never guess or ` +
        `use outside knowledge. Stop early if you have no more useful questions. Return the full transcript ` +
        `(every question and every answer verbatim with its citations) and the citation index-to-URL map.`,
      { label: `interview:${persona.split(':')[0].trim()}`, phase: 'Interviews', schema: INTERVIEW_SCHEMA },
    ).then((t) => (t ? { persona, ...t } : null)),
  ),
)

const liveTranscripts = transcripts.filter(Boolean)
if (liveTranscripts.length === 0) throw new Error('research-storm: all persona interviews failed')

// Adaptation: the source assigns one global per-URL citation number from a shared
// embedding-retrieval index, so every downstream writer already cites consistently -- no
// final remap needed. This port has no such index (each interview names its own LOCAL
// citation numbers), so it builds the same shared per-URL numbering here, once, right
// after interviews complete, and rewrites each transcript's inline [n] markers to match
// before anything downstream (pooling, outline, sections, lead) ever reads them --
// consistency by construction, not a cleanup pass (same prevention-over-lint philosophy
// as /taste's primitives). This replaces the old approach of leaving numbering
// inconsistent until one final LLM pass tried to rewrite the whole draft article to fix it.
// Relies on `parallel()` returning results in input order (Promise.all-style barrier per
// the Workflow tool's documented semantics -- a failed thunk resolves to `null` at its
// same index rather than being dropped, which only makes sense if position is preserved).
// Note this only matters for numbering STABILITY across separate runs of the same topic,
// not correctness within a single run: any consistent assignment order still produces an
// internally-consistent article (Codex review, 2026-07-07).
const globalUrlNumber = new Map()
const numberedUrl = (url) => {
  if (!globalUrlNumber.has(url)) globalUrlNumber.set(url, globalUrlNumber.size + 1)
  return globalUrlNumber.get(url)
}
for (const t of liveTranscripts) {
  const localToGlobal = new Map()
  for (const c of t.citations ?? []) {
    if (c.url) localToGlobal.set(c.index, numberedUrl(c.url))
  }
  t.transcript = t.transcript.replace(/\[(\d+)\]/g, (marker, n) => {
    const global = localToGlobal.get(Number(n))
    return global ? `[${global}]` : marker
  })
}
const citationUrls = [...globalUrlNumber.keys()] // citationUrls[i] is citation number i+1

const pooled = liveTranscripts
  .map((t) => `--- Persona: ${t.persona} ---\n${t.transcript}`)
  .join('\n\n')

// --- Stage 3: outline generation (outline_generation.py) ---
// Pass 1: naive outline from parametric knowledge only, no research.
phase('Outline')
const naiveOutline = await agent(
  `Write a section-heading-only outline (markdown "#"/"##"/"###") for a comprehensive article on "${topic}", ` +
    `from your own knowledge alone -- do not search. Do not include the topic name itself as a heading. ` +
    `Headings only, no body text, no other commentary.`,
  { label: 'outline-naive' },
)

// Pass 2: refine using the full pooled research from every persona.
const outline = await agent(
  `Draft outline for "${topic}":\n${naiveOutline}\n\n` +
    `Research gathered from ${liveTranscripts.length} independent interviews, each from a different angle:\n${pooled}\n\n` +
    `Refine the draft outline to be more informative given this research -- add, remove, or reorganize ` +
    `sections as warranted, but produce AT MOST ${MAX_SECTIONS} top-level sections total (merge related ` +
    `sections rather than exceeding this). Same markdown-heading-only format: no body text, no topic name as ` +
    `a heading, no other commentary.`,
  { label: 'outline-refined' },
)

// --- Stage 4: article generation (article_generation.py) ---
// Adaptation: the source retrieves per-section top-k snippets via an embedding index
// (retrieve_top_k). No vector store here, so each section-writing agent reads the full
// pooled transcript and does its own relevance judgment instead of a separate retrieval pass.
phase('Draft')
let sectionTitles = outline
  .split('\n')
  .filter((line) => /^#\s+/.test(line))
  .map((line) => line.replace(/^#\s+/, '').trim())
  .filter((title) => title.length > 0 && !/^(introduction|conclusion|summary)/i.test(title))

if (sectionTitles.length === 0) {
  log('No parseable outline sections -- falling back to a single section on the raw topic.')
  sectionTitles = [topic]
}
if (sectionTitles.length > MAX_SECTIONS) {
  log(`Outline produced ${sectionTitles.length} sections, over the ${MAX_SECTIONS} cap -- trimming (Cockpit-only cost control, not in the source algorithm).`)
  sectionTitles = sectionTitles.slice(0, MAX_SECTIONS)
}

const sections = await parallel(
  sectionTitles.map((title) => () =>
    agent(
      `Topic: "${topic}". Write the "${title}" section of the article, drawing only from this research ` +
        `(collected from independent interviews):\n${pooled}\n\n` +
        `The research already uses one consistent inline [n] numbering (the same URL always gets the same ` +
        `number, everywhere). For every claim, reuse the exact [n] already attached to it in the source text ` +
        `above -- never invent a new number or renumber. Start with "# ${title}" and write only this section ` +
        `-- no other sections, no page title, no commentary.`,
      { label: `section:${title}`, phase: 'Draft' },
    ).then((content) => (content ? { title, content } : null)),
  ),
)

const liveSections = sections.filter(Boolean)
if (liveSections.length === 0) throw new Error('research-storm: all section drafts failed')
const draftBody = liveSections.map((s) => s.content).join('\n\n')

// --- Polish (article_polish.py) ---
phase('Polish')
const lead = await agent(
  `Write a concise lead/summary section (no more than 4 paragraphs) for this article on "${topic}", standing ` +
    `on its own as an overview. Reuse the exact same [n] citation numbers already used below for the same ` +
    `claims -- never invent a new number or renumber:\n\n${draftBody}`,
  { label: 'lead-section', phase: 'Polish' },
)

let body = draftBody
if (draftBody.length > DEDUP_THRESHOLD) {
  const deduped = await agent(
    `You are a faithful text editor. Find repeated information across sections of this article and delete ` +
      `the repeats. Do not delete any non-repeated content. Keep the heading structure ("#", "##", etc.) intact ` +
      `and every inline citation exactly as numbered -- do not renumber or alter any citation marker:\n\n${draftBody}`,
    { label: 'dedup-pass', phase: 'Polish' },
  )
  if (deduped) body = deduped
}

// Fix (was the pipeline's single point of failure -- found 2026-07-06): citations are
// globally consistent by construction now (the Interviews-stage remap above), so
// unifying is pure bookkeeping, not a judgment call -- compact to only the numbers
// actually used in the final article, renumbered in order of first appearance, and emit
// the References list. No agent call: no cost, no last-in-pipeline quota/session failure
// mode. `lead` and `body` are compacted TOGETHER (Codex review, 2026-07-07): compacting
// `body` alone and only then prefixing `lead` would leave lead's citations on stale
// pre-compaction global numbers, inconsistent with the renumbered body.
log('Citation unification is a deterministic pass (no LLM call) -- see workflow.mjs comment.')
const combined = `${lead}\n\n${body}`
const usedGlobalNumbers = []
const strayMarkers = []
const compactNumber = new Map()
const compactedCombined = combined.replace(/\[(\d+)\]/g, (marker, n) => {
  const global = Number(n)
  if (global < 1 || global > citationUrls.length) {
    strayMarkers.push(marker) // no known source URL -- an agent likely invented this number
    return marker
  }
  if (!compactNumber.has(global)) {
    compactNumber.set(global, compactNumber.size + 1)
    usedGlobalNumbers.push(global)
  }
  return `[${compactNumber.get(global)}]`
})
const references = usedGlobalNumbers.map((global, i) => `${i + 1}. ${citationUrls[global - 1]}`).join('\n')
if (strayMarkers.length > 0) {
  log(
    `Warning: ${strayMarkers.length} citation marker(s) (${[...new Set(strayMarkers)].join(', ')}) matched no ` +
      `known source URL -- left as-is in the article text, not included in References. Likely a drafting agent ` +
      `invented a number; spot-check the article before treating it as fully verified.`,
  )
}

const article = usedGlobalNumbers.length > 0
  ? `# summary\n${compactedCombined}\n\n## References\n${references}`
  : `# summary\n${compactedCombined}`

return {
  topic,
  depth: runArgs?.depth ?? 'standard',
  article,
  personas,
  sectionTitles,
  interviewCount: liveTranscripts.length,
  sectionCount: liveSections.length,
}
