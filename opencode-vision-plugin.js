var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
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
  optional: (s) => ({ __kind: "optional", inner: s }),
  number: () => ({ __kind: "number" }),
  object: (o) => ({ __kind: "object", fields: o })
};

// vision.ts
function isErr(r) {
  return "error" in r && typeof r.error === "string";
}
var DEFAULT_MODELS = {
  gemini: "gemini-3.6-flash",
  nim: "meta/llama-3.2-90b-vision-instruct"
};
var DUAL_MODELS = [
  ["meta/llama-3.2-90b-vision-instruct", "structured overall description"],
  ["nvidia/nemotron-nano-12b-v2-vl", "sharp low-level visual detail"]
];
function defaults() {
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
function interpStr(s) {
  return s.replace(ENV_RE, (_, name) => process.env[name] ?? "");
}
function deepInterp(v) {
  if (typeof v === "string") return interpStr(v);
  if (Array.isArray(v)) return v.map(deepInterp);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepInterp(v[k]);
    return o;
  }
  return v;
}
function applyEnvFallbacks(c) {
  if (!c.keys.gemini && process.env.GEMINI_API_KEY) c.keys.gemini = process.env.GEMINI_API_KEY;
  if (!c.keys.gemini && process.env.GOOGLE_API_KEY) c.keys.gemini = process.env.GOOGLE_API_KEY;
  if (!c.keys.nim && process.env.NVIDIA_API_KEY) c.keys.nim = process.env.NVIDIA_API_KEY;
  return c;
}
function loadConfig(raw) {
  const c = defaults();
  if (!raw) return applyEnvFallbacks(c);
  const r = deepInterp(raw);
  if (typeof r.provider === "string") c.provider = r.provider;
  if (Array.isArray(r.chain)) c.chain = r.chain.filter(Boolean);
  const models = r.models && typeof r.models === "object" ? r.models : {};
  for (const k of Object.keys(models)) if (typeof models[k] === "string") c.models[k] = models[k];
  c.models = Object.fromEntries(Object.entries(c.models).filter(([_, v]) => typeof v === "string"));
  const keys = r.keys && typeof r.keys === "object" ? r.keys : {};
  for (const k of Object.keys(keys)) if (typeof keys[k] === "string") c.keys[k] = keys[k];
  const bu = r.baseUrls && typeof r.baseUrls === "object" ? r.baseUrls : {};
  for (const k of Object.keys(bu)) if (typeof bu[k] === "string") c.baseUrls[k] = bu[k];
  if (typeof r.timeout_ms === "number") c.timeoutMs = r.timeout_ms;
  if (typeof r.timeout === "number") c.timeoutMs = r.timeout;
  return applyEnvFallbacks(c);
}
async function resolveImage(ref) {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(ref)) {
    const [head, b64] = ref.split(",", 2);
    const mime = /image\/([a-z0-9.+-]+)/i.exec(head)?.[0] ?? "image/png";
    return { data: b64, mime };
  }
  if (/^https?:\/\//i.test(ref)) {
    const resp = await fetch(ref);
    if (!resp.ok) throw new Error(`Failed to fetch image URL: HTTP ${resp.status}`);
    const buf2 = new Uint8Array(await resp.arrayBuffer());
    const b64 = Buffer.from(buf2).toString("base64");
    const mime = resp.headers.get("content-type")?.split(";")[0] || "image/png";
    return { data: b64, mime };
  }
  const { readFile } = await import("node:fs/promises");
  const pathObj = new URL("file:" + (await import("node:path")).resolve(ref));
  const buf = await readFile(pathObj);
  const ext = (await import("node:path")).extname(ref).toLowerCase();
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
  return { data: Buffer.from(buf).toString("base64"), mime: MIME[ext] ?? "image/png" };
}
async function nimCall(cfg, model, prompt, img, timeoutMs) {
  const key = cfg.keys.nim;
  if (!key) return { error: "NVIDIA_API_KEY missing (config keys.nim)" };
  const url = `${cfg.baseUrls.nim}/chat/completions`;
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
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    return { error: `NIM fetch failed: ${e?.message ?? String(e)}` };
  }
  if (!resp.ok) return { error: `NIM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}` };
  const j = await resp.json();
  const text = j.choices?.[0]?.message?.content;
  if (!text) return { error: "[EMPTY] no content from NIM" };
  return { text: text.trim() };
}
async function geminiCall(cfg, model, prompt, img, timeoutMs) {
  const key = cfg.keys.gemini;
  if (!key) return { error: "Gemini key missing (config keys.gemini)" };
  const url = `${cfg.baseUrls.gemini}/models/${model}:generateContent?key=${key}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: img.mime, data: img.data } }
      ]
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
  };
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    return { error: `Gemini fetch failed: ${e?.message ?? String(e)}` };
  }
  if (!resp.ok) return { error: `Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}` };
  const j = await resp.json().catch(() => null);
  const parts = j?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((p) => p?.text ?? "").join("") : "";
  if (!text) return { error: "[Gemini] no text in response" };
  return { text: text.trim() };
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
function describePromptFor(model, prompt) {
  if (prompt) return prompt;
  const m = (model ?? "").toLowerCase();
  if (m.startsWith("gemini")) return `${DESCRIBE_PROMPT}

