var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// vision.ts
var vision_exports = {};
__export(vision_exports, {
  default: () => vision_default
});
module.exports = __toCommonJS(vision_exports);

// runtime-stub.ts
function tool(def) {
  return def;
}
tool.schema = {
  string: () => ({ __kind: "string" }),
  boolean: () => ({ __kind: "boolean" }),
  optional: (s) => ({ __kind: "optional", inner: s }),
  number: () => ({ __kind: "number" }),
  object: (o) => ({ __kind: "object", fields: o })
};

// vision.ts
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var isOk = (r) => r.ok;
var DEFAULT_MODELS = {
  gemini: "gemini-3.6-flash",
  nim: "meta/llama-3.2-90b-vision-instruct"
};
var DUAL_MODELS = [
  ["meta/llama-3.2-90b-vision-instruct", "structured overall description"],
  ["nvidia/nemotron-nano-12b-v2-vl", "sharp low-level visual detail"]
];
function defaultConfig() {
  return {
    provider: "chain",
    chain: ["gemini", "nim"],
    models: { ...DEFAULT_MODELS },
    keys: {},
    baseUrls: {
      nim: "https://integrate.api.nvidia.com/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta"
    },
    timeoutMs: 6e4
  };
}
var ENV_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
function interp(s) {
  return s.replace(ENV_RE, (_match, name) => process.env[name] ?? "");
}
function deepInterp(v) {
  if (typeof v === "string") return interp(v);
  if (Array.isArray(v)) return v.map(deepInterp);
  if (v && typeof v === "object") {
    const out = {};
    for (const [key, value] of Object.entries(v)) out[key] = deepInterp(value);
    return out;
  }
  return v;
}
function entries(v) {
  return v && typeof v === "object" ? Object.entries(v) : [];
}
function loadConfig(raw) {
  const cfg = defaultConfig();
  const user = deepInterp(raw ?? {});
  if (typeof user.provider === "string") cfg.provider = user.provider;
  if (Array.isArray(user.chain)) cfg.chain = user.chain.filter((x) => x === "gemini" || x === "nim");
  for (const [key, value] of entries(user.models)) if (typeof value === "string") cfg.models[key] = value;
  for (const [key, value] of entries(user.keys)) if (typeof value === "string") cfg.keys[key] = value;
  for (const [key, value] of entries(user.baseUrls)) if (typeof value === "string") cfg.baseUrls[key] = value;
  if (typeof user.timeout_ms === "number") cfg.timeoutMs = user.timeout_ms;
  if (typeof user.timeout === "number") cfg.timeoutMs = user.timeout;
  if (!cfg.keys.gemini && process.env.GEMINI_API_KEY) cfg.keys.gemini = process.env.GEMINI_API_KEY;
  if (!cfg.keys.gemini && process.env.GOOGLE_API_KEY) cfg.keys.gemini = process.env.GOOGLE_API_KEY;
  if (!cfg.keys.nim && process.env.NVIDIA_API_KEY) cfg.keys.nim = process.env.NVIDIA_API_KEY;
  return cfg;
}
async function resolveImage(ref) {
  if (ref.startsWith("data:image/") && ref.includes(";base64,")) {
    const [head, b64] = ref.split(",", 2);
    const mime = /image\/[a-z0-9.+-]+/i.exec(head)?.[0] ?? "image/png";
    return { data: b64, mime };
  }
  if (/^https?:\/\//i.test(ref)) {
    const response = await fetch(ref);
    if (!response.ok) throw new Error(`Failed to fetch image URL: HTTP ${response.status}`);
    const buf2 = new Uint8Array(await response.arrayBuffer());
    const mime = response.headers.get("content-type")?.split(";")[0] || "image/png";
    return { data: Buffer.from(buf2).toString("base64"), mime };
  }
  const buf = await (0, import_promises.readFile)((0, import_node_path.resolve)(ref));
  const MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
    ".avif": "image/avif",
    ".heic": "image/heic",
    ".heif": "image/heif"
  };
  const ext = (0, import_node_path.extname)(ref).toLowerCase();
  return { data: Buffer.from(buf).toString("base64"), mime: MIME[ext] ?? "image/png" };
}
var DESCRIBE_PROMPT = `Describe this image comprehensively and objectively. Include:
1. Main subject and composition
2. Colors, lighting, visual style
3. ALL visible text (transcribed exactly, preserve original language)
4. People, objects, environment
5. Context and purpose (UI screenshot, photo, diagram, document, etc.)
6. Technical quality and notable visual elements

Be precise. Do not speculate beyond what is visible.`;
var BLIND_READER_CLAUSE = `
CRITICAL: the reader cannot see this image at all. Treat this description as the
reader's ONLY source of visual truth, so be exhaustive and explicitly spatial:
- Describe layout, arrangement, and relative position (top/bottom/left/right/center,
  foreground/background, above/below/next to).
- Name every distinct element, its approximate size, and its function.
- For screenshots/UI/diagrams: describe structure, grouping, alignment behavior,
  what is interactive, and read off all visible text verbatim.
- Use precise, concrete words. Avoid "you can see" / "as shown" assumptions; the
  reader cannot see \u2014 leave nothing implied.`;
