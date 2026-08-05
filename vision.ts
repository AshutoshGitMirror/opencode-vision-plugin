/**
 * vision.ts — in-process image analysis for opencode.
 *
 * Rewrite of the "opencode-vision-fork" Python MCP server as an opencode
 * plugin: no subprocess, no MCP stdio, no JSON-in-a-string config. Instead it
 * registers three custom tools (vision_describe, vision_ocr, vision_analyze)
 * and reads a nested-object config from the `plugin` array:
 *
 *   "plugin": [
 *     ["/abs/path/to/plugin-vision/vision.ts", {
 *       "provider": "chain",
 *       "chain": ["gemini", "nim"],
 *       "models": { "gemini": "gemini-3.6-flash", "nim": "meta/llama-3.2-90b-vision-instruct" },
 *       "keys":   { "gemini": "{env:GEMINI_API_KEY}", "nim": "{env:NVIDIA_API_KEY}" },
 *       "timeout": 60
 *     }]
 *   ]
 *
 * `{env:VAR}` interpolation is supported in every string value. Providers talk
 * directly to Google Gemini and NVIDIA NIM over HTTPS (fetch), so the only
 * dependency is the runtime node/bun's global fetch.
 */

import { type Plugin, tool } from "@opencode-ai/plugin"

// ── Types ───────────────────────────────────────────────────────────────

type Provider = "gemini" | "nim" | "chain"
type Result = { text: string } | { error: string }
function isErr(r: Result): r is { error: string } {
  return "error" in r && typeof (r as any).error === "string"
}

const DEFAULT_MODELS: Record<"gemini" | "nim", string> = {
  gemini: "gemini-3.6-flash",
  nim: "meta/llama-3.2-90b-vision-instruct",
}

// Dual-describe pair used when caller passes NO model to vision_describe.
const DUAL_MODELS: Array<[string, string]> = [
  ["meta/llama-3.2-90b-vision-instruct", "structured overall description"],
  ["nvidia/nemotron-nano-12b-v2-vl", "sharp low-level visual detail"],
]

interface Config {
  provider: string
  chain: string[]
  models: Record<string, string>
  keys: Record<string, string>
  baseUrls: Record<string, string>
  timeoutMs: number
}

function defaults(): Config {
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

// ── {env:VAR} interpolation ──────────────────────────────────────────────

const ENV_RE = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g

function interpStr(s: string): string {
  return s.replace(ENV_RE, (_, name) => process.env[name] ?? "")
}

function deepInterp(v: unknown): unknown {
  if (typeof v === "string") return interpStr(v)
  if (Array.isArray(v)) return v.map(deepInterp)
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v as any)) o[k] = deepInterp((v as any)[k])
    return o
  }
  return v
}

function applyEnvFallbacks(c: Config): Config {
  if (!c.keys.gemini && process.env.GEMINI_API_KEY) c.keys.gemini = process.env.GEMINI_API_KEY
  if (!c.keys.gemini && process.env.GOOGLE_API_KEY) c.keys.gemini = process.env.GOOGLE_API_KEY
  if (!c.keys.nim && process.env.NVIDIA_API_KEY) c.keys.nim = process.env.NVIDIA_API_KEY
  return c
}

function loadConfig(raw: Record<string, unknown> | undefined): Config {
  const c = defaults()
  if (!raw) return applyEnvFallbacks(c)
  const r = deepInterp(raw) as Record<string, unknown>
  if (typeof r.provider === "string") c.provider = r.provider as string
  if (Array.isArray(r.chain)) c.chain = (r.chain as string[]).filter(Boolean)
  const models = (r.models && typeof r.models === "object") ? r.models as Record<string, unknown> : {}
  for (const k of Object.keys(models)) if (typeof models[k] === "string") c.models[k] = models[k] as string
  c.models = Object.fromEntries(Object.entries(c.models).filter(([_, v]) => typeof v === "string")) as typeof c.models
  const keys = (r.keys && typeof r.keys === "object") ? r.keys as Record<string, unknown> : {}
  for (const k of Object.keys(keys)) if (typeof keys[k] === "string") c.keys[k] = keys[k] as string
  const bu = (r.baseUrls && typeof r.baseUrls === "object") ? r.baseUrls as Record<string, unknown> : {}
  for (const k of Object.keys(bu)) if (typeof bu[k] === "string") c.baseUrls[k] = bu[k] as string
  if (typeof r.timeout_ms === "number") c.timeoutMs = r.timeout_ms as number
  if (typeof r.timeout === "number") c.timeoutMs = r.timeout as number
  return applyEnvFallbacks(c)
}

