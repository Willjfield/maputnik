import cloneDeep from "lodash.clonedeep";
import { applyPatch, type Operation } from "fast-json-patch";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecificationWithId } from "./definitions";

const STYLE_SPEC_REF = "https://maplibre.org/maplibre-style-spec/";

/** System prompt for patch mode: model returns only a JSON Patch (RFC 6902) array. */
function getSystemPromptPatch(hasImage?: boolean): string {
  const base = `You edit MapLibre GL map styles. You receive the current style JSON and a user request. Return ONLY a JSON Patch (RFC 6902) array that, when applied to the style, makes the requested change.

Rules:
- Start your response with the character [. Output nothing but a JSON array of patch operations—no introductory text, explanation, or commentary before or after the array. Example: [{"op":"replace","path":"/layers/roads_minor/paint/line-color","value":"#d8d8d8"}]
- Paths use JSON Pointer with layer id (not index): /layers/<layer_id>/paint/line-color, e.g. /layers/roads_minor/paint/line-color or /layers/landuse_park/paint/fill-color. We resolve layer id to index automatically. The path must end at a property name. Never use array indices on property values (no /paint/line-color/0 or /3). Paint properties like line-color, fill-color are strings or expressions; set the whole value with one replace/add.
- Use "replace" for existing properties, "add" for new ones. For paint or layout properties that may be missing (e.g. line-dasharray, line-cap), use "add" so the patch works whether the property exists or not. Preserve id, sources, glyphs, sprite unless the user asks to change them.
- For label overlap: adjust symbol layers' layout/paint (text-size, text-max-width, text-optional, symbol-spacing, text-allow-overlap). Spec: ${STYLE_SPEC_REF}
- Only include operations that change something.`;
  if (hasImage) {
    return `${base}

When the user attaches a reference map image: analyze the image and produce a JSON Patch that makes the current style match the look of that map as much as possible. Consider colors (water, land, roads, labels), road prominence and line widths, label density and styling, and overall visual style.`;
  }
  return base;
}

/**
 * Rewrite paths like /layers/<layer_id>/... to /layers/<index>/... using the style's layers.
 * If the path already uses a numeric index, leave it unchanged.
 */
function resolveLayerIdsInPatch(
  style: StyleSpecificationWithId,
  patch: Operation[],
): Operation[] {
  const layers = style.layers;
  if (!Array.isArray(layers)) return patch;
  const idToIndex = new Map<string, number>();
  layers.forEach((layer, i) => {
    const id = (layer as { id?: string }).id;
    if (typeof id === "string") idToIndex.set(id, i);
  });
  return patch.map((op) => {
    const path = op.path;
    if (typeof path !== "string" || !path.startsWith("/layers/")) return op;
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length < 2 || segments[0] !== "layers") return op;
    const layerSegment = segments[1];
    const layerSegmentDecoded = layerSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/^\d+$/.test(layerSegmentDecoded)) return op;
    const index = idToIndex.get(layerSegmentDecoded);
    if (index === undefined) return op;
    const rest = segments.slice(2).join("/");
    const newPath = "/layers/" + String(index) + (rest ? "/" + rest : "");
    return { ...op, path: newPath };
  });
}

export type AttachedImage = {
  dataBase64: string;
  mediaType: string;
};

export type EditStyleParams = {
  style: StyleSpecificationWithId;
  prompt: string;
  image?: AttachedImage;
  apiKey?: string;
  apiUrl?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  mapContext?: string;
};

export type EditStyleResult =
  | { ok: true; style: StyleSpecificationWithId; explanation?: string }
  | { ok: false; error: string };

/**
 * Extract the assistant's reply from Anthropic Messages API response.
 */
function getTextFromAnthropicResponse(data: { content?: Array<{ type?: string; text?: string }> }): string | null {
  const blocks = data.content;
  if (!Array.isArray(blocks)) return null;
  const parts = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return parts.length > 0 ? parts.join("") : null;
}

/** True if the object looks like the API wrapper, not a style. */
function isApiWrapper(obj: object): boolean {
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.content) && typeof o.usage === "object" && typeof o.model === "string";
}

/** Try to parse JSON from text (array or object); strip markdown code fence if present. */
function parseJsonFromResponse(raw: string): unknown {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  const jsonString = jsonMatch ? jsonMatch[1] : trimmed;
  return JSON.parse(jsonString);
}

