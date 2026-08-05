export interface VisionModels {
  gemini?: string
  nim?: string
}

export interface VisionKeys {
  gemini?: string
  nim?: string
}

export interface VisionBaseUrls {
  gemini?: string
  nim?: string
}

export interface VisionOptions {
  /** "gemini" | "nim" | "chain" (default "chain") */
  provider?: string
  /** Fallback order, e.g. ["gemini","nim"] */
  chain?: string[]
  models?: VisionModels
  keys?: VisionKeys
  baseUrls?: VisionBaseUrls
  /** Request timeout in ms (default 60000) */
  timeout_ms?: number
}

/** Describe tool options (matches the vision_describe tool's Zod schema). */
export interface DescribeArgs {
  /** Absolute image path, https:// URL, or data: URL */
  image_path: string
  /** Optional custom question about the image */
  prompt?: string
  /** Optional vision model override */
  model?: string
}

export interface OcrArgs {
  image_path: string
  model?: string
}

export interface AnalyzeArgs {
  image_path: string
  model?: string
}

/**
 * The exported opencode plugin. Auto-discovered from
 * ~/.config/opencode/plugin/ (keys fall back to env vars:
 * NVIDIA_API_KEY, GEMINI_API_KEY, GOOGLE_API_KEY) or configured via a
 * [spec, options] plugin tuple.
 */
declare const plugin: (input: unknown, options?: VisionOptions) => Promise<{
  tool: Record<
    | "describe"
    | "ocr"
    | "analyze",
    {
      execute: (args: object, ctx: unknown) => Promise<string | { title?: string; output: string }>
    }
  >
}>

export default plugin