var OCR_PROMPT = `Extract ALL text from this image EXACTLY as it appears.
Preserve the original language, capitalization, line breaks, and formatting.
Return ONLY the extracted text with no commentary.
If there is no readable text, say "[No text detected]".`;
var BLIND_CALIBRATION = `
CALIBRATION \u2014 follow the framework sequence for the matching category. The good
example is the target style (precise, measured, spatial); the bad example is the
style to avoid.

1. Data & Technical Visuals (graphs, charts, diagrams)
   Framework: Identity \u2192 Axis/Scale \u2192 Trend Line \u2192 Key Anomalies
   Bad: "This is a line graph showing sales going up and down over the last year, with a huge drop in the middle."
   Good: "A 2D line graph tracking monthly revenue across 12 months. The horizontal X-axis plots time from January to December. The vertical Y-axis measures revenue from zero to one hundred thousand dollars. The data line rises steadily from forty thousand in January to a peak of ninety thousand in June, plunges sharply to ten thousand in July, and recovers to eighty thousand by December."

2. Physical Spatial Environments (real-world scenes, landscapes, labs)
   Framework: Z-Axis Depth (Foreground to Background) \u2192 Clock-Face Anchors \u2192 Textures/Lighting
   Bad: "A crowded, messy workshop filled with dangerous tools and electronics scattered all over the place."
   Good: "A brightly lit, five-meter-wide electronics laboratory. In the foreground at 6 o'clock sits a wooden workbench littered with copper wires, a silver soldering iron, and green circuit boards. In the midground at 3 o'clock, a tall steel rack houses stacked digital oscilloscopes with glowing green grid screens. In the background, a concrete wall features a wide glass window revealing an outdoor courtyard."

3. Abstract Concepts & Human Elements (art, infographics, behavior)
   Framework: Core Subject \u2192 Micro-Details/Geometry \u2192 Objective Action \u2192 Color/Composition
   Bad: "An inspirational infographic about success showing a businessman looking proud after finally reaching his goal."
   Good: "A minimalist vector infographic on a solid white background. The central graphic is a black, stepped pyramid with five distinct levels. A stylized human silhouette clad in a sharp charcoal suit stands atop the highest peak. The silhouette holds a bright yellow, triangular flag pointing upward to the right. Crisp, black sans-serif text labels sit horizontally beneath each step of the pyramid."`;