// ── Image resolution ─────────────────────────────────────────────────────

async function resolveImage(ref: string): Promise<{ data: string; mime: string }> {
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(ref)) {
    const [head, b64] = ref.split(",", 2)
    const mime = /image\/([a-z0-9.+-]+)/i.exec(head)?.[0] ?? "image/png"
    return { data: b64 as string, mime }
  }
  if (/^https?:\/\//i.test(ref)) {
    const resp = await fetch(ref)
    if (!resp.ok) throw new Error(`Failed to fetch image URL: HTTP ${resp.status}`)
    const buf = new Uint8Array(await resp.arrayBuffer())
    const b64 = Buffer.from(buf).toString("base64")
    const mime = resp.headers.get("content-type")?.split(";")[0] || "image/png"
    return { data: b64, mime }
  }
  const { readFile } = await import("node:fs/promises")
  const pathObj = new URL("file:" + (await import("node:path")).resolve(ref))
  const buf = await readFile(pathObj)
  const ext = (await import("node:path")).extname(ref).toLowerCase()
  const MIME: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".tiff": "image/tiff", ".tif": "image/tiff", ".avif": "image/avif",
    ".heic": "image/heic", ".heif": "image/heif",
  }
  return { data: Buffer.from(buf).toString("base64"), mime: MIME[ext] ?? "image/png" }
}

// ── NIM (OpenAI-compatible) ─────────────────────────────────────────────

async function nimCall(cfg: Config, model: string, prompt: string, img: { data: string; mime: string }, timeoutMs: number): Promise<Result> {
  const key = cfg.keys.nim
  if (!key) return { error: "NVIDIA_API_KEY missing (config keys.nim)" }
  const url = `${cfg.baseUrls.nim}/chat/completions`
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
  let resp: Response
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e: any) {
    // Network / abort: convert to a chainable error so a hanging provider
    // falls through to the next instead of throwing past the chain.
    return { error: `NIM fetch failed: ${e?.message ?? String(e)}` }
  }
  if (!resp.ok) return { error: `NIM HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}` }
  const j = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
  const text = j.choices?.[0]?.message?.content
  if (!text) return { error: "[EMPTY] no content from NIM" }
  return { text: text.trim() }
}

// ── Gemini ──────────────────────────────────────────────────────────────

async function geminiCall(cfg: Config, model: string, prompt: string, img: { data: string; mime: string }, timeoutMs: number): Promise<Result> {
  const key = cfg.keys.gemini
  if (!key) return { error: "Gemini key missing (config keys.gemini)" }
  const url = `${cfg.baseUrls.gemini}/models/${model}:generateContent?key=${key}`
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: img.mime, data: img.data } },
      ],
    }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  }
  let resp: Response
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e: any) {
    return { error: `Gemini fetch failed: ${e?.message ?? String(e)}` }
  }
  if (!resp.ok) return { error: `Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}` }
  const j = await resp.json().catch(() => null) as any
  const parts = j?.candidates?.[0]?.content?.parts
  const text = Array.isArray(parts) ? parts.map((p: any) => p?.text ?? "").join("") : ""
  if (!text) return { error: "[Gemini] no text in response" }
  return { text: text.trim() }
}

// ── Provider dispatch + chain ───────────────────────────────────────────
// Dual-describe only makes sense for NIM models, so it's gated here.

const DESCRIBE_PROMPT = `Describe this image comprehensively and objectively. Include:
1. Main subject and composition
2. Colors, lighting, visual style
3. ALL visible text (transcribed exactly, preserve original language)
4. People, objects, environment
5. Context and purpose (UI screenshot, photo, diagram, document, etc.)
6. Technical quality and notable visual elements

Be precise. Do not speculate beyond what is visible.`