${BLIND_READER_CLAUSE}`;
  return DESCRIBE_PROMPT;
}
var OCR_PROMPT = `Extract ALL text from this image EXACTLY as it appears.
Preserve the original language, capitalization, line breaks, and formatting.
Return ONLY the extracted text with no commentary.
If there is no readable text, say "[No text detected]".`;
async function callSingle(cfg, provider, method, prompt, img, model, budgetMs) {
  if (method === "describe") prompt = describePromptFor(model, prompt);
  const effective = prompt || (method === "describe" ? DESCRIBE_PROMPT : OCR_PROMPT);
  const remaining = () => budgetMs ?? cfg.timeoutMs;
  if (provider === "gemini") return geminiCall(cfg, model ?? cfg.models.gemini ?? DEFAULT_MODELS.gemini, effective, img, remaining());
  if (provider === "nim") return nimCall(cfg, model ?? cfg.models.nim ?? DEFAULT_MODELS.nim, effective, img, remaining());
  if (provider === "chain") {
    if (model) {
      const owner = model.startsWith("gemini") ? "gemini" : "nim";
      const r = await callSingle(cfg, owner, method, prompt, img, model, budgetMs ?? cfg.timeoutMs);
      if (!isErr(r)) return r;
      return r;
    }
  }
  const chain = cfg.chain.length ? cfg.chain : ["gemini", "nim"];
  const deadline = Date.now() + (budgetMs ?? cfg.timeoutMs);
  const budgetEach = Math.max(2e3, Math.floor((budgetMs ?? cfg.timeoutMs) / chain.length));
  let last = { error: "no provider" };
  for (const p of chain) {
    if (Date.now() >= deadline) {
      last = { error: `chain deadline exceeded (provider ${p} skipped)` };
      break;
    }
    const slice = Math.max(1e3, Math.min(budgetEach, deadline - Date.now()));
    const r = await callSingle(cfg, p, method, prompt, img, void 0, slice);
    if (!isErr(r)) return r;
    last = r;
  }
  return last;
}
async function dualDescribe(cfg, img, prompt) {
  let text = "";
  let anyOk = false;
  for (const [model, label] of DUAL_MODELS) {
    const r = await nimCall(cfg, model, prompt || DESCRIBE_PROMPT, img, cfg.timeoutMs);
    if (!isErr(r)) {
      anyOk = true;
      text += `\u2550\u2550\u2550 ${label} \u2014 ${model} \u2550\u2550\u2550

${r.text}

`;
    } else {
      text += `\u2550\u2550\u2550 ${label} \u2014 ${model} \u2550\u2550\u2550

\u26A0\uFE0F FAILED: ${r.error}

`;
    }
  }
  if (!anyOk) return { error: "Dual NIM describe failed" };
  return { text: text.trim() };
}
var plugin = async (_input, pluginOptions) => {
  const cfg = loadConfig(pluginOptions);
  return {
    tool: {
      describe: tool({
        description: `Describe an image in detail: composition, colors, objects, all visible text, context.
