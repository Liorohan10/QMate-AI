import { spawn, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import type { ScopedLogger } from '../../logging/types.js'

export interface CodexAppServerClientOptions {
  cliBin?: string
  cwd?: string
  logger?: ScopedLogger
  env?: Record<string, string | undefined>
}

interface PendingRequest {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

interface ActiveTurn {
  turnId: string
  text: string
  inputTokens: number
  outputTokens: number
  resolve: (result: { text: string; tokenUsage: { inputTokens: number; outputTokens: number } }) => void
  reject: (err: Error) => void
}

export class CodexAppServerClient {
  private cliBin: string
  private cwd: string
  private logger?: ScopedLogger
  private env: Record<string, string | undefined>

  private process: ChildProcess | null = null
  private rl: readline.Interface | null = null
  private nextId = 1
  private pendingRequests = new Map<number | string, PendingRequest>()
  private threadId: string | null = null
  private currentTurn: ActiveTurn | null = null
  private initPromise: Promise<void> | null = null
  private isClosing = false

  constructor(options: CodexAppServerClientOptions = {}) {
    this.cliBin = options.cliBin || process.env.CODEX_BIN || 'codex'
    this.cwd = options.cwd || process.cwd()
    this.logger = options.logger
    this.env = options.env || { ...process.env }
  }

  async start(): Promise<void> {
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      this.isClosing = false
      await this.spawnProcess()
      await this.handshake()
    })()

    return this.initPromise
  }

  private async spawnProcess(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.process = spawn(this.cliBin, ['app-server', '--stdio'], {
          cwd: this.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env,
        })
      } catch (err) {
        return reject(new Error(`Failed to spawn Codex CLI (${this.cliBin}): ${err instanceof Error ? err.message : String(err)}`))
      }

      this.process.on('error', (err) => {
        this.logger?.error('Codex CLI app-server process error', { error: err.message })
        if (this.currentTurn) {
          this.currentTurn.reject(new Error(`Codex app-server error: ${err.message}`))
          this.currentTurn = null
        }
        reject(new Error(`Failed to run Codex app-server (${this.cliBin}): ${err.message}`))
      })

      this.process.on('exit', (code, signal) => {
        if (!this.isClosing) {
          this.logger?.warn('Codex app-server process exited unexpectedly', { code, signal })
        }
        this.cleanup()
      })

      this.process.stderr?.on('data', (chunk) => {
        const str = chunk.toString().trim()
        if (str && !str.includes('INFO') && !str.includes('DEBUG')) {
          this.logger?.debug('Codex app-server stderr', { stderr: str })
        }
      })

      this.rl = readline.createInterface({ input: this.process.stdout! })
      this.rl.on('line', (line) => this.handleLine(line))

      // Give process a tick to ensure it didn't immediately fail spawn
      setTimeout(resolve, 50)
    })
  }

  private async handshake(): Promise<void> {
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'qmate-ai',
        version: '1.0.0',
      },
      capabilities: null,
    })

    const threadRes = await this.sendRequest('thread/start', {
      cwd: this.cwd,
      sandbox: 'read-only',
    })

    this.threadId = threadRes.thread?.id || null
    if (!this.threadId) {
      throw new Error('Codex app-server thread/start did not return a valid thread ID')
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return

    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const { resolve, reject } = this.pendingRequests.get(msg.id)!
      this.pendingRequests.delete(msg.id)
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      } else {
        resolve(msg.result)
      }
      return
    }

    if (msg.method) {
      this.handleNotification(msg.method, msg.params)
    }
  }

  private handleNotification(method: string, params: any): void {
    if (method === 'item/agentMessage/delta' && this.currentTurn) {
      if (params.delta?.text) {
        this.currentTurn.text += params.delta.text
      }
    } else if (method === 'item/completed' && this.currentTurn) {
      if (params.item?.type === 'agentMessage' && params.item?.text) {
        this.currentTurn.text = params.item.text
      }
    } else if (method === 'thread/tokenUsage/updated' && this.currentTurn) {
      const usage = params.tokenUsage?.total || params.tokenUsage
      if (usage) {
        this.currentTurn.inputTokens = usage.inputTokens || this.currentTurn.inputTokens
        this.currentTurn.outputTokens = usage.outputTokens || this.currentTurn.outputTokens
      }
    } else if (method === 'turn/completed' && this.currentTurn) {
      const turn = params.turn
      if (turn?.status === 'failed') {
        const errorMsg = turn.error?.message || 'Codex turn failed'
        this.currentTurn.reject(new Error(errorMsg))
      } else {
        this.currentTurn.resolve({
          text: this.currentTurn.text,
          tokenUsage: {
            inputTokens: this.currentTurn.inputTokens,
            outputTokens: this.currentTurn.outputTokens,
          },
        })
      }
      this.currentTurn = null
    }
  }

  sendRequest(method: string, params: any): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })
      const payload = JSON.stringify({ method, id, params }) + '\n'
      if (!this.process || !this.process.stdin?.writable) {
        this.pendingRequests.delete(id)
        return reject(new Error('Codex app-server stdin is not writable'))
      }
      this.process.stdin.write(payload)
    })
  }

  async runTurn(
    prompt: string,
    images: string[] = [],
    abortSignal?: AbortSignal,
  ): Promise<{ text: string; tokenUsage: { inputTokens: number; outputTokens: number } }> {
    await this.start()

    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error('Operation aborted')
    }

    const input: any[] = [
      { type: 'text', text: prompt, text_elements: [] },
      ...images.map((imgPath) => ({ type: 'localImage', path: imgPath })),
    ]

    const turnRes = await this.sendRequest('turn/start', {
      threadId: this.threadId,
      input,
    })

    const turnId = turnRes.turn?.id
    if (!turnId) {
      throw new Error('Codex app-server turn/start failed to return turnId')
    }

    return new Promise((resolve, reject) => {
      this.currentTurn = {
        turnId,
        text: '',
        inputTokens: 0,
        outputTokens: 0,
        resolve,
        reject,
      }

      if (abortSignal) {
        const onAbort = () => {
          this.sendRequest('turn/interrupt', {
            threadId: this.threadId,
            turnId,
          }).catch(() => {})
          if (this.currentTurn && this.currentTurn.turnId === turnId) {
            this.currentTurn.reject(abortSignal.reason ?? new Error('Operation aborted'))
            this.currentTurn = null
          }
        }
        abortSignal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  cleanup(): void {
    if (this.rl) {
      try {
        this.rl.close()
      } catch {}
      this.rl = null
    }
    if (this.process) {
      try {
        this.process.kill()
      } catch {}
      this.process = null
    }
    this.initPromise = null
    this.threadId = null
    this.pendingRequests.clear()
    this.currentTurn = null
  }

  close(): void {
    this.isClosing = true
    this.cleanup()
  }
}

let globalClient: CodexAppServerClient | null = null

export function getCodexAppServerClient(options?: CodexAppServerClientOptions): CodexAppServerClient {
  if (!globalClient) {
    globalClient = new CodexAppServerClient(options)
  }
  return globalClient
}

export function resetCodexAppServerClient(): void {
  if (globalClient) {
    globalClient.close()
    globalClient = null
  }
}
