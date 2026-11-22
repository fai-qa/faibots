import { z } from 'zod'
import type { JsonSchema, ToolContext, ToolDefinition, ToolResult } from '../contracts'

/** ToolDefinition plus the platform-only hook the registry understands. */
export interface PlatformToolDefinition extends ToolDefinition {
  /** A read that must recheck grants and must never replay or persist a previous result. */
  requiresLiveRead?: boolean
  /**
   * Skip the approval card for this call (e.g. file access inside the bot's workspace).
   * A resolved 'never' still wins.
   */
  autoAllow?(input: unknown, ctx: ToolContext): boolean
  /** Shown in the Tools tab: runs without asking inside the bot's workspace. */
  autoAllowedInWorkspace?: boolean
}

export const textResult = (text: string, display?: ToolResult['display']): ToolResult => ({
  content: [{ type: 'text', text }],
  ...(display && { display })
})

export const errorResult = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

/**
 * Define a tool from a zod schema: the JSON Schema is derived from it and every call is
 * validated against it, so execute() receives typed input or the model gets a clear error.
 */
export function defineTool<S extends z.ZodType>(spec: {
  name: string
  description: string
  schema: S
  source: ToolDefinition['source']
  defaultPermission: ToolDefinition['defaultPermission']
  activityLabel: string
  summarize?(input: z.infer<S>, ctx: ToolContext): string
  isAvailable?: ToolDefinition['isAvailable']
  autoAllow?(input: z.infer<S>, ctx: ToolContext): boolean
  autoAllowedInWorkspace?: boolean
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>
}): PlatformToolDefinition {
  const parse = (input: unknown) => spec.schema.safeParse(input ?? {})
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec.schema),
    source: spec.source,
    defaultPermission: spec.defaultPermission,
    activityLabel: spec.activityLabel,
    ...(spec.isAvailable && { isAvailable: spec.isAvailable }),
    ...(spec.autoAllowedInWorkspace && { autoAllowedInWorkspace: true }),
    summarize(input, ctx) {
      const parsed = parse(input)
      if (parsed.success && spec.summarize) return spec.summarize(parsed.data, ctx)
      return `${spec.activityLabel}: ${JSON.stringify(input)}`
    },
    autoAllow(input, ctx) {
      const parsed = parse(input)
      return parsed.success && !!spec.autoAllow?.(parsed.data, ctx)
    },
    async execute(input, ctx) {
      const parsed = parse(input)
      if (!parsed.success) return errorResult(`Invalid input for ${spec.name}:\n${z.prettifyError(parsed.error)}`)
      return spec.execute(parsed.data, ctx)
    }
  }
}
