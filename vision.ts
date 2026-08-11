/**
 * vision.ts — image analysis tools (describe / ocr / analyze) for opencode.
 *
 * Registers three custom tools that send the image to Google Gemini or NVIDIA
 * NIM (chain fallback) and return text — the model never sees the image bytes.
 *
 *   - describe: full description. No `model` → two complementary NIM models
 *     ("dual mode"), each section labelled. `model` → one specific model.
 *   - ocr:     all visible text, verbatim.
 *   - analyze: describe + ocr in one call.
 *
 * Every tool takes a compulsory `blind` boolean: true = the caller cannot see
 * the image, so the description must be exhaustive and spatial.
 *
 * Config (optional, nested-object plugin tuple):
 *   ["/path/to/vision.ts", {
 *     "provider": "chain",           // "gemini" | "nim" | "chain"
 *     "chain": ["gemini", "nim"],    // fallback order
 *     "models": { "gemini": "...", "nim": "..." },
 *     "keys":   { "gemini": "{env:GEMINI_API_KEY}", "nim": "{env:NVIDIA_API_KEY}" },
 *     "timeout_ms": 60
 *   }]
 * `{env:VAR}` is interpolated from the environment. Without a config block the
 * keys fall back to GEMINI_API_KEY / GOOGLE_API_KEY / NVIDIA_API_KEY env vars.
 */

import { type Plugin, tool } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"

// ── Contracts ────────────────────────────────────────────────────────────────

// Discriminated union: every call answers with text or an error. The `ok`
// discriminant narrows the type everywhere with zero type assertions.
type Result =
  | { ok: true; text: string }
  | { ok: false; error: string }

const isOk = (r: Result): r is Extract<Result, { ok: true }> => r.ok

type Provider = "gemini" | "nim"

interface Image {
  data: string
  mime: string
}

const DEFAULT_MODELS: Record<Provider, string> = {
  gemini: "gemini-3.6-flash",
  nim: "meta/llama-3.2-90b-vision-instruct",
}

// The two NIM models used when describe/analyze are called without a `model`.
const DUAL_MODELS: readonly [model: string, label: string][] = [
  ["meta/llama-3.2-90b-vision-instruct", "structured overall description"],
  ["nvidia/nemotron-nano-12b-v2-vl", "sharp low-level visual detail"],
]

interface Config {
  provider: Provider | "chain"
  chain: readonly Provider[]
  models: Partial<Record<Provider, string>>
  keys: Partial<Record<Provider, string>>
  baseUrls: Record<Provider, string>
  timeoutMs: number
}

function defaultConfig(): Config {
  return {
    provider: "chain",
    chain: ["gemini", "nim"],
    models: { ...DEFAULT_MODELS },
    keys: {},
    baseUrls: {
      nim: "https://integrate.api.nvidia.com/v1",
      gemini: "https://generativelanguage.googleapis.com/v1beta",
    },
    timeoutMs: 60000,
  }
}

// ── Config loading ───────────────────────────────────────────────────────────

const ENV_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

// Replace every {env:NAME} in a string with the environment variable's value.
function interp(s: string): string {
  return s.replace(ENV_RE, (_match, name: string) => process.env[name] ?? "")
}

// Interpolate recursively through strings in nested objects/arrays.
function deepInterp(v: unknown): unknown {
  if (typeof v === "string") return interp(v)
  if (Array.isArray(v)) return v.map(deepInterp)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) out[key] = deepInterp(value)
    return out
  }
  return v
}

// Object.entries over user config, safely: unknown input → known entries.
function entries(v: unknown): [string, unknown][] {
  return v && typeof v === "object" ? Object.entries(v as Record<string, unknown>) : []
}

// Copy every option the user gave over the defaults. Unset keys fall back to env.
function loadConfig(raw: Record<string, unknown> | undefined): Config {
  const cfg = defaultConfig()
  const user = deepInterp(raw ?? {}) as Record<string, unknown>

  if (typeof user.provider === "string") cfg.provider = user.provider as Config["provider"]
  if (Array.isArray(user.chain)) cfg.chain = user.chain.filter((x): x is Provider => x === "gemini" || x === "nim")
  for (const [key, value] of entries(user.models)) if (typeof value === "string") cfg.models[key as Provider] = value
  for (const [key, value] of entries(user.keys)) if (typeof value === "string") cfg.keys[key as Provider] = value
  for (const [key, value] of entries(user.baseUrls)) if (typeof value === "string") cfg.baseUrls[key as Provider] = value
  if (typeof user.timeout_ms === "number") cfg.timeoutMs = user.timeout_ms
  if (typeof user.timeout === "number") cfg.timeoutMs = user.timeout

  if (!cfg.keys.gemini && process.env.GEMINI_API_KEY) cfg.keys.gemini = process.env.GEMINI_API_KEY
  if (!cfg.keys.gemini && process.env.GOOGLE_API_KEY) cfg.keys.gemini = process.env.GOOGLE_API_KEY
  if (!cfg.keys.nim && process.env.NVIDIA_API_KEY) cfg.keys.nim = process.env.NVIDIA_API_KEY

  return cfg
}

