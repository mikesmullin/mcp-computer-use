const object = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const string = (maxLength = 16000) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const enumeration = (...values) => ({ type: "string", enum: values });
const array = (items, minItems = 1, maxItems = 100) => ({
  type: "array",
  items,
  minItems,
  maxItems,
});
const windowId = { ...string(16), pattern: "^[1-9][0-9]*$" };
const selector = {
  oneOf: [object({ id: integer(1, 1000000) }), object({ label: string(2000) })],
};
const refProps = { observationId: string(100), target: selector };
const ref = object(refProps);
const image = { oneOf: [object({ imageId: string(100) }), ref] };
const question = {
  oneOf: [
    object({ type: enumeration("boolean"), prompt: string() }),
    object({
      type: enumeration("choice"),
      prompt: string(),
      options: array(object({ id: string(100), label: string() }), 2),
    }),
    object({
      type: enumeration("score"),
      prompt: string(),
      levels: array(string(), 2),
    }),
  ],
};
export const definitions = {
  window_list: ["List window IDs and titles.", object({})],
  window_observe: [
    "Discover DOM and OCR targets automatically. Choose a numeric ID or an exact unique label; observations expire after 120 seconds or a window action. Narrow filter if truncated.",
    object(
      {
        windowId,
        filter: { type: "string", maxLength: 1000 },
        limit: integer(1, 300),
      },
      ["windowId"],
    ),
  ],
  browser_page_find: [
    "Search the currently loaded browser document, including offscreen elements. Hidden elements are excluded. Use nextOffset to paginate; each result has its own observationId.",
    object(
      {
        windowId,
        filter: { type: "string", maxLength: 1000 },
        fields: array(
          enumeration("text", "accessible_name", "alt", "title"),
          1,
          4,
        ),
        scope: enumeration("viewport", "loaded_document"),
        offset: integer(0, 10000),
        limit: integer(1, 300),
      },
      ["windowId", "filter"],
    ),
  ],
  browser_screenshot: [
    "Capture browser content for vision. Full-page means currently loaded content; inspect coverage and truncation.",
    object({ windowId, scope: enumeration("viewport", "full_page") }, [
      "windowId",
    ]),
  ],
  image_crop: [
    "Crop captured target pixels using server-selected bounds. Offscreen targets must first be revealed with window_scroll and re-observed.",
    object(
      { ...refProps, context: enumeration("tight", "surrounding") },
      Object.keys(refProps),
    ),
  ],
  describe_image: [
    "Ask the configured Liquid CPU vision model about an image or target crop. Descriptions can be wrong; they never create click targets.",
    object({ image, prompt: string() }),
  ],
  decide: [
    "Ask H2O for a boolean probability, choice, or ordered score. Image is optional for text-only decisions. Model scores are not proof.",
    object({ system_prompt: string(), image, question }, ["question"]),
  ],
  window_click: [
    "Revalidate and click a target using native independent-pointer input. Browser targets are automatically scrolled into view. Returns a fresh observation; input_sent does not prove success.",
    object(
      {
        ...refProps,
        button: enumeration("left", "right", "middle"),
        count: { type: "integer", enum: [1, 2] },
      },
      Object.keys(refProps),
    ),
  ],
  window_type: [
    "Focus an editable DOM target, verify field focus, then type. Default replaces existing text; append inserts at the cursor. OCR-only targets cannot verify field focus and are rejected.",
    object(
      {
        ...refProps,
        text: string(4000),
        mode: enumeration("replace", "append"),
      },
      [...Object.keys(refProps), "text"],
    ),
  ],
  window_scroll: [
    "Reveal a DOM target automatically, or scroll natively within a target/window. target and within are mutually exclusive. Defaults to a small downward scroll.",
    object(
      {
        windowId,
        target: ref,
        within: ref,
        direction: enumeration("up", "down", "left", "right"),
        amount: enumeration("small", "page"),
      },
      ["windowId"],
    ),
  ],
  window_key: [
    'Send ordered key chords (for example ["Ctrl+l", "Escape"]). Optional focusTarget must belong to this window and support verifiable DOM focus.',
    object({ windowId, keys: array(string(64), 1, 20), focusTarget: ref }, [
      "windowId",
      "keys",
    ]),
  ],
};
export const instructions =
  "Use window_list then window_observe. Select observation-scoped target IDs or exact unique labels; never calculate coordinates. Browser clicks reveal offscreen targets automatically. Use the new observation after every action. Ambiguous, stale, blocked, or unverifiable targets are rejected. Input delivery is not proof of application success. Vision outputs are evidence, not actionable targets. No tool starts or restarts inference services.";
export function targetTools(api) {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, [description, inputSchema]]) => [
      name,
      {
        description,
        inputSchema,
        handler: async (args) => {
          const result = await api[name](args);
          const imageId = result.imageId || result.observation?.imageId;
          const content = [{ type: "text", text: JSON.stringify(result) }];
          if (imageId) {
            try {
              content.push({
                type: "image",
                mimeType: "image/png",
                data: await api.imageContent(imageId),
              });
            } catch {
              content.push({
                type: "text",
                text: "Image attachment unavailable; the result above still describes any input already sent. Capture again if needed.",
              });
            }
          }
          return { content };
        },
      },
    ]),
  );
}
