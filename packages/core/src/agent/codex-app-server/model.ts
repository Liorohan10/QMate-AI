import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LanguageModel } from 'ai'
import { getCodexAppServerClient, type CodexAppServerClient } from './client.js'

export interface CodexAppServerModelConfig {
  model?: string
  client?: CodexAppServerClient
}

function extractJson(text: string): any {
  const trimmed = text.trim()

  // Try extracting from markdown code blocks
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim())
    } catch {}
  }

  // Try direct parse
  try {
    return JSON.parse(trimmed)
  } catch {}

  // Try finding bounding braces
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {}
  }

  return null
}

export class CodexAppServerModel {
  readonly specificationVersion = 'v3' as const
  readonly provider = 'codex-app-server'
  readonly modelId: string
  readonly supportedUrls = {}
  readonly defaultObjectGenerationMode = 'json' as const

  private client: CodexAppServerClient

  constructor(config: CodexAppServerModelConfig | string = {}, client?: CodexAppServerClient) {
    if (typeof config === 'string') {
      this.modelId = config || 'gpt-5.6-luna'
      this.client = client || getCodexAppServerClient()
    } else {
      this.modelId = config.model || 'gpt-5.6-luna'
      this.client = config.client || client || getCodexAppServerClient()
    }
  }

  async doGenerate(options: any): Promise<any> {
    const tempFiles: string[] = []

    try {
      let promptText = ''
      const localImages: string[] = []

      // Process prompt messages
      if (Array.isArray(options.prompt)) {
        for (const msg of options.prompt) {
          const role = msg.role || 'user'
          if (typeof msg.content === 'string') {
            promptText += `[${role.toUpperCase()}]: ${msg.content}\n\n`
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'text') {
                promptText += `[${role.toUpperCase()}]: ${part.text}\n\n`
              } else if (part.type === 'image' && part.image) {
                try {
                  const imgBuffer = Buffer.isBuffer(part.image)
                    ? part.image
                    : part.image instanceof Uint8Array
                      ? Buffer.from(part.image)
                      : typeof part.image === 'string' && part.image.startsWith('data:')
                        ? Buffer.from(part.image.split(',')[1] || '', 'base64')
                        : null

                  if (imgBuffer && imgBuffer.length > 0) {
                    const tmpPath = join(
                      tmpdir(),
                      `qmate-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`,
                    )
                    await fs.writeFile(tmpPath, imgBuffer)
                    tempFiles.push(tmpPath)
                    localImages.push(tmpPath)
                  }
                } catch {
                  // best effort image extraction
                }
              }
            }
          }
        }
      } else if (typeof options.prompt === 'string') {
        promptText = options.prompt
      }

      const rawTools = options.tools || options.mode?.tools || []
      const tools = Array.isArray(rawTools) ? rawTools : []
      const hasTools = tools.length > 0

      if (hasTools) {
        const toolList = tools
          .map((t: any) => {
            const schema = t.inputSchema || t.parameters || {}
            return `Tool "${t.name}": ${t.description || ''}\n  Input Schema: ${JSON.stringify(schema)}`
          })
          .join('\n\n')

        promptText += `\n\n[AVAILABLE ACTION TOOLS]\n${toolList}\n\n`
        promptText += `[CRITICAL TOOL INSTRUCTION]
You must select and call ONE action tool from the list above to proceed with the test step.
Respond with ONLY a JSON object (no markdown, no extra commentary) in this format:
{
  "toolName": "<exact name of selected tool>",
  "args": {
    <input fields matching the selected tool's schema>,
    "reasoning": "<explanation for selecting this action>",
    "confidence": <number from 0 to 1>,
    "stepComplete": <boolean: true if this finishes the step goal, false otherwise>,
    "stepFailed": <optional boolean: true if the step cannot be accomplished>
  }
}
`
      }

      // Execute turn via Codex CLI App Server
      const result = await this.client.runTurn(promptText, localImages, options.abortSignal)
      const rawText = result.text.trim()

      if (hasTools) {
        const parsed = extractJson(rawText)
        let toolName = 'click'
        let args: Record<string, unknown> = {}

        if (parsed) {
          toolName = parsed.toolName || parsed.action || (tools[0] as any)?.name || 'click'
          args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : parsed
        } else {
          args = {
            reasoning: rawText,
            confidence: 0.5,
            stepComplete: false,
          }
        }

        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              toolName,
              input: JSON.stringify(args),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: result.tokenUsage?.inputTokens || 0 },
            outputTokens: { total: result.tokenUsage?.outputTokens || 0 },
          },
          rawCall: { rawPrompt: options.prompt, rawSettings: {} },
        }
      }

      // Non-tool response (e.g. verifier, asserter, connection check)
      const parsedJson = extractJson(rawText)
      const textOutput = parsedJson ? JSON.stringify(parsedJson) : rawText

      return {
        content: [
          {
            type: 'text',
            text: textOutput,
          },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: result.tokenUsage?.inputTokens || 0 },
          outputTokens: { total: result.tokenUsage?.outputTokens || 0 },
        },
        rawCall: { rawPrompt: options.prompt, rawSettings: {} },
      }
    } finally {
      // Clean up temporary screenshots
      for (const file of tempFiles) {
        try {
          await fs.unlink(file)
        } catch {}
      }
    }
  }

  async doStream(options: any): Promise<any> {
    const result = await this.doGenerate(options)
    return {
      stream: new ReadableStream({
        start(controller) {
          for (const part of result.content) {
            if (part.type === 'text') {
              controller.enqueue({ type: 'text-delta', textDelta: part.text })
            }
          }
          controller.enqueue({
            type: 'finish',
            finishReason: result.finishReason,
            usage: result.usage,
          })
          controller.close()
        },
      }),
      rawCall: result.rawCall,
    }
  }
}

export function createCodexAppServerModel(config: CodexAppServerModelConfig = {}): CodexAppServerModel {
  return new CodexAppServerModel(config)
}