// ── Image resolution: a path, an http(s) URL, or a data: URL ─────────────────

async function resolveImage(ref: string): Promise<Image> {
  if (ref.startsWith("data:image/") && ref.includes(";base64,")) {
    const [head, b64] = ref.split(",", 2)
    const mime = /image\/[a-z0-9.+-]+/i.exec(head)?.[0] ?? "image/png"
    return { data: b64, mime }
  }
  if (/^https?:\/\//i.test(ref)) {
    const response = await fetch(ref)
    if (!response.ok) throw new Error(`Failed to fetch image URL: HTTP ${response.status}`)
    const buf = new Uint8Array(await response.arrayBuffer())
    const mime = response.headers.get("content-type")?.split(";")[0] || "image/png"
    return { data: Buffer.from(buf).toString("base64"), mime }
  }
  const buf = await readFile(resolve(ref))
  const MIME: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".tiff": "image/tiff", ".tif": "image/tiff", ".avif": "image/avif",
    ".heic": "image/heic", ".heif": "image/heif",
  }
  const ext = extname(ref).toLowerCase()
  return { data: Buffer.from(buf).toString("base64"), mime: MIME[ext] ?? "image/png" }
}

// ── Prompts sent to the vision models ────────────────────────────────────────

const DESCRIBE_PROMPT = `Describe this image comprehensively and objectively. Include:
1. Main subject and composition
2. Colors, lighting, visual style
3. ALL visible text (transcribed exactly, preserve original language)
4. People, objects, environment
5. Context and purpose (UI screenshot, photo, diagram, document, etc.)
6. Technical quality and notable visual elements

Be precise. Do not speculate beyond what is visible.`

// Appended when blind=true: the caller cannot see the image, so the description
// is their ONLY visual truth — it must be exhaustive and explicitly spatial.
const BLIND_READER_CLAUSE = `
CRITICAL: the reader cannot see this image at all. Treat this description as the
reader's ONLY source of visual truth, so be exhaustive and explicitly spatial:
- Describe layout, arrangement, and relative position (top/bottom/left/right/center,
  foreground/background, above/below/next to).
- Name every distinct element, its approximate size, and its function.
- For screenshots/UI/diagrams: describe structure, grouping, alignment behavior,
  what is interactive, and read off all visible text verbatim.
- Use precise, concrete words. Avoid "you can see" / "as shown" assumptions; the
  reader cannot see — leave nothing implied.`

const OCR_PROMPT = `Extract ALL text from this image EXACTLY as it appears.
Preserve the original language, capitalization, line breaks, and formatting.
Return ONLY the extracted text with no commentary.
If there is no readable text, say "[No text detected]".`

// Quality calibration: bad-good example pairs per category. Blind readers need
// measured, spatial, structured descriptions — the good example is the target
// style, the bad example is what to avoid.
const BLIND_CALIBRATION = `
CALIBRATION — follow the framework sequence for the matching category. The good
example is the target style (precise, measured, spatial); the bad example is the
style to avoid.

1. Data & Technical Visuals (graphs, charts, diagrams)
   Framework: Identity → Axis/Scale → Trend Line → Key Anomalies
   Bad: "This is a line graph showing sales going up and down over the last year, with a huge drop in the middle."
   Good: "A 2D line graph tracking monthly revenue across 12 months. The horizontal X-axis plots time from January to December. The vertical Y-axis measures revenue from zero to one hundred thousand dollars. The data line rises steadily from forty thousand in January to a peak of ninety thousand in June, plunges sharply to ten thousand in July, and recovers to eighty thousand by December."

2. Physical Spatial Environments (real-world scenes, landscapes, labs)
   Framework: Z-Axis Depth (Foreground to Background) → Clock-Face Anchors → Textures/Lighting
   Bad: "A crowded, messy workshop filled with dangerous tools and electronics scattered all over the place."
   Good: "A brightly lit, five-meter-wide electronics laboratory. In the foreground at 6 o'clock sits a wooden workbench littered with copper wires, a silver soldering iron, and green circuit boards. In the midground at 3 o'clock, a tall steel rack houses stacked digital oscilloscopes with glowing green grid screens. In the background, a concrete wall features a wide glass window revealing an outdoor courtyard."

3. Abstract Concepts & Human Elements (art, infographics, behavior)
   Framework: Core Subject → Micro-Details/Geometry → Objective Action → Color/Composition
   Bad: "An inspirational infographic about success showing a businessman looking proud after finally reaching his goal."
   Good: "A minimalist vector infographic on a solid white background. The central graphic is a black, stepped pyramid with five distinct levels. A stylized human silhouette clad in a sharp charcoal suit stands atop the highest peak. The silhouette holds a bright yellow, triangular flag pointing upward to the right. Crisp, black sans-serif text labels sit horizontally beneath each step of the pyramid."`

