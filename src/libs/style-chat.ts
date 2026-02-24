import type { StyleSpecificationWithId } from "./definitions";

const STYLE_SPEC_REF = "https://maplibre.org/maplibre-style-spec/";

function getSystemPrompt(): string {
  return `You are an expert at editing MapLibre GL map styles. You will receive the current style JSON and a user request. Your job is to return a valid, complete MapLibre style JSON that fulfills the request.

Rules:
- Output ONLY valid MapLibre style JSON. No markdown code fences, no explanation outside the JSON. The response must parse as JSON and validate against the MapLibre Style Spec: ${STYLE_SPEC_REF}
- Preserve the style's \`id\`, \`sources\`, \`glyphs\`, and \`sprite\` unless the user explicitly asks to change them.
- For label overlap issues: adjust symbol layer layout/paint properties such as \`text-size\`, \`text-max-width\`, \`text-max-angle\`, \`symbol-spacing\`, \`text-allow-overlap\`, \`icon-allow-overlap\`, \`text-optional\`, \`text-variable-anchor\`, or \`symbol-placement\` (e.g. "line" for along lines). Prefer reducing \`text-size\` or enabling \`text-optional\` / \`text-max-width\` to reduce overlap.
- For stylistic requests (e.g. "clean, modern map for pedestrians"): adjust layers, paint (colors, widths), layout (visibility, label density), and root properties (name, center, zoom) as needed. Keep the same sources unless asked to change data.
- Layer types include: fill, line, symbol, circle, heatmap, fill-extrusion, raster, hillshade. Use \`layout_<type>\` and \`paint_<type>\` property names from the spec.
- Return the ENTIRE style object so it can replace the current style. Do not return a partial patch.`;
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
 * The style JSON is in content[0].text (and possibly more blocks). We join all text blocks.
 */
function getTextFromAnthropicResponse(data: { content?: Array<{ type?: string; text?: string }> }): string | null {
  const blocks = data.content;
  if (!Array.isArray(blocks)) return null;
  const parts = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  return parts.length > 0 ? parts.join("") : null;
}

/** True if the object looks like the API wrapper (has content array, usage, etc.) not a style. */
function isApiWrapper(obj: object): boolean {
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.content) && typeof o.usage === "object" && typeof o.model === "string";
}

/** Proxy path used in dev to avoid CORS; the Vite server forwards to Anthropic with ANTHROPIC_API_KEY. */
const ANTHROPIC_PROXY_PATH = "/api/anthropic/messages";

/**
 * Call Anthropic's Claude API to edit the map style from a natural language prompt.
 * In development, uses the local proxy (/api/anthropic/messages) so the API key can stay in ANTHROPIC_API_KEY.
 * In production, set VITE_ANTHROPIC_API_KEY and the request goes directly (or use your own proxy).
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

  const systemPrompt = getSystemPrompt();
  const recentHistory = conversationHistory.slice(-6).map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  const currentTurn: { role: "user"; content: string } = {
    role: "user",
    content: `Current style JSON:\n\`\`\`json\n${JSON.stringify(style, null, 2)}\n\`\`\`\n\nUser request: ${prompt}`,
  };
  const messages = [...recentHistory, currentTurn];

  const body = {
    model: (import.meta.env.VITE_ANTHROPIC_MODEL as string | undefined) || "claude-3-5-sonnet-latest",
    max_tokens: 24800,
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

  // Style JSON is in content[0].text (and possibly more text blocks) – never use the top-level response as style
  const rawStyleText = getTextFromAnthropicResponse(data);
  if (!rawStyleText || typeof rawStyleText !== "string") {
    return { ok: false, error: "Empty or invalid response from API" };
  }

  const jsonMatch = rawStyleText.match(/\{[\s\S]*\}/);
  const jsonString = jsonMatch ? jsonMatch[0] : rawStyleText.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    return { ok: false, error: "Model did not return valid JSON. Try rephrasing your request." };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Model response was not a style object" };
  }

  // If we accidentally parsed the API wrapper (has content, usage, model), extract style from content[0].text
  if (isApiWrapper(parsed)) {
    const inner = (parsed as Record<string, unknown>).content as Array<{ type?: string; text?: string }> | undefined;
    const innerText = Array.isArray(inner)?.[0]?.text;
    if (typeof innerText === "string") {
      try {
        parsed = JSON.parse(innerText);
      } catch {
        return { ok: false, error: "Could not parse style from nested response." };
      }
    } else {
      return { ok: false, error: "Response was API wrapper; no style text found inside." };
    }
  }

  const styleObj = parsed as Record<string, unknown>;
  const outStyle: StyleSpecificationWithId = {
    ...styleObj,
    id: (styleObj.id as string) || style.id,
  } as StyleSpecificationWithId;

  return { ok: true, style: outStyle, explanation: rawStyleText.length > jsonString.length ? rawStyleText.replace(jsonString, "").trim().slice(0, 200) : undefined };
}
