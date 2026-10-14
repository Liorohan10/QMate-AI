import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerModel, createCodexAppServerModel } from '../model.js'
import type { CodexAppServerClient } from '../client.js'

describe('CodexAppServerModel', () => {
  it('exposes language model v3 metadata', () => {
    const mockClient = {} as unknown as CodexAppServerClient
    const model = new CodexAppServerModel({ model: 'gpt-5.6-luna', client: mockClient })

    expect(model.specificationVersion).toBe('v3')
    expect(model.provider).toBe('codex-app-server')
    expect(model.modelId).toBe('gpt-5.6-luna')
    expect(model.defaultObjectGenerationMode).toBe('json')
  })

  it('formats tool call from JSON response', async () => {
    const mockClient = {
      runTurn: vi.fn().mockResolvedValue({
        text: '```json\n{"toolName": "click", "args": {"selector": "#submit-btn"}}\n```',
        tokenUsage: { inputTokens: 50, outputTokens: 20 },
      }),
    } as unknown as CodexAppServerClient

    const model = new CodexAppServerModel({ model: 'gpt-5.6-luna', client: mockClient })

    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Click on the submit button',
            },
          ],
        },
      ],
      mode: {
        type: 'regular',
        tools: [
          {
            type: 'function',
            name: 'click',
            description: 'Click an element',
            parameters: {
              type: 'object',
              properties: { selector: { type: 'string' } },
              required: ['selector'],
            },
          },
        ],
      },
    })

    expect(mockClient.runTurn).toHaveBeenCalledWith(
      expect.stringContaining('AVAILABLE ACTION TOOLS'),
      [],
      undefined
    )

    expect(result.finishReason).toEqual({ unified: 'tool-calls', raw: 'tool_calls' })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toMatchObject({
      type: 'tool-call',
      toolName: 'click',
      input: JSON.stringify({ selector: '#submit-btn' }),
    })
    expect(result.usage).toEqual({
      inputTokens: { total: 50 },
      outputTokens: { total: 20 },
    })
  })

  it('returns text content when no tools are present', async () => {
    const mockClient = {
      runTurn: vi.fn().mockResolvedValue({
        text: 'The page title is correct and verification passed.',
        tokenUsage: { inputTokens: 40, outputTokens: 15 },
      }),
    } as unknown as CodexAppServerClient

    const model = new CodexAppServerModel({ model: 'gpt-5.6-luna', client: mockClient })

    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Verify the page title',
            },
          ],
        },
      ],
      mode: {
        type: 'regular',
      },
    })

    expect(result.finishReason).toEqual({ unified: 'stop', raw: 'stop' })
    expect(result.content).toHaveLength(1)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'The page title is correct and verification passed.',
    })
  })

  it('passes image parts as localImage to Codex client', async () => {
    const mockClient = {
      runTurn: vi.fn().mockResolvedValue({
        text: '```json\n{"toolName": "click", "args": {"selector": "#login"}}\n```',
        tokenUsage: { inputTokens: 100, outputTokens: 25 },
      }),
    } as unknown as CodexAppServerClient

    const model = new CodexAppServerModel({ model: 'gpt-5.6-luna', client: mockClient })
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const imageBytes = Uint8Array.from(Buffer.from(pngBase64, 'base64'))

    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Look at this screenshot and click login',
            },
            {
              type: 'image',
              image: imageBytes,
              mediaType: 'image/png',
            },
          ],
        },
      ],
      mode: {
        type: 'regular',
        tools: [{ name: 'click' }],
      },
    })

    expect(mockClient.runTurn).toHaveBeenCalledWith(
      expect.stringContaining('Look at this screenshot'),
      expect.arrayContaining([expect.stringMatching(/\.png$/)]),
      undefined
    )
    expect(result.finishReason.unified).toBe('tool-calls')
  })

  it('createCodexAppServerModel initializes client and returns model', () => {
    const mockClient = {} as unknown as CodexAppServerClient
    const model = createCodexAppServerModel({
      model: 'custom-codex-model',
      client: mockClient,
    })
    expect(model.modelId).toBe('custom-codex-model')
    expect(model.provider).toBe('codex-app-server')
  })
})