// Added for models that lean visually self-referential (e.g. Gemini) and may
// assume the reader can see the image. This forces an exhaustive, layout-aware
// description because the caller is effectively blind to the image.
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

// Per-model describe prompt selection: Gemini gets the blind-reader expansion,
// NIM vision models keep the tighter explicit prompt (good enough on its own).
function describePromptFor(model: string | undefined, prompt: string): string {
  if (prompt) return prompt
  const m = (model ?? "").toLowerCase()
  if (m.startsWith("gemini")) return `${DESCRIBE_PROMPT}\n\n${BLIND_READER_CLAUSE}`
  return DESCRIBE_PROMPT
}

const OCR_PROMPT = `Extract ALL text from this image EXACTLY as it appears.
Preserve the original language, capitalization, line breaks, and formatting.
Return ONLY the extracted text with no commentary.
If there is no readable text, say "[No text detected]".`

async function callSingle(cfg: Config, provider: string, method: "describe" | "ocr",
  prompt: string, img: { data: string; mime: string }, model?: string, budgetMs?: number): Promise<Result> {
  // Select the describe prompt per-model (Gemini gets the blind-reader clause).
  if (method === "describe") prompt = describePromptFor(model, prompt)
  const effective = prompt || (method === "describe" ? DESCRIBE_PROMPT : OCR_PROMPT)
  const remaining = () => (budgetMs ?? cfg.timeoutMs)
  if (provider === "gemini") return geminiCall(cfg, model ?? cfg.models.gemini ?? DEFAULT_MODELS.gemini, effective, img, remaining())
  if (provider === "nim") return nimCall(cfg, model ?? cfg.models.nim ?? DEFAULT_MODELS.nim, effective, img, remaining())
  // An explicit `model` override picks its own provider — never send a gemini
  // model id into the NIM fallback (or vice-versa). Only the chain path below may
  // fall through, and it must NOT reuse an overridden model.
  if (provider === "chain") {
    if (model) {
      const owner = model.startsWith("gemini") ? "gemini" : "nim"
      const r = await callSingle(cfg, owner, method, prompt, img, model, budgetMs ?? cfg.timeoutMs)
      if (!isErr(r)) return r
      return r
    }
  }
  // chain or unknown with NO model — give the whole budget to the chain, and cap
  // EACH provider so a hanging one can't eat the entire window and starve the next.
  const chain = cfg.chain.length ? cfg.chain : ["gemini", "nim"]
  const deadline = Date.now() + (budgetMs ?? cfg.timeoutMs)
  const budgetEach = Math.max(2000, Math.floor((budgetMs ?? cfg.timeoutMs) / chain.length))
  let last: Result = { error: "no provider" }
  for (const p of chain) {
    if (Date.now() >= deadline) { last = { error: `chain deadline exceeded (provider ${p} skipped)` }; break }
    const slice = Math.max(1000, Math.min(budgetEach, deadline - Date.now()))
    const r = await callSingle(cfg, p, method, prompt, img, undefined, slice)
    if (!isErr(r)) return r
    last = r
  }
  return last
}

async function dualDescribe(cfg: Config, img: { data: string; mime: string }, prompt: string): Promise<Result> {
  let text = ""
  let anyOk = false
  for (const [model, label] of DUAL_MODELS) {
    // Dual models are always hosted on NIM.
    const r = await nimCall(cfg, model, prompt || DESCRIBE_PROMPT, img, cfg.timeoutMs)
    if (!isErr(r)) {
      anyOk = true
      text += `═══ ${label} — ${model} ═══\n\n${r.text}\n\n`
    } else {
      text += `═══ ${label} — ${model} ═══\n\n⚠️ FAILED: ${r.error}\n\n`
    }
  }
  if (!anyOk) return { error: "Dual NIM describe failed" }
  return { text: text.trim() }
}

// ── Tool registry helpers ───────────────────────────────────────────────

function describeTool() {}