PREFERRED default: call WITHOUT the model arg \u2014 this runs the built-in dual mode (two complementary NIM VLMs: structured + fine detail) and returns labelled sections. This is the best overall result; use it unless you have a specific reason not to.
Only set model when you specifically want ONE view, e.g. "meta/llama-3.2-90b-vision-instruct" (structured overview), "nvidia/nemotron-nano-12b-v2-vl" (sharp low-level detail), "meta/llama-3.2-11b-vision-instruct" (light), "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" (concise), "gemini-3.6-flash". RULES: (1) do NOT switch models across repeated calls \u2014 pick the default dual mode once and keep it, so results are comparable; (2) only pass model for a genuine one-off need, never to sample/experiment; (3) never pass a gemini model to a NIM task or vice-versa \u2014 each model belongs to its own provider.`,
        args: {
          image_path: tool.schema.string(),
          prompt: tool.schema.optional(tool.schema.string()),
          model: tool.schema.optional(tool.schema.string())
        },
        async execute(args, ctx) {
          if (!args.image_path || typeof args.image_path !== "string" || !String(args.image_path).trim()) {
            return "Missing required: image_path";
          }
          const ref = String(args.image_path);
          const prompt = typeof args.prompt === "string" ? args.prompt : "";
          const model = typeof args.model === "string" && args.model ? args.model : void 0;
          try {
            const img = await resolveImage(ref);
            if (!model) {
              const d = await dualDescribe(cfg, img, prompt);
              if (!isErr(d)) return d.text;
            }
            const r = await callSingle(cfg, cfg.provider, "describe", prompt, img, model);
            return isErr(r) ? r.error : r.text;
          } catch (e) {
            return `Error: ${e?.message ?? String(e)}`;
          }
        }
      }),
      ocr: tool({
        description: "Extract all visible text from an image (path, URL, or data: URL). Returns only the extracted text.",
        args: {
          image_path: tool.schema.string(),
          model: tool.schema.optional(tool.schema.string())
        },
        async execute(args) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing image_path";
          const model = typeof args.model === "string" && args.model ? args.model : void 0;
          try {
            const img = await resolveImage(String(args.image_path));
            const r = await callSingle(cfg, cfg.provider, "ocr", "", img, model);
            return isErr(r) ? r.error : r.text;
          } catch (e) {
            return `Error: ${e?.message ?? String(e)}`;
          }
        }
      }),
      analyze: tool({
        description: `Heavyweight combined analysis: metadata + visual description + text extraction. Use ONLY when you need all three (e.g. document/screenshot forensics). For ordinary image understanding, prefer the lighter describe tool (dual mode default) instead; analyze is slower and costs extra calls. model is optional; omit it to get the default model.`,
        args: {
          image_path: tool.schema.string(),
          model: tool.schema.optional(tool.schema.string())
        },
        async execute(args, ctx) {
          if (!args.image_path || typeof args.image_path !== "string") return "unknown image_path";
          const model = typeof args.model === "string" && args.model ? args.model : void 0;
          const ref = String(args.image_path);
          try {
            const img = await resolveImage(ref);
            const desc = await callSingle(cfg, cfg.provider, "describe", "", img, model);
            const oc = await callSingle(cfg, cfg.provider, "ocr", OCR_PROMPT, img);
            const meta = ref.startsWith("data:") ? "data: URL" : `path: ${ref}`;
            return [
              `\u{1F4D0} SOURCE`,
              meta,
              `
\u{1F5BC}\uFE0F  VISUAL DESCRIPTION
${isErr(desc) ? "\u26A0\uFE0F " + desc.error : desc.text}`,
              `
\u{1F4C4} TEXT CONTENT
${isErr(oc) ? "\u26A0\uFE0F " + oc.error : oc.text}`
            ].join("\n");
          } catch (e) {
            return `Error: ${e?.message ?? String(e)}`;
          }
        }
      })
    }
  };
};
var vision_default = plugin;
