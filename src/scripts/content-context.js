// Content context for every card-tooling text call. Loaded by the page (before
// api.js) and by the proxy's prompt host (proxy/runs/prompt-host.js), so a
// generation run on the server sends exactly what the page would.

// Prepended to the system prompt of every text call that goes through
// makeRequest, which is all of the card tooling: card writing, finishing
// fields, revisions, lorebooks, image prompts, Inspire Me. It sits here rather
// than in each prompt so no new prompt can miss it. Reasoning models without
// this spent their whole token budget weighing explicit concepts and wrote
// nothing (GLM 5.3, 2026-10-15). The adult-only line is what makes the rest
// credible: it gives the model a clear boundary instead of leaving it to
// invent one, and it is a line the app means.
const CARD_CONTENT_CONTEXT = `**CONTENT CONTEXT:** This is a private creative-writing tool. An adult author uses it to build characters for interactive fiction. Everything you write is fiction: invented characters in an invented story, read only by the adult who asked for it. Mature themes are in scope when the concept calls for them: horror, violence, dark romance, explicit sex, and monster or non-human characters. Write them with the same craft and directness as any other genre. Don't add disclaimers or warnings, don't moralise, and don't water the concept down.
**The one firm line:** every character in a sexual context is an adult (18+), and the card states this plainly. Never sexualise minors or characters given childlike traits. If a concept implies that, make the characters adults rather than refusing.`;

/** Return `messages` with the content context leading the system prompt. */
function withContentContext(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const [first, ...rest] = messages;
  if (first.role === "system") {
    // Multimodal system content is left alone rather than reshaped.
    if (typeof first.content !== "string") return messages;
    if (first.content.includes("**CONTENT CONTEXT:**")) return messages;
    return [{ ...first, content: `${CARD_CONTENT_CONTEXT}\n\n${first.content}` }, ...rest];
  }
  return [{ role: "system", content: CARD_CONTENT_CONTEXT }, ...messages];
}