const plugin: Plugin = async (_input, pluginOptions) => {
  const cfg = loadConfig(pluginOptions)

  return {
    tool: {
      describe: tool({
        description:
          `Describe an image in detail: composition, colors, objects, all visible text, context.\n` +
          `PREFERRED default: call WITHOUT the model arg — this runs the built-in dual mode (two complementary ` +
          `NIM VLMs: structured + fine detail) and returns labelled sections. This is the best overall result; ` +
          `use it unless you have a specific reason not to.\n` +
          `Only set model when you specifically want ONE view, e.g. "meta/llama-3.2-90b-vision-instruct" ` +
          `(structured overview), "nvidia/nemotron-nano-12b-v2-vl" (sharp low-level detail), ` +
          `"meta/llama-3.2-11b-vision-instruct" (light), "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" (concise), ` +
          `"gemini-3.6-flash". RULES: (1) do NOT switch models across repeated calls — pick the default dual mode ` +
          `once and keep it, so results are comparable; (2) only pass model for a genuine one-off need, never to ` +
          `sample/experiment; (3) never pass a gemini model to a NIM task or vice-versa — each model belongs to its ` +
          `own provider.`,
        args: {
          image_path: tool.schema.string(),
          prompt: tool.schema.optional(tool.schema.string()),
          model: tool.schema.optional(tool.schema.string()),
        },
        async execute(args, ctx) {
          if (!args.image_path || typeof args.image_path !== "string" || !String(args.image_path).trim()) {
            return "Missing required: image_path"
          }
          const ref = String(args.image_path)
          const prompt = typeof args.prompt === "string" ? args.prompt : ""
          const model = typeof args.model === "string" && args.model ? args.model : undefined
          try {
            const img = await resolveImage(ref)
            if (!model) {
              const d = await dualDescribe(cfg, img, prompt)
              if (!isErr(d)) return d.text
            }
            const r = await callSingle(cfg, cfg.provider, "describe", prompt, img, model)
            return isErr(r) ? r.error : r.text
          } catch (e: any) {
            return `Error: ${e?.message ?? String(e)}`
          }
        },
      } as any),
      ocr: tool({
        description: "Extract all visible text from an image (path, URL, or data: URL). Returns only the extracted text.",
        args: {
          image_path: tool.schema.string(),
          model: tool.schema.optional(tool.schema.string()),
        },
        async execute(args) {
          if (!args.image_path || typeof args.image_path !== "string") return "Missing image_path"
          const model = typeof args.model === "string" && args.model ? args.model : undefined
          try {
            const img = await resolveImage(String(args.image_path))
            const r = await callSingle(cfg, cfg.provider, "ocr", "", img, model)
            return isErr(r) ? r.error : r.text
          } catch (e: any) {
            return `Error: ${e?.message ?? String(e)}`
          }
        },
      } as any),
      analyze: tool({
        description:
          `Heavyweight combined analysis: metadata + visual description + text extraction. ` +
          `Use ONLY when you need all three (e.g. document/screenshot forensics). ` +
          `For ordinary image understanding, prefer the lighter describe tool (dual mode default) instead; ` +
          `analyze is slower and costs extra calls. ` +
          `model is optional; omit it to get the default model.`,
        args: {
          image_path: tool.schema.string(),
          model: tool.schema.optional(tool.schema.string()),
        },
        async execute(args, ctx) {
          if (!args.image_path || typeof args.image_path !== "string") return "unknown image_path"
          const model = typeof args.model === "string" && args.model ? args.model : undefined
          const ref = String(args.image_path)
          try {
            const img = await resolveImage(ref)
            const desc = await callSingle(cfg, cfg.provider, "describe", "", img, model)
            const oc = await callSingle(cfg, cfg.provider, "ocr", OCR_PROMPT, img)
            const meta = ref.startsWith("data:") ? "data: URL" : `path: ${ref}`
            return [
              `📐 SOURCE`, meta,
              `\n🖼️  VISUAL DESCRIPTION\n${isErr(desc) ? "⚠️ " + desc.error : desc.text}`,
              `\n📄 TEXT CONTENT\n${isErr(oc) ? "⚠️ " + oc.error : oc.text}`,
            ].join("\n")
          } catch (e: any) {
            return `Error: ${e?.message ?? String(e)}`
          }
        },
      } as any),
    },
  }
}

export default plugin