// The describe prompt depends only on the blind flag (a user prompt overrides it).
function describePrompt(blind: boolean, userPrompt: string): string {
  if (userPrompt) return userPrompt
  return blind ? `${DESCRIBE_PROMPT}\n\n${BLIND_READER_CLAUSE}\n\n${BLIND_CALIBRATION}` : DESCRIBE_PROMPT
}

// ── Provider calls ───────────────────────────────────────────────────────────

// Gemini model ids start with "gemini"; everything else (llama, nemotron, ...)
// lives on NVIDIA NIM.
function ownerOf(model: string): Provider {
  return model.startsWith("gemini") ? "gemini" : "nim"
}

// Network errors and HTTP failures become Result errors instead of throwing,
// so the chain can keep going. Timeouts and failures never crash the tool.
async function providerCall(
  cfg: Config,
  provider: Provider,
  model: string,
  prompt: string,
  img: Image,
  timeoutMs: number,
): Promise<Result> {
  return provider === "gemini"
    ? geminiCall(cfg, model, prompt, img, timeoutMs)
    : nimCall(cfg, model, prompt, img, timeoutMs)
}

// Try each provider in order. An explicit `model` goes straight to its owner;
// otherwise the whole chain is tried. Each provider gets its own slice of the
// timeout so a hanging one cannot block the next.
async function runWithChain(cfg: Config, model: string | undefined, prompt: string, img: Image): Promise<Result> {
  const providers = model ? [ownerOf(model)] : cfg.chain
  const perProvider = Math.max(2000, Math.floor(cfg.timeoutMs / providers.length))
  let last: Result = { ok: false, error: "no provider available" }
  for (const provider of providers) {
    const chosen = model ?? cfg.models[provider] ?? DEFAULT_MODELS[provider]
    const r = await providerCall(cfg, provider, chosen, prompt, img, perProvider)
    if (isOk(r)) return r
    last = r
  }
  return last
}

// Dual mode: the same describe prompt to both NIM models, each section labelled.
// Used when describe/analyze are called without a `model`.
async function dualDescribe(cfg: Config, img: Image, blind: boolean, userPrompt: string): Promise<Result> {
  const prompt = describePrompt(blind, userPrompt)
  const sections: string[] = []
  let anyOk = false
  for (const [model, label] of DUAL_MODELS) {
    const r = await nimCall(cfg, model, prompt, img, cfg.timeoutMs)
    if (isOk(r)) anyOk = true
    sections.push(`═══ ${label} — ${model} ═══\n\n${isOk(r) ? r.text : "⚠️ FAILED: " + r.error}`)
  }
  return anyOk ? { ok: true, text: sections.join("\n\n").trim() } : { ok: false, error: "Dual NIM describe failed" }
}

async function nimCall(cfg: Config, model: string, prompt: string, img: Image, timeoutMs: number): Promise<Result> {
  const key = cfg.keys.nim
  if (!key) return { ok: false, error: "NVIDIA_API_KEY missing (config keys.nim)" }
  const body = {
    model,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } },
      ],
    }],
    max_tokens: 1024,
    temperature: 0.2,
  }
  try {
    const response = await fetch(`${cfg.baseUrls.nim}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, error: `NIM HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` }
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const text = json.choices?.[0]?.message?.content
    return text ? { ok: true, text: text.trim() } : { ok: false, error: "[EMPTY] no content from NIM" }
  } catch (e) {
    return { ok: false, error: `NIM fetch failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function geminiCall(cfg: Config, model: string, prompt: string, img: Image, timeoutMs: number): Promise<Result> {
  const key = cfg.keys.gemini
  if (!key) return { ok: false, error: "Gemini key missing (config keys.gemini)" }
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: img.mime, data: img.data } },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  }
  try {
    const response = await fetch(`${cfg.baseUrls.gemini}/models/${model}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, error: `Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 300)}` }
    const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
    const parts = json.candidates?.[0]?.content?.parts
    const text = Array.isArray(parts) ? parts.map((p) => p?.text ?? "").join("") : ""
    return text ? { ok: true, text: text.trim() } : { ok: false, error: "[Gemini] no text in response" }
  } catch (e) {
    return { ok: false, error: `Gemini fetch failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

