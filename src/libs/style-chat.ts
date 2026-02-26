import cloneDeep from "lodash.clonedeep";
import { applyPatch, type Operation } from "fast-json-patch";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type { StyleSpecificationWithId } from "./definitions";

const STYLE_SPEC_REF = "https://maplibre.org/maplibre-style-spec/";

/** System prompt for patch mode: model returns only a JSON Patch (RFC 6902) array. */
function getSystemPromptPatch(): string {
  return `You edit MapLibre GL map styles. You receive the current style JSON and a user request. Return ONLY a JSON Patch (RFC 6902) array that, when applied to the style, makes the requested change.

Rules:
- Output nothing but a JSON array of patch operations. No markdown, no explanation, no commentary before or after the array. Example: [{"op":"replace","path":"/layers/roads_minor/paint/line-color","value":"#d8d8d8"}]
- Paths use JSON Pointer with layer id (not index): /layers/<layer_id>/paint/line-color, e.g. /layers/roads_minor/paint/line-color or /layers/landuse_park/paint/fill-color. We resolve layer id to index automatically. The path must end at a property name. Never use array indices on property values (no /paint/line-color/0 or /3). Paint properties like line-color, fill-color are strings or expressions; set the whole value with one replace/add.
- Use "replace" for existing properties, "add" for new ones. For paint or layout properties that may be missing (e.g. line-dasharray, line-cap), use "add" so the patch works whether the property exists or not. Preserve id, sources, glyphs, sprite unless the user asks to change them.
- For label overlap: adjust symbol layers' layout/paint (text-size, text-max-width, text-optional, symbol-spacing, text-allow-overlap). Spec: ${STYLE_SPEC_REF}
- Only include operations that change something.`;
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

export type EditStyleParams = {
  style: StyleSpecificationWithId;
  prompt: string;
  apiKey?: string;
  apiUrl?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
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

const ANTHROPIC_PROXY_PATH = "/api/anthropic/messages";

/** Default to Haiku for lower cost/latency; override with VITE_ANTHROPIC_MODEL. */
const DEFAULT_MODEL = "claude-3-5-haiku-latest";
const PATCH_MAX_TOKENS = 4096;

/**
 * Call Anthropic's Claude API to edit the map style from a natural language prompt.
 * Uses patch mode by default (model returns JSON Patch; we apply locally) for lower cost and latency.
 */
export async function editStyleWithLLM(params: EditStyleParams): Promise<EditStyleResult> {
  const {
    style,
    prompt,
    apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined,
    apiUrl = (import.meta.env.VITE_ANTHROPIC_API_URL as string | undefined) || (import.meta.env.DEV ? ANTHROPIC_PROXY_PATH : "https://api.anthropic.com/v1/messages"),
    conversationHistory = [],
  } = params;

  const useProxy = apiUrl.startsWith("/");
  if (!useProxy && !apiKey?.trim()) {
    return { ok: false, error: "Missing API key. Set VITE_ANTHROPIC_API_KEY or, in dev, ANTHROPIC_API_KEY on the server." };
  }

  const systemPrompt = getSystemPromptPatch();
  const recentHistory = conversationHistory.slice(-6).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const currentTurn: { role: "user"; content: string } = {
    role: "user",
    content: `Current style JSON:\n\`\`\`json\n${JSON.stringify(style, null, 2)}\n\`\`\`\n\nUser request: ${prompt}`,
  };
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
    return { ok: true, style: withId };
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
