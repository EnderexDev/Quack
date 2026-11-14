// What the AI merge card decides from the hub's /api/ai answer, apart from the DOM so a test can
// run it in node. An older hub sends no model lists: the card then keeps its read-only pill.

/**
 * The model choice for the AI in use, or null (no AI in use, or a hub without the lists):
 * the field the hub saves it in, the saved value and the options, the saved one marked. Codex's
 * own default is the value "" and comes first. A model set by hand in config.json and missing
 * from the list marks nothing.
 */
export function modelChoice(ai) {
  const provider = ai?.effective?.provider;
  const models = provider ? ai.detected?.[provider]?.models : undefined;
  if (!Array.isArray(models)) return null;
  const field = provider === "claude" ? "model" : "codexModel";
  const current = ai.settings?.[field] ?? "";
  const values = provider === "codex" ? ["", ...models] : models;
  return { provider, field, current, options: values.map((value) => ({ value, on: value === current })) };
}

/** What the pill shows: the saved model, or the one the AI uses ("" when even that is unknown) */
export function modelPill(ai) {
  const provider = ai?.effective?.provider;
  if (!provider) return "";
  const saved = ai.settings?.[provider === "claude" ? "model" : "codexModel"];
  return saved || ai.detected?.[provider]?.model || "";
}

/** A model's name in the menu: Claude's aliases capitalized, Codex's slugs as they are */
export function modelLabel(value) {
  return /^(sonnet|opus|haiku)$/.test(value) ? value[0].toUpperCase() + value.slice(1) : value;
}