/**
 * Extract a JSON Patch array from text that may contain prose before/after.
 * The model sometimes returns explanation + patch; we find the array that looks like
 * [{"op":"replace",...}] by locating the start and bracket-matching.
 */
function extractPatchArrayFromText(raw: string): string | null {
  const trimmed = raw.trim();
  const startMatch = trimmed.match(/\[\s*\{\s*\\?["']op["']/);
  if (!startMatch || startMatch.index === undefined) return null;
  const start = startMatch.index;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

/** If the model included prose before the patch, return it (trimmed, length-limited). */
function extractProseBeforePatch(raw: string): string | null {
  const trimmed = raw.trim();
  const startMatch = trimmed.match(/\[\s*\{\s*\\?["']op["']/);
  if (!startMatch || startMatch.index === undefined) return null;
  const prose = trimmed.slice(0, startMatch.index).trim();
  if (!prose) return null;
  const maxLen = 800;
  return prose.length <= maxLen ? prose : prose.slice(0, maxLen) + "…";
}

/** Get a value from an object by JSON Pointer; supports ~0 and ~1 escaping. */
function getValueByJsonPointer(obj: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(seg)) {
      current = current[parseInt(seg, 10)];
    } else if (typeof current === "object" && seg in (current as object)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Resolve /layers/<id>/... to /layers/<index>/... using style.layers, then get value. */
function getStyleValueAtPath(style: StyleSpecificationWithId, pointer: string): unknown {
  const layers = style.layers;
  if (!Array.isArray(layers)) return getValueByJsonPointer(style, pointer);
  const segments = pointer
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (segments[0] !== "layers" || segments.length < 2) return getValueByJsonPointer(style, pointer);
  const layerKey = segments[1];
  let layerIndex: number;
  if (/^\d+$/.test(layerKey)) {
    layerIndex = parseInt(layerKey, 10);
  } else {
    const idx = layers.findIndex((l) => (l as { id?: string }).id === layerKey);
    if (idx < 0) return undefined;
    layerIndex = idx;
  }
  const resolved = "/layers/" + layerIndex + (segments.length > 2 ? "/" + segments.slice(2).join("/") : "");
  return getValueByJsonPointer(style, resolved);
}

const MAX_VALUE_DISPLAY = 120;

function formatValueForDisplay(value: unknown): string {
  if (value === undefined) return "(none)";
  if (value === null) return "null";
  const str = typeof value === "object" ? JSON.stringify(value) : String(value);
  return str.length <= MAX_VALUE_DISPLAY ? str : str.slice(0, MAX_VALUE_DISPLAY) + "…";
}

/**
 * Build before/after values for each patch op so the accessibility evaluator can assess concrete changes.
 */
function formatPatchBeforeAfter(patch: Operation[], style: StyleSpecificationWithId): string {
  const layers = style.layers;
  if (!Array.isArray(layers)) return "";
  const entries: Array<{ layerId: string; propPath: string; before: string; after: string }> = [];
  for (const op of patch) {
    if (!op.path || typeof op.path !== "string" || !op.path.startsWith("/layers/")) continue;
    const segments = op.path.slice(1).split("/").filter(Boolean);
    if (segments.length < 3) continue;
    const layerKey = segments[1].replace(/~1/g, "/").replace(/~0/g, "~");
    const propPath = segments.slice(2).join(".");
    const layerIndex = /^\d+$/.test(layerKey) ? parseInt(layerKey, 10) : -1;
    const layerId =
      layerIndex >= 0 && layers[layerIndex]
        ? String((layers[layerIndex] as { id?: string }).id ?? layerKey)
        : layerKey;
    const before = getStyleValueAtPath(style, op.path);
    const after =
      op.op === "remove" ? "(removed)" : "value" in op ? formatValueForDisplay(op.value) : "(unknown)";
    entries.push({
      layerId,
      propPath,
      before: formatValueForDisplay(before),
      after,
    });
  }
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `• ${e.layerId} ${e.propPath}: ${e.before} → ${e.after}`);
  return "Before/after values:\n" + lines.join("\n");
}

/**
 * Build a short summary of which layers and properties were changed by the patch.
 */
function summarizePatch(patch: Operation[], style: StyleSpecificationWithId): string {
  const layers = style.layers;
  if (!Array.isArray(layers)) return "";
  const byLayer = new Map<string, string[]>();
  for (const op of patch) {
    if (!op.path || typeof op.path !== "string" || !op.path.startsWith("/layers/")) continue;
    const segments = op.path.split("/").filter(Boolean);
    if (segments.length < 3) continue;
    const layerKey = segments[1];
    const propPath = segments.slice(2).join(".");
    const layerIndex = /^\d+$/.test(layerKey) ? parseInt(layerKey, 10) : -1;
    const layerId =
      layerIndex >= 0 && layers[layerIndex]
        ? (layers[layerIndex] as { id?: string }).id
        : layerKey;
    const id = typeof layerId === "string" ? layerId : layerKey;
    const list = byLayer.get(id) ?? [];
    if (!list.includes(propPath)) list.push(propPath);
    byLayer.set(id, list);
  }
  if (byLayer.size === 0) return "";
  const lines = Array.from(byLayer.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, props]) => `• ${id}: ${props.join(", ")}`);
  return "Layers changed:\n" + lines.join("\n");
}

const ANTHROPIC_PROXY_PATH = "/api/anthropic/messages";

/** Default to Haiku for lower cost/latency; override with VITE_ANTHROPIC_MODEL. */
const DEFAULT_MODEL = "claude-3-5-haiku-latest";
/** Allow long patches (e.g. many layers); increase if responses are truncated (stop_reason: max_tokens). */
const PATCH_MAX_TOKENS = 8192;
const EVAL_MAX_TOKENS = 1024;

/**
 * Call Anthropic Messages API with a custom system and single user message; return assistant text.
 */
async function anthropicMessage(params: {
  system: string;
  userMessage: string;
  apiKey?: string;
  apiUrl?: string;
  maxTokens?: number;
}): Promise<string | null> {
  const {
    system,
    userMessage,
    apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined,
    apiUrl = (import.meta.env.VITE_ANTHROPIC_API_URL as string | undefined) || (import.meta.env.DEV ? ANTHROPIC_PROXY_PATH : "https://api.anthropic.com/v1/messages"),
    maxTokens = EVAL_MAX_TOKENS,
  } = params;
  const useProxy = apiUrl.startsWith("/");
  if (!useProxy && !apiKey?.trim()) return null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (!useProxy && apiKey) headers["x-api-key"] = apiKey;
  const body = {
    model: (import.meta.env.VITE_ANTHROPIC_MODEL as string | undefined) || DEFAULT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user" as const, content: userMessage }],
  };
  try {
    const res = await fetch(apiUrl, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = await res.json();
    return getTextFromAnthropicResponse(data);
  } catch {
    return null;
  }
}

const NEUTRAL_DISCLAIMER =
  "I didn't find any significant benefit or downside in accessibility from these style changes but I can get things wrong. I'm not perfect but my goal is to raise the bar on what to expect in terms of accessibility, not to reach where it actually should be on my own. We'll never get to where things ought to be, and can be, without sustained human attention to the problem.";

/**
 * Evaluate the accessibility impact of a style change. The model uses its own knowledge
 * of accessibility standards (e.g. WCAG, W3C WAI) and is instructed to cite sources when possible.
 */
export async function evaluateAccessibilityImpact(params: {
  patchSummary: string;
  beforeAfterValues?: string;
  mapContext?: string;
  apiKey?: string;
  apiUrl?: string;
}): Promise<string> {
  const { patchSummary, beforeAfterValues, mapContext, apiKey, apiUrl } = params;

  const system =
    "You evaluate map style changes for accessibility impact. Use your knowledge of web and map accessibility (e.g. WCAG 2, W3C WAI, cartographic accessibility). When making recommendations, cite specific guidelines or criteria where possible (e.g. \"WCAG 1.4.3 Contrast (Minimum)\", \"WCAG 1.4.12 Text Spacing\", or \"W3C WAI – [topic]\"). If you reference a standard, include the full name or a stable URL so the user can look it up. Use the before/after values provided to assess concrete impact (e.g. smaller text, lower contrast, removed halos) rather than guessing.";

  const userParts = [
    "Style change summary:\n" + patchSummary,
    ...(beforeAfterValues ? [beforeAfterValues] : []),
    "Evaluate this change for accessibility impact. Reply with one of:",
    "1) NEGATIVE: If the change could make the map harder to use (e.g. thinner labels, less contrast, reduced spacing). Give a short explanation, cite the relevant guideline or standard when possible, and suggest 1–2 more accessible alternatives.",
    "2) POSITIVE: If the change improves accessibility. Short note and citation where applicable.",
    `3) NEUTRAL: If no significant benefit or downside. Use this exact wording: ${NEUTRAL_DISCLAIMER}`,
  ];
  if (mapContext?.trim()) userParts.unshift("Map context (purpose and users):\n" + mapContext.trim());
  const userMessage = userParts.join("\n\n");

  const text = await anthropicMessage({ system, userMessage, apiKey, apiUrl });
  if (!text?.trim()) return "";
  return text.trim();
}

/**
 * Extract map purpose and user needs from the first 1–3 turns of the conversation.
 */
export async function extractMapContext(params: {
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  apiKey?: string;
  apiUrl?: string;
}): Promise<string | null> {
  const { conversationHistory, apiKey, apiUrl } = params;
  const recent = conversationHistory.slice(-6);
  if (recent.length === 0) return null;
  const system =
    "From this conversation about a map style, extract in one short paragraph only if the user has actually described: (1) what this map is for, (2) who the users are and what they need, and/or (3) why the map is being made, what problems it may be solving, or what questions it may be answering. If the user has not shared any of that—e.g. they only asked for a style change like 'make roads red'—output nothing (empty). Output only the paragraph when relevant, no preamble.";
  const userMessage = recent.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  const text = await anthropicMessage({ system, userMessage, apiKey, apiUrl });
  return text?.trim() ?? null;
}

/**
 * Call Anthropic's Claude API to edit the map style from a natural language prompt.
 * Uses patch mode by default (model returns JSON Patch; we apply locally) for lower cost and latency.
 */
export async function editStyleWithLLM(params: EditStyleParams): Promise<EditStyleResult> {
  const {
    style,
    prompt,
    image,
    apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined,
    apiUrl = (import.meta.env.VITE_ANTHROPIC_API_URL as string | undefined) || (import.meta.env.DEV ? ANTHROPIC_PROXY_PATH : "https://api.anthropic.com/v1/messages"),
    conversationHistory = [],
    mapContext,
  } = params;

  const useProxy = apiUrl.startsWith("/");
  if (!useProxy && !apiKey?.trim()) {
    return { ok: false, error: "Missing API key. Set VITE_ANTHROPIC_API_KEY or, in dev, ANTHROPIC_API_KEY on the server." };
  }

  let textContent = `Current style JSON:\n\`\`\`json\n${JSON.stringify(style, null, 2)}\n\`\`\`\n\nUser request: ${prompt}`;
  if (mapContext?.trim()) {
    textContent = `Map context (purpose and users):\n${mapContext.trim()}\n\n` + textContent;
  }
  const systemPrompt = getSystemPromptPatch(!!image);
  const recentHistory = conversationHistory.slice(-6).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const currentTurn: { role: "user"; content: string | Array<{ type: "text" | "image"; text?: string; source?: { type: "base64"; media_type: string; data: string } }> } = image
    ? {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.dataBase64,
          },
        },
        { type: "text", text: textContent },
      ],
    }
    : { role: "user", content: textContent };
  const messages = [...recentHistory, currentTurn];

  const body = {
    model: (import.meta.env.VITE_ANTHROPIC_MODEL as string | undefined) || DEFAULT_MODEL,
    max_tokens: PATCH_MAX_TOKENS,
    system: systemPrompt,
    messages,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (!useProxy && apiKey) {
    headers["x-api-key"] = apiKey;
  }

  let res: Response;
  try {
    res = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${message}` };
  }

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `API error ${res.status}: ${text.slice(0, 200)}` };
  }

  let data: { content?: Array<{ type?: string; text?: string }> };
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: "Invalid JSON response from API" };
  }

  const rawText = getTextFromAnthropicResponse(data);
  if (!rawText || typeof rawText !== "string") {
    return { ok: false, error: "Empty or invalid response from API" };
  }

  let parsed: unknown;
  const patchStr = extractPatchArrayFromText(rawText);
  if (patchStr) {
    try {
      parsed = JSON.parse(patchStr);
    } catch {
      parsed = undefined;
    }
  }
  if (parsed === undefined) {
    try {
      parsed = parseJsonFromResponse(rawText);
    } catch {
      return { ok: false, error: "Model did not return valid JSON. Try rephrasing your request." };
    }
  }

  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: "Model response was not JSON object or array." };
  }

  if (isApiWrapper(parsed)) {
    const inner = (parsed as Record<string, unknown>).content;
    const innerArr = Array.isArray(inner) ? inner : [];
    const innerText = (innerArr[0] as { text?: string } | undefined)?.text;
    if (typeof innerText === "string") {
      const innerPatchStr = extractPatchArrayFromText(innerText);
      try {
        parsed = innerPatchStr ? JSON.parse(innerPatchStr) : parseJsonFromResponse(innerText);
      } catch {
        return { ok: false, error: "Could not parse style from nested response." };
      }
    } else {
      return { ok: false, error: "Response was API wrapper; no content found." };
    }
  }

  // Patch mode: response is an array of RFC 6902 operations
  if (Array.isArray(parsed)) {
    let patch = parsed as Operation[];
    if (patch.length === 0) {
      return { ok: true, style, explanation: "No changes requested." };
    }
    patch = resolveLayerIdsInPatch(style, patch);
    const hasAdd = patch.some((op) => op.op === "add");
    const hasReplace = patch.some((op) => op.op === "replace");
    const patchAsReplace = hasAdd
      ? (patch.map((op) => (op.op === "add" ? { ...op, op: "replace" as const } : op)) as Operation[])
      : null;
    let styleCopy = cloneDeep(style) as Record<string, unknown>;
    const tryApply = (p: Operation[]) => {
      applyPatch(styleCopy, p, true, true);
    };
    try {
      if (patchAsReplace !== null) {
        try {
          tryApply(patchAsReplace);
        } catch (firstErr) {
          const firstMsg = String(firstErr);
          if (firstMsg.includes("OPERATION_PATH_UNRESOLVABLE")) {
            styleCopy = cloneDeep(style) as Record<string, unknown>;
            tryApply(patch);
          } else {
            throw firstErr;
          }
        }
      } else {
        tryApply(patch);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (hasReplace && patchAsReplace === null) {
        const patchWithAdd = patch.map((op) =>
          op.op === "replace" ? { ...op, op: "add" as const } : op,
        );
        styleCopy = cloneDeep(style) as Record<string, unknown>;
        try {
          tryApply(patchWithAdd);
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return { ok: false, error: `Patch failed: ${retryMessage}` };
        }
      } else {
        return { ok: false, error: `Patch failed: ${message}` };
      }
    }
    const withId = { ...styleCopy, id: (styleCopy.id as string) || style.id } as StyleSpecificationWithId;
    const errList: Array<{ message?: string }> = (validateStyleMin(withId) as Array<{ message?: string }> | undefined) ?? [];
    if (errList.length > 0) {
      const msg = errList[0]?.message ?? "Invalid style after patch.";
      return { ok: false, error: `Style invalid after patch: ${msg}` };
    }
    const summary = summarizePatch(patch, style);
    const beforeAfter = formatPatchBeforeAfter(patch, style);
    const prose = extractProseBeforePatch(rawText);
    let explanation = [prose, summary].filter(Boolean).join("\n\n");
    const accessibilityNote = await evaluateAccessibilityImpact({
      patchSummary: summary,
      beforeAfterValues: beforeAfter || undefined,
      mapContext,
      apiKey,
      apiUrl,
    });
    if (accessibilityNote) {
      explanation = [explanation, "Accessibility:", accessibilityNote].filter(Boolean).join("\n\n");
    }
    return { ok: true, style: withId, explanation: explanation || undefined };
  }

  // Fallback: full style object (e.g. model returned full style anyway)
  const styleObj = parsed as Record<string, unknown>;
  const outStyle: StyleSpecificationWithId = {
    ...styleObj,
    id: (styleObj.id as string) || style.id,
  } as StyleSpecificationWithId;
  const outErrors: Array<{ message?: string }> = (validateStyleMin(outStyle) as Array<{ message?: string }> | undefined) ?? [];
  if (outErrors.length > 0) {
    return { ok: false, error: `Invalid style: ${outErrors[0]?.message ?? "validation failed"}` };
  }
  return { ok: true, style: outStyle };
}