// ── The three tools ──────────────────────────────────────────────────────────

// Argument contracts, pinned explicitly so execute() reads real types instead
// of opencode's untyped schema objects.
interface DescribeArgs {
  image_path: string
  blind: boolean
  prompt?: string
  model?: string
}
interface OcrArgs {
  image_path: string
  blind: boolean
  model?: string
}
interface AnalyzeArgs {
  image_path: string
  blind: boolean
  model?: string
}

const plugin: Plugin = async (_input, pluginOptions) => {
  const cfg = loadConfig(pluginOptions as Record<string, unknown> | undefined)

  return {
    tool: {
      describe: tool({
        description:
          `Vision describe: composition, layout, colors, objects, ALL visible text, context. ` +
          `blind (REQUIRED): true = reader cannot see the image — exhaustive spatial description; false = normal. ` +
          `DEFAULT (omit model) = DUAL mode: two NIM VLMs — structured overview + fine detail — labelled sections, best fidelity; prefer it. ` +
          `Single view ONLY for one-offs: "meta/llama-3.2-90b-vision-instruct" (overview), ` +
          `"nvidia/nemotron-nano-12b-v2-vl" (sharp detail), "meta/llama-3.2-11b-vision-instruct" (light), "gemini-3.6-flash". ` +
          `Flaky models — call independently.`,
        args: {
          image_path: tool.schema.string(),
          blind: tool.schema.boolean(),
          prompt: tool.schema.optional(tool.schema.string()),
          model: tool.schema.optional(tool.schema.string()),
        },
        async execute(args: DescribeArgs) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing required: image_path"
          if (typeof args.blind !== "boolean") return "Missing required: blind (true/false)"
          const prompt = args.prompt ?? ""
          const model = args.model ?? undefined
          try {
            const img = await resolveImage(args.image_path)
            if (model) {
              const r = await runWithChain(cfg, model, describePrompt(args.blind, prompt), img)
              return isOk(r) ? r.text : r.error
            }
            const d = await dualDescribe(cfg, img, args.blind, prompt)
            return isOk(d) ? d.text : d.error
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        },
      }),

      ocr: tool({
        description:
          `OCR: extract ALL visible text verbatim — screenshots, UI, documents, receipts, diagrams, photos, memes, whiteboards. ` +
          `Returns only the extracted text. blind (REQUIRED): true = reader cannot see the image. ` +
          `Use for anything text-bearing; never guess text from context.`,
        args: {
          image_path: tool.schema.string(),
          blind: tool.schema.boolean(),
          model: tool.schema.optional(tool.schema.string()),
        },
        async execute(args: OcrArgs) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing required: image_path"
          if (typeof args.blind !== "boolean") return "Missing required: blind (true/false)"
          try {
            const img = await resolveImage(args.image_path)
            const r = await runWithChain(cfg, args.model ?? undefined, OCR_PROMPT, img)
            return isOk(r) ? r.text : r.error
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        },
      }),

      analyze: tool({
        description:
          `Full vision analysis: source metadata + DUAL description + OCR in one call — screenshot/UI/document forensics, ` +
          `audits, evidence extraction, comprehensive understanding. Slower (multi-call); prefer describe for quick questions. ` +
          `blind (REQUIRED): true = reader cannot see the image — exhaustive spatial description. Omit model = DUAL mode.`,
        args: {
          image_path: tool.schema.string(),
          blind: tool.schema.boolean(),
          model: tool.schema.optional(tool.schema.string()),
        },
        async execute(args: AnalyzeArgs) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing required: image_path"
          if (typeof args.blind !== "boolean") return "Missing required: blind (true/false)"
          try {
            const img = await resolveImage(args.image_path)
            // Describe leg: dual mode by default, single model if overridden.
            const desc = args.model
              ? await runWithChain(cfg, args.model, describePrompt(args.blind, ""), img)
              : await dualDescribe(cfg, img, args.blind, "")
            const ocr = await runWithChain(cfg, undefined, OCR_PROMPT, img)
            const meta = args.image_path.startsWith("data:") ? "data: URL" : `path: ${args.image_path}`
            return [
              `📐 SOURCE`, meta,
              `\n🖼️  VISUAL DESCRIPTION\n${isOk(desc) ? desc.text : "⚠️ " + desc.error}`,
              `\n📄 TEXT CONTENT\n${isOk(ocr) ? ocr.text : "⚠️ " + ocr.error}`,
            ].join("\n")
          } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`
          }
        },
      }),
    },
  }
}

export default plugin