function describePrompt(blind, userPrompt) {
  if (userPrompt) return userPrompt;
  return blind ? `${DESCRIBE_PROMPT}

${BLIND_READER_CLAUSE}

${BLIND_CALIBRATION}` : DESCRIBE_PROMPT;
}
function ownerOf(model) {
  return model.startsWith("gemini") ? "gemini" : "nim";
}
async function providerCall(cfg, provider, model, prompt, img, timeoutMs) {
  return provider === "gemini" ? geminiCall(cfg, model, prompt, img, timeoutMs) : nimCall(cfg, model, prompt, img, timeoutMs);
}
async function runWithChain(cfg, model, prompt, img) {
  const providers = model ? [ownerOf(model)] : cfg.chain;
  const perProvider = Math.max(2e3, Math.floor(cfg.timeoutMs / providers.length));
  let last = { ok: false, error: "no provider available" };
  for (const provider of providers) {
    const chosen = model ?? cfg.models[provider] ?? DEFAULT_MODELS[provider];
    const r = await providerCall(cfg, provider, chosen, prompt, img, perProvider);
    if (isOk(r)) return r;
    last = r;
  }
  return last;
}
async function dualDescribe(cfg, img, blind, userPrompt) {
  const prompt = describePrompt(blind, userPrompt);
  const sections = [];
  let anyOk = false;
  for (const [model, label] of DUAL_MODELS) {
    const r = await nimCall(cfg, model, prompt, img, cfg.timeoutMs);
    if (isOk(r)) anyOk = true;
    sections.push(`\u2550\u2550\u2550 ${label} \u2014 ${model} \u2550\u2550\u2550

${isOk(r) ? r.text : "\u26A0\uFE0F FAILED: " + r.error}`);
  }
  return anyOk ? { ok: true, text: sections.join("\n\n").trim() } : { ok: false, error: "Dual NIM describe failed" };
}
async function nimCall(cfg, model, prompt, img, timeoutMs) {
  const key = cfg.keys.nim;
  if (!key) return { ok: false, error: "NVIDIA_API_KEY missing (config keys.nim)" };
  const body = {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } }
      ]
    }],
    max_tokens: 1024,
    temperature: 0.2
  };
  try {
    const response = await fetch(`${cfg.baseUrls.nim}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, error: `NIM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` };
    const json = await response.json();
    const text = json.choices?.[0]?.message?.content;
    return text ? { ok: true, text: text.trim() } : { ok: false, error: "[EMPTY] no content from NIM" };
  } catch (e) {
    return { ok: false, error: `NIM fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
async function geminiCall(cfg, model, prompt, img, timeoutMs) {
  const key = cfg.keys.gemini;
  if (!key) return { ok: false, error: "Gemini key missing (config keys.gemini)" };
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: img.mime, data: img.data } }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  };
  try {
    const response = await fetch(`${cfg.baseUrls.gemini}/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { ok: false, error: `Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` };
    const json = await response.json();
    const parts = json.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p?.text ?? "").join("") : "";
    return text ? { ok: true, text: text.trim() } : { ok: false, error: "[Gemini] no text in response" };
  } catch (e) {
    return { ok: false, error: `Gemini fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
var plugin = async (_input, pluginOptions) => {
  const cfg = loadConfig(pluginOptions);
  return {
    tool: {
      describe: tool({
        description: `Vision describe: composition, layout, colors, objects, ALL visible text, context. blind (REQUIRED): true = reader cannot see the image \u2014 exhaustive spatial description; false = normal. DEFAULT (omit model) = DUAL mode: two NIM VLMs \u2014 structured overview + fine detail \u2014 labelled sections, best fidelity; prefer it. Single view ONLY for one-offs: "meta/llama-3.2-90b-vision-instruct" (overview), "nvidia/nemotron-nano-12b-v2-vl" (sharp detail), "meta/llama-3.2-11b-vision-instruct" (light), "gemini-3.6-flash". Flaky models \u2014 call independently.`,
        args: {
          image_path: tool.schema.string(),
          blind: tool.schema.boolean(),
          prompt: tool.schema.optional(tool.schema.string()),
          model: tool.schema.optional(tool.schema.string())
        },
        async execute(args) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing required: image_path";
          if (typeof args.blind !== "boolean") return "Missing required: blind (true/false)";
          const prompt = args.prompt ?? "";
          const model = args.model ?? void 0;
          try {
            const img = await resolveImage(args.image_path);
            if (model) {
              const r = await runWithChain(cfg, model, describePrompt(args.blind, prompt), img);
              return isOk(r) ? r.text : r.error;
            }
            const d = await dualDescribe(cfg, img, args.blind, prompt);
            return isOk(d) ? d.text : d.error;
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }),
      ocr: tool({
        description: `OCR: extract ALL visible text verbatim \u2014 screenshots, UI, documents, receipts, diagrams, photos, memes, whiteboards. Returns only the extracted text. blind (REQUIRED): true = reader cannot see the image. Use for anything text-bearing; never guess text from context.`,
        args: {
          image_path: tool.schema.string(),
          blind: tool.schema.boolean(),
          model: tool.schema.optional(tool.schema.string())
        },
        async execute(args) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing required: image_path";
          if (typeof args.blind !== "boolean") return "Missing required: blind (true/false)";
          try {
            const img = await resolveImage(args.image_path);
            const r = await runWithChain(cfg, args.model ?? void 0, OCR_PROMPT, img);
            return isOk(r) ? r.text : r.error;
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }),
      analyze: tool({
        description: `Full vision analysis: source metadata + DUAL description + OCR in one call \u2014 screenshot/UI/document forensics, audits, evidence extraction, comprehensive understanding. Slower (multi-call); prefer describe for quick questions. blind (REQUIRED): true = reader cannot see the image \u2014 exhaustive spatial description. Omit model = DUAL mode.`,
        args: {
          image_path: tool.schema.string(),
          blind: tool.schema.boolean(),
          model: tool.schema.optional(tool.schema.string())
        },
        async execute(args) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing required: image_path";
          if (typeof args.blind !== "boolean") return "Missing required: blind (true/false)";
          try {
            const img = await resolveImage(args.image_path);
            const desc = args.model ? await runWithChain(cfg, args.model, describePrompt(args.blind, ""), img) : await dualDescribe(cfg, img, args.blind, "");
            const ocr = await runWithChain(cfg, void 0, OCR_PROMPT, img);
            const meta = args.image_path.startsWith("data:") ? "data: URL" : `path: ${args.image_path}`;
            return [
              `\u{1F4D0} SOURCE`,
              meta,
              `
\u{1F5BC}\uFE0F  VISUAL DESCRIPTION
${isOk(desc) ? desc.text : "\u26A0\uFE0F " + desc.error}`,
              `
\u{1F4C4} TEXT CONTENT
${isOk(ocr) ? ocr.text : "\u26A0\uFE0F " + ocr.error}`
            ].join("\n");
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      })
    }
  };
};
var vision_default = plugin;
