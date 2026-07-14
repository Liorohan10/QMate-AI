import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, stat, readdir, rm } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, isAbsolute, basename, resolve, dirname, relative } from 'node:path'
import * as docx from 'docx'

import type { AttributePredicate, DashboardDatabase, InsightsBreakdownDimension, RunArtifactRow, RunRow, StepRow } from '../db/database.js'
import type { TestRunner } from '../execution/test-runner.js'
import type { JobQueue } from '../queue/job-queue.js'
import { MemoryCatalogManager, isValidMemoryScopeId, type MemoryScope } from '../memory/memory-catalog-manager.js'
import { extractTestFileMetadata, type SupportedPlatform, type TestFileManager } from '../tests/test-file-manager.js'
import type { ConfigManager } from '../config/index.js'
import { readJsonBody } from './body-parser.js'
import type { AnalyticsServiceConfig, LLMAuthProviderPlugin, ModelConfig, OAuthTokens } from '@vostride/agent-qa-core'
import { AuthStateNameSchema, buildAnalyticsEvent, buildInternalRunAttributes, captureAnalytics, mergeRunAttributes, readAuth, writeAuth, removeAuth, getAgentQaVersion, getAgentQaUpdateStatus, getProviderOptions, getLLMAuthProviderPlugin, listAuthStateMetadata, listLLMAuthProviderPlugins, ModelConfigSchema, NamedLLMConfigSchema, WorkspaceSchema, ServicesSchema, RegistrySchema, UseSchema, MobileAppStateSchema, hashStepInstruction, TimeoutConfigSchema, CacheConfigSchema, HealingConfigSchema, PlannerConfigSchema, LoggingConfigSchema, LogCaptureConfigSchema, AccessibilityConfigSchema, DashboardConfigSchema, McpConfigSchema, RecordingConfigSchema, BrowserConfigSchema, AnalyticsSchema, AgentQaConfigSchema, TestDefinitionSchema, parseEnvFile, serializeEnvFile, SecretStore, SecretRedactor, redactAuthStateValue, validateUserRunAttributes, discoverWorkspaceFiles, isWorkspacePathMatch, resolveAnalyticsStandardProperties, resolveMemoryRoot, resolveWorkspaceFileTarget } from '@vostride/agent-qa-core'
import type { ResolvedWorkspacePaths, RunAttributes, WorkspaceFileKind, WorkspaceFileRecord } from '@vostride/agent-qa-core'
import { parse as parseYaml } from 'yaml'

const LLM_PROVIDER_MODES = new Set([
  'openai-compatible',
  'anthropic-compatible',
  'gemini',
])
const API_KEY_CREDENTIAL_PROVIDERS = new Set([
  'openai-compatible',
  'anthropic-compatible',
  'gemini',
])
const LLM_TEST_UNAUTHENTICATED_MESSAGE = 'Testing without a saved credential.'
const LLM_TEST_AUTH_ERROR_MESSAGE = 'Authentication failed. Check the saved credential for this config.'
const LLM_TEST_MODEL_NOT_FOUND_MESSAGE = 'Model not found. Check the model name.'
const LLM_TEST_NETWORK_ERROR_MESSAGE = 'Network error. Check the exact base URL and try again.'
const DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS = 60_000
const REMOTE_LLM_CONNECTION_TEST_TIMEOUT_MS = 10_000
const LOCAL_COMPATIBLE_LLM_CONNECTION_TEST_TIMEOUT_MS = 120_000
const LOCAL_COMPATIBLE_LLM_PROVIDERS = new Set(['openai-compatible', 'anthropic-compatible'])
const PLUGIN_OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const DASHBOARD_PRODUCT_EVENT_NAMES = [
  'agent-qa.dashboard.opened',
  'agent-qa.dashboard.live_mode.started',
  'agent-qa.dashboard.entity.created',
] as const
type DashboardProductEventName = typeof DASHBOARD_PRODUCT_EVENT_NAMES[number]
const DASHBOARD_PRODUCT_EVENT_NAME_SET = new Set<DashboardProductEventName>(DASHBOARD_PRODUCT_EVENT_NAMES)
const DASHBOARD_PRODUCT_EVENT_PROPERTY_KEYS = {
  'agent-qa.dashboard.opened': [],
  'agent-qa.dashboard.live_mode.started': ['platform', 'entity_type'],
  'agent-qa.dashboard.entity.created': ['entity_type', 'outcome'],
} as const satisfies Record<DashboardProductEventName, readonly string[]>

type DashboardExecutionTimeoutSource =
  | 'test.use.timeout.test'
  | 'suite.use.timeout.test'
  | 'config.use.timeout.test'
  | 'none'

type ConfigSectionValidationResult =
  | { success: true }
  | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } }

interface DashboardExecutionTimeout {
  timeoutMs?: number
  source: DashboardExecutionTimeoutSource
  baseTimeoutMs?: number
  bufferMs?: number
}

function toProductProviderLabel(provider: string): string {
  const plugin = listLLMAuthProviderPlugins()
    .find((candidate) => candidate.credentialProviderId === provider)
  return plugin?.providerId ?? provider
}

function isKnownLLMProvider(provider: string): boolean {
  return LLM_PROVIDER_MODES.has(provider) || Boolean(getLLMAuthProviderPlugin(provider))
}

async function requirePluginAuthConfig(
  configManager: ConfigManager | undefined,
  configName: unknown,
  plugin: LLMAuthProviderPlugin,
): Promise<{ ok: true; configName: string } | { ok: false; error: string }> {
  const targetConfigName = typeof configName === 'string' ? configName.trim() : ''
  if (!targetConfigName) {
    return { ok: false, error: 'configName is required' }
  }
  if (!configManager) {
    return { ok: false, error: 'Config manager is required to save OAuth credentials' }
  }

  const config = await configManager.read() as { registry?: { llms?: unknown[] } }
  const llms = Array.isArray(config.registry?.llms) ? config.registry.llms : []
  const match = llms.find((item) => {
    return Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as { name?: unknown }).name === targetConfigName
  }) as { provider?: unknown } | undefined

  if (!match) {
    return { ok: false, error: `LLM config "${targetConfigName}" not found` }
  }
  if (match.provider !== plugin.providerId) {
    return { ok: false, error: `LLM config "${targetConfigName}" uses ${String(match.provider)}, not ${plugin.providerId}` }
  }

  return { ok: true, configName: targetConfigName }
}

async function requireCredentialConfig(
  configManager: ConfigManager | undefined,
  configName: unknown,
  provider: string,
): Promise<{ ok: true; configName: string } | { ok: false; error: string }> {
  const targetConfigName = typeof configName === 'string' ? configName.trim() : ''
  if (!targetConfigName) {
    return { ok: false, error: 'configName is required' }
  }
  if (!API_KEY_CREDENTIAL_PROVIDERS.has(provider)) {
    return { ok: false, error: 'provider must support typed credentials' }
  }
  if (!configManager) {
    return { ok: false, error: 'Config manager is required to save credentials' }
  }

  const config = await configManager.read() as { registry?: { llms?: unknown[] } }
  const llms = Array.isArray(config.registry?.llms) ? config.registry.llms : []
  const match = llms.find((item) => {
    return Boolean(item)
      && typeof item === 'object'
      && !Array.isArray(item)
      && (item as { name?: unknown }).name === targetConfigName
  }) as { provider?: unknown } | undefined

  if (!match) {
    return { ok: false, error: `LLM config "${targetConfigName}" not found` }
  }
  if (match.provider !== provider) {
    return { ok: false, error: `LLM config "${targetConfigName}" uses ${String(match.provider)}, not ${provider}` }
  }

  return { ok: true, configName: targetConfigName }
}

type DashboardAuthCredential =
  | { type: 'oauth'; provider?: string; tokens: { expires: number } }
  | { type: 'api'; provider?: string; key?: string }
  | { type: 'bearer'; provider: string; token?: string }

interface DashboardLLMProviderMetadata {
  id: string
  label: string
  auth:
    | { kind: 'api-key'; credentialTypes: Array<'api-key' | 'bearer-token'>; optional?: boolean }
    | { kind: 'oauth-plugin'; mode: 'browser-poll' | 'manual-code'; buttonLabel?: string }
  modelAdapter?: 'openai-responses' | 'anthropic-messages'
}

interface PluginOAuthSession {
  providerId: string
  credentialProviderId: string
  configName: string
  sessionState?: unknown
  cleanup?: () => void
  status: 'pending' | 'completed' | 'error'
  expiresAt: number
  error?: string
}

function builtinLLMProviderMetadata(): DashboardLLMProviderMetadata[] {
  return [
    {
      id: 'openai-compatible',
      label: 'OpenAI-compatible',
      auth: { kind: 'api-key', credentialTypes: ['api-key'], optional: true },
      modelAdapter: 'openai-responses',
    },
    {
      id: 'anthropic-compatible',
      label: 'Anthropic-compatible',
      auth: { kind: 'api-key', credentialTypes: ['api-key', 'bearer-token'], optional: true },
      modelAdapter: 'anthropic-messages',
    },
    {
      id: 'gemini',
      label: 'Gemini',
      auth: { kind: 'api-key', credentialTypes: ['api-key'] },
    },
  ]
}

function serializeAuthProviderPlugin(plugin: LLMAuthProviderPlugin): DashboardLLMProviderMetadata {
  return {
    id: plugin.providerId,
    label: plugin.label,
    modelAdapter: plugin.modelAdapter,
    auth: {
      kind: 'oauth-plugin',
      mode: plugin.dashboardAuth.mode,
      ...(plugin.dashboardAuth.buttonLabel ? { buttonLabel: plugin.dashboardAuth.buttonLabel } : {}),
    },
  }
}

type DashboardRuntimeLLMConfig = Pick<
  ModelConfig,
  'provider' | 'model' | 'apiKey' | 'authToken' | 'baseURL' | 'providerHeaders'
> & {
  screenshotSize?: number
  effectiveResolution?: number
  modelAdapter?: 'openai-responses' | 'anthropic-messages'
}

const writeDashboardAuth = writeAuth as unknown as (
  provider: string,
  credential: DashboardAuthCredential,
) => Promise<void>

type DashboardResolvedRuntimeLLM =
  | { ok: true; llmConfig: DashboardRuntimeLLMConfig; authFetch?: typeof globalThis.fetch }
  | { ok: false; error: string }

function normalizeRuntimeLLMConfig(raw: unknown): { configName: string; config: DashboardRuntimeLLMConfig } | undefined {
  if (!isPlainRecord(raw)) return undefined
  if (typeof raw.name !== 'string' || !raw.name.trim()) return undefined
  if (typeof raw.provider !== 'string' || !raw.provider.trim()) return undefined
  if (typeof raw.model !== 'string' || !raw.model.trim()) return undefined

  const config: DashboardRuntimeLLMConfig = {
    provider: raw.provider,
    model: raw.model,
  }
  if (typeof raw.baseURL === 'string') config.baseURL = raw.baseURL
  if (isPlainRecord(raw.providerHeaders)) {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw.providerHeaders)) {
      if (typeof value === 'string') headers[key] = value
    }
    config.providerHeaders = headers
  }
  if (typeof raw.screenshotSize === 'number') config.screenshotSize = raw.screenshotSize
  if (typeof raw.effectiveResolution === 'number') config.effectiveResolution = raw.effectiveResolution

  return { configName: raw.name, config }
}

async function resolveDashboardRuntimeLLM(
  configManager: ConfigManager | undefined,
  fallbackLLMConfig: DashboardRuntimeLLMConfig | undefined,
  fallbackAuthFetch: typeof globalThis.fetch | undefined,
): Promise<DashboardResolvedRuntimeLLM> {
  if (!configManager) {
    if (!fallbackLLMConfig) {
      return { ok: false, error: 'LLM not configured. Set up LLM provider in settings.' }
    }
    return { ok: true, llmConfig: fallbackLLMConfig, authFetch: fallbackAuthFetch }
  }

  const rawConfig = await configManager.read()
  const registry = isPlainRecord(rawConfig.registry) ? rawConfig.registry : {}
  const use = isPlainRecord(rawConfig.use) ? rawConfig.use : {}
  const llms = Array.isArray(registry.llms) ? registry.llms : []
  const selectedName = typeof use.llm === 'string' ? use.llm : undefined
  const selected = selectedName
    ? llms.find((candidate) => isPlainRecord(candidate) && candidate.name === selectedName)
    : llms[0]

  const normalized = normalizeRuntimeLLMConfig(selected)
  if (!normalized) {
    if (!fallbackLLMConfig) {
      return { ok: false, error: 'LLM not configured. Set up LLM provider in settings.' }
    }
    return { ok: true, llmConfig: fallbackLLMConfig, authFetch: fallbackAuthFetch }
  }

  const coreAuth = await import('@vostride/agent-qa-core') as typeof import('@vostride/agent-qa-core') & {
    resolveLLMAuth: (
      configName: string,
      config: DashboardRuntimeLLMConfig,
    ) => Promise<
      | { kind: 'api-key'; apiKey: string }
      | { kind: 'bearer-token'; token: string }
      | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter: 'openai-responses' | 'anthropic-messages' }
      | { kind: 'unauthenticated'; message: string }
      | { kind: 'missing'; message: string }
    >
  }
  const auth = await coreAuth.resolveLLMAuth(normalized.configName, normalized.config)
  if (auth.kind === 'missing') {
    return { ok: false, error: auth.message }
  }

  const runtimeConfig: DashboardRuntimeLLMConfig = { ...normalized.config }
  let resolvedAuthFetch: typeof globalThis.fetch | undefined
  if (auth.kind === 'api-key') {
    runtimeConfig.apiKey = auth.apiKey
  } else if (auth.kind === 'bearer-token') {
    runtimeConfig.authToken = auth.token
  } else if (auth.kind === 'auth-fetch') {
    runtimeConfig.modelAdapter = auth.modelAdapter
    resolvedAuthFetch = auth.fetch
  }

  return { ok: true, llmConfig: runtimeConfig, authFetch: resolvedAuthFetch }
}

function cleanupPluginOAuthSession(session: PluginOAuthSession): void {
  const cleanup = session.cleanup
  session.cleanup = undefined
  if (!cleanup) return
  try {
    cleanup()
  } catch {
    // Best-effort cleanup for plugin-owned local callback servers.
  }
}

function pruneExpiredPluginOAuthSessions(sessions: Map<string, PluginOAuthSession>, now = Date.now()): void {
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) {
      cleanupPluginOAuthSession(session)
      sessions.delete(sessionId)
    }
  }
}

function extractProviderErrorMessage(err: unknown): { message: string; statusCode?: number } {
  const errObj = err as Record<string, unknown>
  const statusCode = errObj?.statusCode as number | undefined
  const responseBody = errObj?.responseBody as string | undefined
  const data = errObj?.data as Record<string, unknown> | undefined
  const apiError = data?.error as Record<string, string> | undefined

  let message = err instanceof Error ? err.message : String(err)

  if (apiError?.message && apiError.message !== 'Error') {
    message = apiError.message
  } else if (data?.detail && typeof data.detail === 'string') {
    message = data.detail
  } else if (responseBody) {
    try {
      const body = JSON.parse(responseBody)
      if (body?.detail) message = body.detail
      else if (body?.error?.message && body.error.message !== 'Error') message = body.error.message
    } catch {
      // response body was not JSON
    }
  }

  return { message, statusCode }
}

function classifyProviderError(message: string, statusCode?: number): string {
  const fullContext = `${message} ${statusCode ?? ''}`
  if (/auth|unauthorized|401|invalid.*key|permission/i.test(fullContext)) {
    return 'auth_error'
  }
  if (/model.*not.*support|model.*not.*found|not found|404|does not exist/i.test(fullContext)) {
    return 'model_not_found'
  }
  if (/ECONNREFUSED|ENOTFOUND|timeout|abort|fetch failed|network/i.test(fullContext)) {
    return 'network_error'
  }
  if (/rate|429|quota|limit/i.test(fullContext)) {
    return 'rate_limit'
  }
  if (/invalid_request|400|bad request/i.test(fullContext)) {
    return 'invalid_request'
  }
  return 'provider_error'
}

function publicLLMTestMessage(category: string, providerMessage: string): string {
  switch (category) {
    case 'auth_error':
      return LLM_TEST_AUTH_ERROR_MESSAGE
    case 'model_not_found':
      return LLM_TEST_MODEL_NOT_FOUND_MESSAGE
    case 'network_error':
      return LLM_TEST_NETWORK_ERROR_MESSAGE
    case 'provider_error':
      return `Connection failed. ${providerMessage}`
    default:
      return providerMessage
  }
}

function isLocalLLMBaseURL(baseURL: unknown): boolean {
  if (typeof baseURL !== 'string' || !baseURL.trim()) return false
  try {
    const url = new URL(baseURL)
    const hostname = url.hostname.toLowerCase()
    return hostname === 'localhost'
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || hostname === '[::1]'
      || hostname.startsWith('127.')
      || hostname.endsWith('.local')
  } catch {
    return false
  }
}

function llmConnectionTestTimeoutMs(config: { provider?: unknown; baseURL?: unknown }): number {
  // Connectivity probes are config-screen smoke checks only; real run execution
  // uses configured test timeout metadata and does not read this value.
  if (LOCAL_COMPATIBLE_LLM_PROVIDERS.has(String(config.provider)) && isLocalLLMBaseURL(config.baseURL)) {
    return LOCAL_COMPATIBLE_LLM_CONNECTION_TEST_TIMEOUT_MS
  }
  return REMOTE_LLM_CONNECTION_TEST_TIMEOUT_MS
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost')
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(body)
}

function notFound(res: ServerResponse, message = 'Not found'): void {
  json(res, { error: message }, 404)
}

function cors(res: ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end()
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getConfiguredAuthStateDir(config: Record<string, unknown>): string | undefined {
  const services = isPlainRecord(config.services) ? config.services : undefined
  const authState = services && isPlainRecord(services.authState) ? services.authState : undefined
  return typeof authState?.dir === 'string' ? authState.dir : undefined
}

function getSessionTargetNameForAuthState(session: { getState?: () => unknown } | undefined): string {
  if (!session || typeof session.getState !== 'function') return 'selected target'
  try {
    const state = session.getState()
    if (isPlainRecord(state) && typeof state.targetName === 'string' && state.targetName.trim().length > 0) {
      return state.targetName.trim()
    }
  } catch {
    // Do not let state serialization failures leak into auth-state responses.
  }
  return 'selected target'
}

function buildAuthStateSaveErrorMessage(
  stateName: string,
  targetName: string,
  error: unknown,
): { status: number; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  if (/already exists/i.test(raw)) {
    return {
      status: 409,
      message: `Auth state "${stateName}" for target "${targetName}" already exists. Use replace=true to replace it.`,
    }
  }

  if (/web Live Mode|not ready|executing|busy/i.test(raw)) {
    return {
      status: 409,
      message: `Could not save auth state "${stateName}" for target "${targetName}".`,
    }
  }

  return {
    status: 500,
    message: `Could not save auth state "${stateName}" for target "${targetName}".`,
  }
}

function isDashboardProductEventName(value: unknown): value is DashboardProductEventName {
  return typeof value === 'string' && DASHBOARD_PRODUCT_EVENT_NAME_SET.has(value as DashboardProductEventName)
}

function filterDashboardProductEventProperties(
  name: DashboardProductEventName,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const allowedKeys = DASHBOARD_PRODUCT_EVENT_PROPERTY_KEYS[name]
  const filtered: Record<string, unknown> = {}
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      filtered[key] = properties[key]
    }
  }
  return filtered
}

async function readAnalyticsServiceConfig(configManager: ConfigManager | undefined): Promise<AnalyticsServiceConfig> {
  if (!configManager) return {}

  try {
    const config = await configManager.read() as { analytics?: { privacy?: unknown } } | undefined
    if (config?.analytics?.privacy === true) {
      return { analytics: { privacy: true } }
    }
  } catch {
    // Fail closed for telemetry while keeping the HTTP route non-blocking.
    return { analytics: { privacy: true } }
  }
  return {}
}

function getPathInsideDir(candidatePath: string, rootDir: string): string | null {
  const relativePath = relative(rootDir, candidatePath)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null
  }
  return relativePath
}

function isPlainFileName(value: string): boolean {
  const fileName = value.trim()
  return fileName.length > 0
    && fileName !== '.'
    && fileName !== '..'
    && !isAbsolute(fileName)
    && fileName === basename(fileName)
    && !/[\\/\0]/.test(fileName)
}

function normalizeRunFilterValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  return trimmed.length > 0 ? trimmed : null
}

function buildRunRequestAttributes(input: {
  trigger: 'dashboard' | 'api' | 'mcp'
  runner?: 'local' | 'browserstack'
  userAttributes?: unknown
}): RunAttributes {
  const internal = buildInternalRunAttributes({
    trigger: input.trigger,
    runner: input.runner ?? 'local',
  })
  const user = validateUserRunAttributes(input.userAttributes, 'run attributes')
  return mergeRunAttributes(internal, user)
}

function parseDashboardRunTriggerSource(value: unknown): { ok: true; trigger: 'dashboard' | 'mcp' } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, trigger: 'dashboard' }
  if (value === 'dashboard' || value === 'mcp') return { ok: true, trigger: value }
  return { ok: false, error: 'triggerSource must be one of: dashboard, mcp' }
}

function parseAttributePredicates(searchParams: URLSearchParams): { ok: true; predicates: AttributePredicate[] } | { ok: false; error: string } {
  const predicates = new Map<string, AttributePredicate>()
  for (const [paramKey, value] of searchParams.entries()) {
    const match = /^attributes\[([^\]]*)\](?:\[(regex)\])?$/.exec(paramKey)
    if (!match) continue
    const key = match[1]
    const mode = match[2] === 'regex' ? 'regex' : 'exact'
    if (!key.trim()) return { ok: false, error: 'Attribute key must be non-empty' }
    if (!value.trim()) return { ok: false, error: 'Attribute value must be non-empty' }
    const existing = predicates.get(key)
    if (existing && existing.mode !== mode) {
      return { ok: false, error: `Cannot combine exact and regex attribute filters for "${key}"` }
    }
    if (mode === 'regex') {
      try {
        new RegExp(value)
      } catch {
        return { ok: false, error: `Invalid attribute regex for "${key}"` }
      }
    }
    predicates.set(key, { key, value, mode })
  }
  return { ok: true, predicates: [...predicates.values()] }
}

function parseAnalyticsScopePredicates(config: Record<string, unknown> | undefined): { ok: true; predicates: AttributePredicate[] } | { ok: false; error: string } {
  const analytics = config?.analytics
  if (!analytics || typeof analytics !== 'object' || Array.isArray(analytics)) return { ok: true, predicates: [] }
  const passRateScope = (analytics as Record<string, unknown>).passRateScope
  if (!passRateScope || typeof passRateScope !== 'object' || Array.isArray(passRateScope)) return { ok: true, predicates: [] }
  const attributes = (passRateScope as Record<string, unknown>).attributes
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return { ok: true, predicates: [] }

  const predicates: AttributePredicate[] = []
  for (const [key, rawValue] of Object.entries(attributes)) {
    if (!key.trim()) return { ok: false, error: 'analytics.passRateScope attribute key must be non-empty' }
    if (typeof rawValue === 'string') {
      if (!rawValue.trim()) return { ok: false, error: `analytics.passRateScope attribute "${key}" must be non-empty` }
      predicates.push({ key, value: rawValue, mode: 'exact' })
      continue
    }
    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && typeof (rawValue as { regex?: unknown }).regex === 'string') {
      const regex = (rawValue as { regex: string }).regex
      if (!regex.trim()) return { ok: false, error: `analytics.passRateScope attribute "${key}" regex must be non-empty` }
      try {
        new RegExp(regex)
      } catch {
        return { ok: false, error: `Invalid analytics.passRateScope regex for "${key}"` }
      }
      predicates.push({ key, value: regex, mode: 'regex' })
    }
  }
  return { ok: true, predicates }
}

function validateAnalyticsPassRateScope(value: unknown): ConfigSectionValidationResult {
  const result = AnalyticsSchema.shape.passRateScope.safeParse(value)
  if (result.success) return { success: true }
  return {
    success: false,
    error: {
      issues: result.error.issues.map((issue) => ({
        message: issue.message,
        path: issue.path,
      })),
    },
  }
}

async function readAnalyticsScopePredicates(configManager: ConfigManager | undefined): Promise<{ ok: true; predicates: AttributePredicate[] } | { ok: false; error: string }> {
  if (!configManager) return { ok: true, predicates: [] }
  const config = await configManager.read()
  const parsedConfig = AgentQaConfigSchema.safeParse(config)
  if (!parsedConfig.success) {
    return { ok: true, predicates: [] }
  }
  return parseAnalyticsScopePredicates(parsedConfig.data as Record<string, unknown>)
}

function calculateFlakyMetrics(runs: RunRow[]): { score: number; statusCount: number } {
  const statuses = runs
    .filter(r => r.status === 'passed' || r.status === 'failed')
    .map(r => r.status)
  let alternations = 0
  for (let i = 1; i < statuses.length; i++) {
    if (statuses[i] !== statuses[i - 1]) alternations++
  }
  return {
    score: statuses.length > 1 ? alternations / (statuses.length - 1) : 0,
    statusCount: statuses.length,
  }
}

function normalizeSupportedPlatform(value: unknown): SupportedPlatform | null {
  if (value !== 'web' && value !== 'android' && value !== 'ios') return null
  return value
}

function parseIsoDateQueryParam(
  value: string | null,
  field: 'from' | 'to',
): { ok: true; value?: string } | { ok: false; error: string } {
  if (!value) return { ok: true, value: undefined }
  return Number.isNaN(Date.parse(value))
    ? { ok: false, error: `${field} must be a valid ISO date` }
    : { ok: true, value }
}

function parseBoundedIntegerQueryParam(
  value: string | null,
  field: string,
  min: number,
  max: number,
  fallback: number,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!value) return { ok: true, value: fallback }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `${field} must be an integer` }
  }
  return { ok: true, value: Math.min(max, Math.max(min, parsed)) }
}

function getTargetPlatformMap(config: unknown): Map<string, SupportedPlatform> {
  const targetsValue = (config as {
    registry?: { targets?: Record<string, { platform?: unknown }> }
  }).registry?.targets

  const targetPlatforms = new Map<string, SupportedPlatform>()
  if (!targetsValue || typeof targetsValue !== 'object') return targetPlatforms

  for (const [targetName, targetConfig] of Object.entries(targetsValue)) {
    const platform = normalizeSupportedPlatform(targetConfig?.platform)
    if (platform) targetPlatforms.set(targetName, platform)
  }

  return targetPlatforms
}

async function readTargetPlatformMap(configManager?: ConfigManager): Promise<Map<string, SupportedPlatform>> {
  if (!configManager) return new Map()
  try {
    const config = await configManager.read()
    return getTargetPlatformMap(config)
  } catch {
    return new Map()
  }
}

function parseTimeoutConfigTestTimeoutMs(timeoutConfig: unknown): number | undefined {
  if (timeoutConfig && typeof timeoutConfig === 'object' && !Array.isArray(timeoutConfig)) {
    const transformedTimeout = (timeoutConfig as { test?: unknown }).test
    if (typeof transformedTimeout === 'number' && Number.isFinite(transformedTimeout) && transformedTimeout > 0) {
      return transformedTimeout
    }
  }
  const parsed = TimeoutConfigSchema.partial().safeParse(timeoutConfig)
  if (!parsed.success) return undefined
  const testTimeout = parsed.data.test
  return typeof testTimeout === 'number' && Number.isFinite(testTimeout) && testTimeout > 0
    ? testTimeout
    : undefined
}

function parseUseTestTimeoutMs(useConfig: unknown): number | undefined {
  if (!useConfig || typeof useConfig !== 'object' || Array.isArray(useConfig)) return undefined
  return parseTimeoutConfigTestTimeoutMs((useConfig as { timeout?: unknown }).timeout)
}

async function readConfigTestTimeoutMs(configManager?: ConfigManager): Promise<number | undefined> {
  if (!configManager) return undefined
  try {
    const config = await configManager.read()
    const parsed = AgentQaConfigSchema.safeParse(config)
    if (parsed.success) {
      return parseUseTestTimeoutMs(parsed.data.use)
    }
    return parseUseTestTimeoutMs((config as { use?: unknown }).use)
  } catch {
    return undefined
  }
}

function readTestYamlTimeoutMs(content: string): number | undefined {
  try {
    const parsedYaml = parseYaml(content)
    const parsedTest = TestDefinitionSchema.safeParse(parsedYaml)
    if (parsedTest.success) {
      return parseUseTestTimeoutMs(parsedTest.data.use)
    }
    return parseUseTestTimeoutMs((parsedYaml as { use?: unknown } | null | undefined)?.use)
  } catch {
    return undefined
  }
}

function readSuiteYamlTimeoutMs(content: string): number | undefined {
  try {
    const parsedYaml = parseYaml(content) as { use?: unknown } | null | undefined
    return parseUseTestTimeoutMs(parsedYaml?.use)
  } catch {
    return undefined
  }
}

function parseUseParallel(useConfig: unknown): boolean | undefined {
  if (!isRecord(useConfig)) return undefined
  return typeof useConfig.parallel === 'boolean' ? useConfig.parallel : undefined
}

async function readConfigUseParallel(configManager?: ConfigManager): Promise<boolean | undefined> {
  if (!configManager) return undefined
  try {
    const config = await configManager.read()
    const parsed = AgentQaConfigSchema.safeParse(config)
    if (parsed.success) {
      return parseUseParallel(parsed.data.use)
    }
    return parseUseParallel((config as { use?: unknown }).use)
  } catch {
    return undefined
  }
}

function readSuiteYamlParallel(content: string): boolean | undefined {
  try {
    const parsedYaml = parseYaml(content) as { use?: unknown } | null | undefined
    return parseUseParallel(parsedYaml?.use)
  } catch {
    return undefined
  }
}

function withDashboardExecutionBuffer(
  baseTimeoutMs: number | undefined,
  source: DashboardExecutionTimeoutSource,
): DashboardExecutionTimeout {
  if (!baseTimeoutMs) {
    return { source: 'none' }
  }
  return {
    timeoutMs: baseTimeoutMs + DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS,
    source,
    baseTimeoutMs,
    bufferMs: DASHBOARD_EXECUTION_TIMEOUT_BUFFER_MS,
  }
}

async function resolveDashboardExecutionTimeout(opts: {
  file?: string
  normalizedTestPath?: string
  testFileManager?: TestFileManager
  configManager?: ConfigManager
}): Promise<DashboardExecutionTimeout> {
  if (opts.file) {
    if (opts.testFileManager) {
      try {
        const testContent = await opts.testFileManager.read(opts.normalizedTestPath ?? opts.file)
        const testTimeout = readTestYamlTimeoutMs(testContent)
        if (testTimeout) {
          return withDashboardExecutionBuffer(testTimeout, 'test.use.timeout.test')
        }
      } catch {
        // Fall through to config timeout for draft or unreadable test files.
      }
    }
  }

  const configTimeout = await readConfigTestTimeoutMs(opts.configManager)
  return withDashboardExecutionBuffer(configTimeout, configTimeout ? 'config.use.timeout.test' : 'none')
}

function toExecutionTimeoutMetadata(timeout: DashboardExecutionTimeout): Record<string, unknown> {
  if (!timeout.timeoutMs) {
    return { timeoutSource: timeout.source }
  }
  return {
    timeout: timeout.timeoutMs,
    timeoutSource: timeout.source,
    timeoutBaseMs: timeout.baseTimeoutMs,
    timeoutBufferMs: timeout.bufferMs,
  }
}

function resolveEffectivePlatform(
  platform: string | null | undefined,
  targetName: string | null | undefined,
  targetPlatforms: Map<string, SupportedPlatform>,
  fallbackPlatform?: string | null,
): SupportedPlatform | null {
  const explicitPlatform = normalizeSupportedPlatform(platform)
  if (explicitPlatform) return explicitPlatform

  if (targetName) {
    const targetPlatform = targetPlatforms.get(targetName)
    if (targetPlatform) return targetPlatform
  }

  return normalizeSupportedPlatform(fallbackPlatform)
}

function extractRunTargetName(testFileContent: string | null | undefined): string | null {
  if (!testFileContent) return null
  return extractTestFileMetadata(testFileContent).targetName
}

type EnrichedRunRow = RunRow & {
  targetName: string | null
  tests?: EnrichedRunRow[]
}

function enrichRunRow(
  run: RunRow,
  targetPlatforms: Map<string, SupportedPlatform>,
  tests?: EnrichedRunRow[],
): EnrichedRunRow {
  const metadata = run.testFileContent ? extractTestFileMetadata(run.testFileContent) : null
  let targetName = metadata?.targetName ?? extractRunTargetName(run.testFileContent)
  if (!targetName && tests && tests.length > 0) {
    const uniqueChildTargets = [...new Set(
      tests
        .map((test) => test.targetName)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    )]
    if (uniqueChildTargets.length === 1) {
      targetName = uniqueChildTargets[0]
    }
  }

  const uniqueChildPlatforms = tests
    ? [...new Set(
        tests
          .map((test) => normalizeSupportedPlatform(test.platform))
          .filter((value): value is SupportedPlatform => value !== null),
      )]
    : []

  const platform = resolveEffectivePlatform(
    metadata?.platform,
    targetName,
    targetPlatforms,
    uniqueChildPlatforms.length === 1 ? uniqueChildPlatforms[0] : run.platform,
  )

  return {
    ...run,
    platform: platform ?? run.platform,
    targetName,
    ...(tests ? { tests } : {}),
  }
}

function matchesTargetFilter(run: EnrichedRunRow, filterValue: string | null): boolean {
  if (!filterValue) return true
  if (normalizeRunFilterValue(run.targetName) === filterValue) return true
  return run.tests?.some((test) => normalizeRunFilterValue(test.targetName) === filterValue) ?? false
}

function matchesPlatformFilter(run: EnrichedRunRow, filterValue: SupportedPlatform | null): boolean {
  if (!filterValue) return true
  if (normalizeSupportedPlatform(run.platform) === filterValue) return true
  return run.tests?.some((test) => normalizeSupportedPlatform(test.platform) === filterValue) ?? false
}

function getArtifactMissingSections(artifact: RunArtifactRow | null): string[] {
  if (!artifact) return ['artifact']
  const missing: string[] = []
  const payload = artifact.payload
  if (!('config' in payload)) missing.push('config')
  if (!('source' in payload)) missing.push('source')
  if (!('memory' in payload)) missing.push('memory')
  return missing
}

const SECRET_TEMPLATE_RE = /\{\{secret:(\w+)\}\}/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeSecretTemplates(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(SECRET_TEMPLATE_RE, (_match, name: string) => `[secret:${name}]`)
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretTemplates(item))
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return value
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeSecretTemplates(item)]),
    )
  }
  return value
}

function sanitizeSecretsFileMetadata(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (!isRecord(value)) return value
  return {
    path: typeof value.path === 'string' || value.path === null ? value.path : null,
    status: typeof value.status === 'string' ? value.status : 'loaded',
    ...(typeof value.count === 'number' ? { count: value.count } : {}),
  }
}

function sanitizeArtifactPayloadForResponse(payload: RunArtifactRow['payload']): RunArtifactRow['payload'] {
  const sanitized = redactAuthStateValue(sanitizeSecretTemplates(payload))
  if (!isRecord(sanitized)) return payload
  const config = sanitized.config
  if (!isRecord(config) || !('secretsFile' in config)) return sanitized as unknown as RunArtifactRow['payload']
  return {
    ...sanitized,
    config: {
      ...config,
      secretsFile: sanitizeSecretsFileMetadata(config.secretsFile),
    },
  } as RunArtifactRow['payload']
}

function sanitizeArtifactForResponse(artifact: RunArtifactRow | null): RunArtifactRow | null {
  if (!artifact) return null
  return {
    ...artifact,
    payload: sanitizeArtifactPayloadForResponse(artifact.payload),
  }
}

function sanitizeAuthStateForResponse<T>(value: T): T {
  return redactAuthStateValue(value)
}

async function normalizeDashboardWorkspacePath(
  filePath: string,
  workspacePaths: ResolvedWorkspacePaths | undefined,
  kind: WorkspaceFileKind,
  requireExisting = true,
): Promise<{ storagePath: string; executionPath: string }> {
  if (!workspacePaths) {
    throw new Error('Workspace path resolution is required for dashboard-triggered runs')
  }

  const record = await resolveWorkspaceFileTarget({
    workspace: workspacePaths,
    kind,
    filePath,
    requireExisting,
  })

  return { storagePath: record.workspaceRelativePath, executionPath: record.absolutePath }
}

function workspaceRecordToPath(record: WorkspaceFileRecord): { storagePath: string; executionPath: string } {
  return { storagePath: record.workspaceRelativePath, executionPath: record.absolutePath }
}

async function resolveDashboardTestPattern(
  pattern: string,
  workspacePaths: ResolvedWorkspacePaths | undefined,
): Promise<Array<{ storagePath: string; executionPath: string }>> {
  if (!workspacePaths) {
    throw new Error('Workspace path resolution is required for dashboard-triggered runs')
  }

  const normalizedPattern = pattern.replace(/\\/g, '/')
  if (isAbsolute(pattern) || normalizedPattern.split('/').includes('..')) {
    throw new Error(`Workspace test pattern is not allowed: ${pattern}`)
  }

  const candidates = await discoverWorkspaceFiles({ workspace: workspacePaths, kind: 'test' })
  const patternWorkspace: ResolvedWorkspacePaths = {
    ...workspacePaths,
    testMatch: [pattern],
  }
  return candidates
    .filter((record) => isWorkspacePathMatch({
      workspace: patternWorkspace,
      kind: 'test',
      workspaceRelativePath: record.workspaceRelativePath,
    }))
    .map(workspaceRecordToPath)
}

function isSuiteFilePath(filePath: string | undefined): boolean {
  return false
}

function sanitizeQueuedRunMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const { args: _args, target: _target, isSuite: _isSuite, ...safeMetadata } = metadata ?? {}
  return safeMetadata
}

function resolveArtifactPath(
  candidatePath: string,
  rootDir: string,
  apiPrefix: '/api/screenshots/' | '/api/videos/',
): string | null {
  const normalizedCandidate = candidatePath.trim()
  if (!normalizedCandidate) return null
  const resolvedRootDir = resolve(rootDir)

  if (isAbsolute(normalizedCandidate)) {
    const resolvedAbsolute = resolve(normalizedCandidate)
    return getPathInsideDir(resolvedAbsolute, resolvedRootDir) ? resolvedAbsolute : null
  }

  const relativePath = normalizedCandidate.startsWith(apiPrefix)
    ? normalizedCandidate.slice(apiPrefix.length)
    : normalizedCandidate
  const resolvedPath = resolve(resolvedRootDir, relativePath)
  return getPathInsideDir(resolvedPath, resolvedRootDir) ? resolvedPath : null
}

async function cleanupDeletedRunArtifacts(
  deletedRunIds: string[],
  screenshotPaths: string[],
  videoPaths: string[],
  dirs: {
    screenshotsDir?: string
    videosDir?: string
  },
): Promise<void> {
  const cleanupTargets = new Set<string>()

  for (const runId of deletedRunIds) {
    if (dirs.screenshotsDir) cleanupTargets.add(join(dirs.screenshotsDir, runId))
    if (dirs.videosDir) cleanupTargets.add(join(dirs.videosDir, runId))
  }

  if (dirs.screenshotsDir) {
    for (const screenshotPath of screenshotPaths) {
      const resolvedPath = resolveArtifactPath(screenshotPath, dirs.screenshotsDir, '/api/screenshots/')
      if (resolvedPath) cleanupTargets.add(resolvedPath)
    }
  }

  if (dirs.videosDir) {
    for (const videoPath of videoPaths) {
      const resolvedPath = resolveArtifactPath(videoPath, dirs.videosDir, '/api/videos/')
      if (resolvedPath) cleanupTargets.add(resolvedPath)
    }
  }

  await Promise.allSettled(
    [...cleanupTargets].map((targetPath) => rm(targetPath, { recursive: true, force: true })),
  )
}

async function readWorkspaceHooks(
  configManager: ConfigManager | undefined,
  configPath: string | undefined,
): Promise<{
  hooks: Array<{ name: string }>
  filePath: string
  resolvedHooks: Map<string, Record<string, unknown>>
  errors: string[]
  missing: boolean
  hookRegistryError?: string
}> {
  return {
    hooks: [],
    filePath: '',
    resolvedHooks: new Map(),
    errors: [],
    missing: true,
  }
}

async function readWorkspaceEnvVars(
  workspacePaths: ResolvedWorkspacePaths | undefined,
): Promise<Record<string, string>> {
  if (!workspacePaths) {
    return {}
  }

  try {
    const content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
    return parseEnvFile(content)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`workspace.envFile not found: ${workspacePaths.envFile.absolutePath}`)
    }
    throw error
  }
}



interface RouterDeps {
  db: DashboardDatabase
  artifactsDir?: string
  workspacePaths?: ResolvedWorkspacePaths
  testRunner?: TestRunner
  jobQueue?: JobQueue
  testFileManager?: TestFileManager
  configManager?: ConfigManager
  configPath?: string

  llmConfig?: DashboardRuntimeLLMConfig
  authFetch?: typeof globalThis.fetch
  sessionManager?: import('../live-editor/session-manager.js').SessionManager
  analyticsBridge?: {
    buildAnalyticsEvent: typeof buildAnalyticsEvent
    captureAnalytics: typeof captureAnalytics
    resolveAnalyticsStandardProperties: typeof resolveAnalyticsStandardProperties
  }
}

export function createRouter(deps: RouterDeps): (req: IncomingMessage, res: ServerResponse) => void
export function createRouter(db: DashboardDatabase, artifactsDir?: string): (req: IncomingMessage, res: ServerResponse) => void
export function createRouter(dbOrDeps: DashboardDatabase | RouterDeps, artifactsDir?: string): (req: IncomingMessage, res: ServerResponse) => void {
  const deps: RouterDeps = 'db' in dbOrDeps && typeof (dbOrDeps as RouterDeps).db === 'object' && 'getRuns' in ((dbOrDeps as RouterDeps).db ?? {})
    ? dbOrDeps as RouterDeps
    : { db: dbOrDeps as DashboardDatabase, artifactsDir }
  const { db, testRunner, jobQueue, testFileManager, configManager, workspacePaths, llmConfig, authFetch, sessionManager } = deps
  const pluginOAuthSessions = new Map<string, PluginOAuthSession>()
  const analyticsBridge = deps.analyticsBridge ?? {
    buildAnalyticsEvent,
    captureAnalytics,
    resolveAnalyticsStandardProperties,
  }
  const ssDir = deps.artifactsDir ? join(deps.artifactsDir, 'screenshots') : undefined
  const vidDir = deps.artifactsDir ? join(deps.artifactsDir, 'videos') : undefined
  const memoryCatalogManager = new MemoryCatalogManager({ configManager, configPath: deps.configPath })

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      cors(res)
      return
    }

    const url = parseUrl(req)
    const path = url.pathname

    // GET /api/auth-states — list safe auth-state metadata only
    if (path === '/api/auth-states' && req.method === 'GET') {
      if (!configManager || !deps.configPath) {
        json(res, { error: 'Auth-state metadata not available' }, 503)
        return
      }
      ;(async () => {
        try {
          const config = await configManager.read()
          const targetName = url.searchParams.get('target') ?? undefined
          const authStates = await listAuthStateMetadata({
            configDir: dirname(resolve(deps.configPath!)),
            authStateDir: getConfiguredAuthStateDir(config),
            targetName,
          })
          json(res, { authStates })
        } catch {
          json(res, { error: 'Could not list auth states.' }, 500)
        }
      })()
      return
    }

    // POST /api/analytics/events — best-effort dashboard product analytics bridge
    if (path === '/api/analytics/events' && req.method === 'POST') {
      readJsonBody<{ name?: unknown; properties?: unknown }>(req)
        .then((body) => {
          if (
            !isPlainRecord(body)
            || !isDashboardProductEventName(body.name)
            || (
              Object.prototype.hasOwnProperty.call(body, 'properties')
              && body.properties !== undefined
              && !isPlainRecord(body.properties)
            )
          ) {
            json(res, { error: 'Invalid analytics event' }, 400)
            return
          }

          const name = body.name
          const browserProperties = isPlainRecord(body.properties) ? body.properties : {}
          json(res, { accepted: true }, 202)

          void (async () => {
            try {
              const config = await readAnalyticsServiceConfig(configManager)
              if (config.analytics?.privacy === true) {
                return
              }

              const standardProperties = await analyticsBridge.resolveAnalyticsStandardProperties({ surface: 'dashboard-ui' })
              const event = analyticsBridge.buildAnalyticsEvent({
                name,
                properties: {
                  ...filterDashboardProductEventProperties(name, browserProperties),
                  ...standardProperties,
                },
              })
              await analyticsBridge.captureAnalytics(event, { config })
            } catch {
              // Analytics is intentionally best-effort and invisible to dashboard users.
            }
          })()
        })
        .catch(() => json(res, { error: 'Invalid analytics event' }, 400))
      return
    }

    // GET /api/runs
    if (path === '/api/runs' && req.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined
      const name = url.searchParams.get('name') ?? undefined
      const platform = url.searchParams.get('platform') ?? undefined
      const target = normalizeRunFilterValue(url.searchParams.get('target'))
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const attributePredicatesResult = parseAttributePredicates(url.searchParams)
      if (!attributePredicatesResult.ok) {
        json(res, { error: attributePredicatesResult.error }, 400)
        return
      }

      void readTargetPlatformMap(configManager)
        .then((targetPlatforms) => {
          const allRuns = db.getRuns({
            status,
            name,
            from,
            to,
            attributePredicates: attributePredicatesResult.predicates,
          })
          const enrichedRuns = allRuns.map(run => {
            if (run.suiteId && !run.parentRunId) {
              const tests = db.getRunsByParent(run.id).map(test => enrichRunRow(test, targetPlatforms))
              return enrichRunRow(run, targetPlatforms, tests)
            }
            return enrichRunRow(run, targetPlatforms)
          })
          const platformFilteredRuns = enrichedRuns.filter(run =>
            matchesPlatformFilter(run, normalizeSupportedPlatform(platform)),
          )
          const targetOptions = Array.from(new Set(
            platformFilteredRuns
              .flatMap(run => [run.targetName, ...(run.tests?.map(test => test.targetName) ?? [])])
              .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
          )).sort((a, b) => a.localeCompare(b))
          const filtered = platformFilteredRuns.filter(run => matchesTargetFilter(run, target))

          const runs = filtered.slice(offset, offset + limit)
          json(res, { runs, total: filtered.length, targets: targetOptions })
        })
        .catch(() => json(res, { error: 'Failed to list runs' }, 500))
      return
    }

    // GET /api/runs/attributes/keys
    if (path === '/api/runs/attributes/keys' && req.method === 'GET') {
      const limitResult = parseBoundedIntegerQueryParam(url.searchParams.get('limit'), 'limit', 1, 100, 50)
      if (!limitResult.ok) {
        json(res, { error: limitResult.error }, 400)
        return
      }
      json(res, {
        keys: db.listRunAttributeKeys({
          limit: limitResult.value,
          q: url.searchParams.get('q') ?? undefined,
        }),
      })
      return
    }

    // GET /api/runs/attributes/values
    if (path === '/api/runs/attributes/values' && req.method === 'GET') {
      const key = url.searchParams.get('key')?.trim()
      if (!key) {
        json(res, { error: 'key is required' }, 400)
        return
      }
      const limitResult = parseBoundedIntegerQueryParam(url.searchParams.get('limit'), 'limit', 1, 100, 50)
      if (!limitResult.ok) {
        json(res, { error: limitResult.error }, 400)
        return
      }
      json(res, {
        values: db.listRunAttributeValues(key, {
          limit: limitResult.value,
          q: url.searchParams.get('q') ?? undefined,
        }),
      })
      return
    }

    // GET /api/runs/:id/artifact
    const runArtifactMatch = path.match(/^\/api\/runs\/([^/]+)\/artifact$/)
    if (runArtifactMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runArtifactMatch[1])
      const run = db.getRun(runId)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const bundle = db.getRunArtifactBundle(runId)
      json(res, sanitizeAuthStateForResponse({
        run,
        artifact: sanitizeArtifactForResponse(bundle.artifact),
        children: bundle.children.map((child) => ({
          ...child,
          artifact: sanitizeArtifactForResponse(child.artifact),
        })),
        missingSections: getArtifactMissingSections(bundle.artifact),
      }))
      return
    }

    // GET /api/runs/:id/accessibility
    if (path.startsWith('/api/runs/') && path.endsWith('/accessibility') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const summary = db.getAccessibilitySummary(id)
      json(res, summary)
      return
    }

    // GET /api/runs/:id/steps/:n/reasoning — structured reasoning trace for a step
    const reasoningMatch = path.match(/^\/api\/runs\/([^/]+)\/steps\/(\d+)\/reasoning$/)
    if (reasoningMatch && req.method === 'GET') {
      const [, runId, stepOrderStr] = reasoningMatch
      const run = db.getRun(runId)
      if (!run) { notFound(res, 'Run not found'); return }
      const stepOrder = parseInt(stepOrderStr, 10)
      const trace = db.getReasoningTrace(runId, stepOrder)
      if (trace) {
        json(res, sanitizeAuthStateForResponse({ trace }))
        return
      }
      // Fallback: construct legacy trace from step data for backward compatibility
      const steps = db.getSteps(runId)
      const step = steps.find(s => s.stepOrder === stepOrder)
      if (!step) { notFound(res, 'Step not found'); return }
      json(res, sanitizeAuthStateForResponse({
        trace: {
          id: null,
          stepId: step.id,
          observeText: step.observation,
          observeDuration: null,
          planReasoning: step.reasoning,
          planConfidence: step.confidence,
          planAction: step.plannedAction,
          planDuration: null,
          executeAction: step.action,
          executeDuration: null,
          verifyReasoning: null,
          verifySuccess: step.result === 'success' ? true : step.result === 'failure' ? false : null,
          verifyDuration: null,
          healAttempts: step.healingAttempts,
          totalDuration: step.duration,
          screenStateBefore: null,
          screenStateAfter: null,
          createdAt: step.createdAt,
        },
      }))
      return
    }

    // GET /api/runs/:id/execution-logs
    if (path.startsWith('/api/runs/') && path.endsWith('/execution-logs') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const stepId = url.searchParams.get('stepId') ?? undefined
      const type = url.searchParams.get('type') ?? undefined

      if (run.suiteId && !run.parentRunId) {
        const childRuns = db.getRunsByParent(id)
        const allRunIds = [id, ...childRuns.map((c: any) => c.id)]
        let allLogs: any[] = []
        for (const rid of allRunIds) {
          allLogs.push(...db.getExecutionLogs({ runId: rid, stepId, type }))
        }
        json(res, sanitizeAuthStateForResponse({ logs: allLogs }))
        return
      }

      const logs = db.getExecutionLogs({ runId: id, stepId, type })
      json(res, sanitizeAuthStateForResponse({ logs }))
      return
    }

    // GET /api/runs/:id/logs
    if (path.startsWith('/api/runs/') && path.endsWith('/logs') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const stepId = url.searchParams.get('stepId') ?? undefined
      const level = url.searchParams.get('level') ?? undefined
      const source = url.searchParams.get('source') ?? undefined
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 500
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const logs = db.getLogs({ runId: id, stepId, level, source, limit, offset })
      json(res, sanitizeAuthStateForResponse({ logs, total: logs.length }))
      return
    }

    // GET /api/runs/:id/steps
    if (path.startsWith('/api/runs/') && path.endsWith('/steps') && req.method === 'GET') {
      const segments = path.split('/')
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const steps = db.getSteps(id)
      json(res, sanitizeAuthStateForResponse({ steps }))
      return
    }

    // POST /api/runs/:id/cancel — cancel a pending or running execution
    if (path.startsWith('/api/runs/') && path.endsWith('/cancel') && req.method === 'POST') {
      if (!jobQueue) {
        json(res, { error: 'Queue not available' }, 503)
        return
      }
      const runId = path.slice('/api/runs/'.length, path.length - '/cancel'.length)
      const cancelled = jobQueue.cancel(runId)
      if (cancelled) {
        // For pending jobs, JobQueue already set status='cancelled'.
        // For running jobs, JobQueue emits 'cancel-running' which triggers executionManager.kill().
        // Update DB with cancel metadata for running jobs.
        try {
          const run = db.getRun(runId)
          if (run && run.status === 'cancelled') {
            const duration = run.startedAt
              ? Date.now() - new Date(run.startedAt).getTime()
              : 0
            db.updateRun(runId, {
              duration,
              endedAt: new Date().toISOString(),
              failureSummary: 'Test cancelled by user',
            })
          }
        } catch { /* best-effort */ }
        json(res, { cancelled: true })
      } else {
        json(res, { error: 'Run not found or not cancellable' }, 404)
      }
      return
    }

    // DELETE /api/runs/:id
    if (path.startsWith('/api/runs/') && req.method === 'DELETE') {
      const segments = path.split('/')
      if (segments.length !== 4) {
        notFound(res)
        return
      }

      const id = segments[3]

      try {
        const deletedRun = db.deleteRun(id)
        if (!deletedRun.deleted) {
          notFound(res, 'Run not found')
          return
        }

        void cleanupDeletedRunArtifacts(
          deletedRun.deletedRunIds,
          deletedRun.screenshotPaths,
          deletedRun.videoPaths,
          {
            screenshotsDir: ssDir,
            videosDir: vidDir,
          },
        ).finally(() => {
          json(res, { deleted: true, deletedRunIds: deletedRun.deletedRunIds })
        })
      } catch {
        json(res, { error: 'Failed to delete run' }, 500)
      }
      return
    }

    // GET /api/runs/:id
    if (path.startsWith('/api/runs/') && req.method === 'GET') {
      const segments = path.split('/')
      if (segments.length !== 4) {
        notFound(res)
        return
      }
      const id = segments[3]
      const run = db.getRun(id)
      if (!run) {
        notFound(res, 'Run not found')
        return
      }
      const steps = db.getSteps(id)
      const attempts = db.getRunsByParent(id)
      if (run.suiteId && !run.parentRunId) {
        const tests = db.getRunsByParent(id)
        json(res, sanitizeAuthStateForResponse({ run, steps, attempts, tests }))
      } else {
        json(res, sanitizeAuthStateForResponse({ run, steps, attempts }))
      }
      return
    }

    // GET /api/stats/costs
    if (path === '/api/stats/costs' && req.method === 'GET') {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const costStats = db.getCostStats({ from, to })
      json(res, costStats)
      return
    }

    // GET /api/token-events/stats
    if (path === '/api/token-events/stats' && req.method === 'GET') {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const stats = db.getTokenEventStats({ from, to })
      json(res, stats)
      return
    }

    // GET /api/stats
    if (path === '/api/stats' && req.method === 'GET') {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const scope = url.searchParams.get('scope') ?? undefined
      if (scope !== undefined && scope !== 'passRate') {
        json(res, { error: 'scope must be passRate when provided' }, 400)
        return
      }

      void readAnalyticsScopePredicates(configManager)
        .then((scopeResult) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }
          const configured = scopeResult.predicates.length > 0
          const allStats = db.getStats({ from, to })
          const scopedStats = configured
            ? db.getStats({ from, to, attributePredicates: scopeResult.predicates })
            : allStats
          const stats = scope === 'passRate' && configured ? scopedStats : allStats

          json(res, {
            ...stats,
            scope: {
              configured,
              predicates: scopeResult.predicates,
              scopedCount: configured ? scopedStats.totalRuns : 0,
              totalCount: allStats.totalRuns,
            },
          })
        })
        .catch(() => {
          json(res, { error: 'Unable to read analytics scope' }, 500)
        })
      return
    }

    // GET /api/screenshots/:runId/:filename
    if (path.startsWith('/api/screenshots/') && req.method === 'GET') {
      const segments = path.split('/')
      if (segments.length !== 5 || !ssDir) {
        notFound(res)
        return
      }
      const runId = segments[3]
      const filename = segments[4]

      if (runId.includes('..') || filename.includes('..') || runId.includes('/') || filename.includes('/')) {
        notFound(res, 'Invalid path')
        return
      }

      const filePath = join(ssDir, runId, filename)
      const resolvedPath = resolve(filePath)
      if (!resolvedPath.startsWith(resolve(ssDir))) {
        notFound(res, 'Invalid path')
        return
      }

      stat(filePath).then(s => {
        if (!s.isFile()) {
          notFound(res, 'Screenshot not found')
          return
        }
        readFile(filePath).then(buffer => {
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': buffer.length,
            'Access-Control-Allow-Origin': '*',
          })
          res.end(buffer)
        }).catch(() => notFound(res, 'Screenshot not found'))
      }).catch(() => notFound(res, 'Screenshot not found'))
      return
    }

    // GET /api/videos/:runId/:filename
    if (path.startsWith('/api/videos/') && req.method === 'GET') {
      const segments = path.split('/')
      if (segments.length !== 5 || !vidDir) {
        notFound(res)
        return
      }
      const runId = segments[3]
      const filename = segments[4]

      if (runId.includes('..') || filename.includes('..') || runId.includes('/') || filename.includes('/')) {
        notFound(res, 'Invalid path')
        return
      }

      const videoPath = join(vidDir, runId, filename)
      const resolvedVideo = resolve(videoPath)
      const resolvedVidDir = resolve(vidDir)
      if (!getPathInsideDir(resolvedVideo, resolvedVidDir)) {
        notFound(res, 'Invalid path')
        return
      }

      const tryServe = (filePath: string) => stat(filePath).then(s => {
        if (!s.isFile()) {
          notFound(res, 'Video not found')
          return
        }

        const contentType = filePath.endsWith('.mp4') ? 'video/mp4' : 'video/webm'
        const range = req.headers.range
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-')
          const start = parseInt(parts[0], 10)
          const end = parts[1] ? parseInt(parts[1], 10) : s.size - 1
          const chunkSize = end - start + 1

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${s.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
          })
          createReadStream(filePath, { start, end }).pipe(res)
        } else {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': s.size,
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
          })
          createReadStream(filePath).pipe(res)
        }
      })
      tryServe(videoPath).catch(() => notFound(res, 'Video not found'))
      return
    }

    // GET /api/execution/active — list currently running tests
    if (path === '/api/execution/active' && req.method === 'GET') {
      const active = testRunner ? testRunner.getActiveExecutions() : []
      json(res, { executions: active })
      return
    }

    // POST /api/queue/enqueue — external API to enqueue a test run
    if (path === '/api/queue/enqueue' && req.method === 'POST') {
      if (!jobQueue) {
        json(res, { error: 'Queue not available' }, 503)
        return
      }
      readJsonBody<{ name: string; file?: string; priority?: number; platform?: string; parallel?: boolean; metadata?: Record<string, unknown>; attributes?: unknown }>(req)
        .then(async (body) => {
          if (!body.name || typeof body.name !== 'string') {
            json(res, { error: 'name is required' }, 400)
            return
          }
          let normalizedFileTarget: { storagePath: string; executionPath: string } | null = null
          if (body.file) {
            try {
              normalizedFileTarget = await normalizeDashboardWorkspacePath(body.file, workspacePaths, 'test')
            } catch (err) {
              json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
              return
            }
          }
          let attributes: RunAttributes
          try {
            attributes = buildRunRequestAttributes({
              trigger: 'api',
              runner: 'local',
              userAttributes: body.attributes,
            })
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
            return
          }
          const runId = jobQueue.enqueue({
            name: body.name,
            filePath: normalizedFileTarget?.storagePath,
            kind: 'test',
            attributes,
            priority: body.priority,
            platform: body.platform,
            parallel: body.parallel,
            metadata: {
              ...sanitizeQueuedRunMetadata(body.metadata),
              args: normalizedFileTarget ? [normalizedFileTarget.executionPath] : [],
            },
          })
          const pending = db.getPendingRuns()
          const position = pending.findIndex(r => r.id === runId) + 1
          json(res, { runId, status: 'queued', position }, 202)
        })
        .catch(() => {
          json(res, { error: 'Invalid request body' }, 400)
        })
      return
    }

    // GET /api/queue/status — queue status with pending/running jobs
    if (path === '/api/queue/status' && req.method === 'GET') {
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 20
      const completed = url.searchParams.get('completed') === 'true'
      const pending = db.getPendingRuns()
      const allRuns = db.getRuns({ limit: 100 })
      const running = allRuns.filter(r => r.status === 'running')
      const response: Record<string, unknown> = {
        pending: { count: pending.length, jobs: pending },
        running: { count: running.length, jobs: running },
        concurrency: jobQueue?.getConcurrency() ?? 0,
        activeSlots: jobQueue?.getActiveCount() ?? 0,
      }
      if (completed) {
        const recent = allRuns
          .filter(r => r.status !== 'pending' && r.status !== 'running')
          .slice(0, limit)
        response.recent = recent
      }
      json(res, response)
      return
    }

    // POST /api/runs/trigger — enqueue a live test execution
    if (path === '/api/runs/trigger' && req.method === 'POST') {
      if (!jobQueue) {
        json(res, { error: 'Queue not available' }, 503)
        return
      }
      readJsonBody<{ file?: string; patterns?: string[]; tags?: unknown; noCache?: boolean; noMemory?: boolean; local?: boolean; triggerSource?: unknown }>(req)
        .then(async (body) => {
          if (body.tags !== undefined) {
            json(res, { error: 'tags are not supported for dashboard-triggered runs' }, 400)
            return
          }
          const triggerSource = parseDashboardRunTriggerSource(body.triggerSource)
          if (!triggerSource.ok) {
            json(res, { error: triggerSource.error }, 400)
            return
          }
          const args: string[] = []
          let normalizedFileTarget: { storagePath: string; executionPath: string } | null = null
          try {
            normalizedFileTarget = body.file
              ? await normalizeDashboardWorkspacePath(body.file, workspacePaths, 'test')
              : null

            if (body.file) {
              args.push(normalizedFileTarget?.executionPath ?? body.file)
            }
            if (body.patterns) {
              if (!Array.isArray(body.patterns)) {
                throw new Error('patterns must be an array')
              }
              for (const pattern of body.patterns) {
                if (typeof pattern !== 'string') {
                  throw new Error('patterns must be strings')
                }
                const matches = await resolveDashboardTestPattern(pattern, workspacePaths)
                args.push(...matches.map((match) => match.executionPath))
              }
            }
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : String(err) }, 400)
            return
          }
          const normalizedTestTarget = normalizedFileTarget
          if (body.noCache) {
            args.push('--no-cache')
          }
          if (body.noMemory) {
            args.push('--no-memory')
          }

          let testName = body.file
            ? basename(normalizedFileTarget?.storagePath ?? body.file, '.yaml')
            : 'unknown'

          let fileParallel: boolean | undefined
          let platform: string | undefined

          if (body.file && testFileManager) {
            // Parse test YAML for name, use.parallel, and platform metadata
            try {
              const readPath = normalizedTestTarget?.storagePath ?? body.file
              const content = await testFileManager.read(readPath)
              const metadata = extractTestFileMetadata(content)
              const targetPlatforms = await readTargetPlatformMap(configManager)
              if (metadata.name) testName = metadata.name
              if (metadata.parallel !== null) fileParallel = metadata.parallel
              platform = resolveEffectivePlatform(
                metadata.platform,
                metadata.targetName,
                targetPlatforms,
                platform,
              ) ?? undefined
            } catch { /* fall back to defaults */ }
          }

          const configParallel = await readConfigUseParallel(configManager)
          const effectiveParallel = fileParallel ?? configParallel ?? false
          const executionTimeout = await resolveDashboardExecutionTimeout({
            file: normalizedFileTarget?.storagePath ?? body.file,
            normalizedTestPath: normalizedTestTarget?.storagePath,
            testFileManager,
            configManager,
          })

          const runId = jobQueue.enqueue({
            name: testName,
            filePath: normalizedFileTarget?.storagePath ?? body.file,
            kind: 'test',
            attributes: buildRunRequestAttributes({
              trigger: triggerSource.trigger,
              runner: body.local === false ? 'browserstack' : 'local',
            }),
            platform,
            parallel: effectiveParallel,
            metadata: {
              args,
              ...toExecutionTimeoutMetadata(executionTimeout),
            },
          })
          json(res, { runId, status: 'queued' }, 202)
        })
        .catch(() => {
          json(res, { error: 'Invalid request body' }, 400)
        })
      return
    }

    // GET /api/execution/events — SSE stream for live execution events
    if (path === '/api/execution/events' && req.method === 'GET') {
      if (!testRunner) {
        json(res, { error: 'Execution not available' }, 503)
        return
      }

      const runId = url.searchParams.get('runId') ?? undefined
      const lastEventId = req.headers['last-event-id'] as string | undefined

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(':ok\n\n')

      // Replay buffered events for reconnection
      if (lastEventId && runId) {
        const lastId = parseInt(lastEventId, 10)
        const buffered = testRunner.getBufferedEvents(runId)
        for (const evt of buffered) {
          if (evt.id > lastId) {
            res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
          }
        }
      } else if (runId) {
        // New connection — replay all buffered events
        const buffered = testRunner.getBufferedEvents(runId)
        for (const evt of buffered) {
          res.write(`id: ${evt.id}\nevent: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`)
        }
      }

      const onEvent = (evtRunId: string, event: { id: number; type: string; [key: string]: unknown }) => {
        if (runId && evtRunId !== runId) return
        res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }

      testRunner.on('execution-event', onEvent)

      const heartbeat = setInterval(() => {
        res.write(':\n\n')
      }, 15_000)

      req.on('close', () => {
        clearInterval(heartbeat)
        testRunner.removeListener('execution-event', onEvent)
      })
      return
    }


    // POST /api/tests/generate-from-requirements — fetch requirements from Jira/Confluence via Rovo MCP and convert to YAML
    if (path === '/api/tests/generate-from-requirements' && req.method === 'POST') {
      readJsonBody<{ source: 'confluence' | 'jira'; requirementId: string; name?: string; testId?: string; target?: string; context?: string }>(req)
        .then(async (body) => {
          try {
            // Resolve Atlassian credentials from workspace env file
            if (!workspacePaths) {
              throw new Error('Workspace paths are not initialized')
            }
            const envVars = await readWorkspaceEnvVars(workspacePaths)
            const atlassianUrl = envVars.ATLASSIAN_URL
            const atlassianEmail = envVars.ATLASSIAN_EMAIL
            const atlassianToken = envVars.ATLASSIAN_API_TOKEN

            if (typeof atlassianUrl !== 'string' || typeof atlassianEmail !== 'string' || typeof atlassianToken !== 'string') {
              throw new Error(
                'Atlassian credentials are not configured in your workspace .env file.\n' +
                'Please ensure the following variables are set in your .env file:\n' +
                '- ATLASSIAN_URL\n' +
                '- ATLASSIAN_EMAIL\n' +
                '- ATLASSIAN_API_TOKEN'
              )
            }

            let requirementContent = ''
            const authHeader = 'Basic ' + Buffer.from(`${atlassianEmail}:${atlassianToken}`).toString('base64')

            // Helper: strip HTML/XML tags and decode common entities to produce clean readable text
            const stripHtml = (html: string): string => {
              return html
                // Remove CDATA sections
                .replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '')
                // Remove Confluence structured macros (ac:, ri: namespaced tags)
                .replace(/<ac:[^>]*>[\s\S]*?<\/ac:[^>]*>/gi, '')
                .replace(/<ri:[^>]*\/?>/gi, '')
                .replace(/<ac:[^>]*\/?>/gi, '')
                // Remove all remaining HTML tags
                .replace(/<[^>]+>/g, ' ')
                // Decode common HTML entities
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&nbsp;/g, ' ')
                .replace(/&ndash;/g, '-')
                .replace(/&mdash;/g, '-')
                // Collapse excessive whitespace/newlines
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
            }

            let confluenceTitle = ''
            let cleanKey = ''

            if (body.source === 'confluence') {
              const url = `${atlassianUrl.replace(/\/$/, '')}/wiki/api/v2/pages/${body.requirementId}?body-format=storage`
              const res = await fetch(url, {
                headers: {
                  'Authorization': authHeader,
                  'Accept': 'application/json',
                }
              })
              if (!res.ok) {
                const text = await res.text()
                throw new Error(`Confluence API returned ${res.status}: ${text || res.statusText}`)
              }
              const data = (await res.json()) as any
              confluenceTitle = data.title || ''
              const rawContent = data.body?.storage?.value || ''
              const cleanContent = stripHtml(rawContent)
              requirementContent = `Confluence Page: ${data.title || ''}\n\nContent:\n${cleanContent}`
            } else {
              const url = `${atlassianUrl.replace(/\/$/, '')}/rest/api/2/issue/${body.requirementId}`
              const res = await fetch(url, {
                headers: {
                  'Authorization': authHeader,
                  'Accept': 'application/json',
                }
              })
              if (!res.ok) {
                const text = await res.text()
                throw new Error(`Jira API returned ${res.status}: ${text || res.statusText}`)
              }
              const data = (await res.json()) as any
              confluenceTitle = data.fields?.summary || ''
              cleanKey = data.key || ''
              const rawDesc = data.fields?.description || ''
              const cleanDesc = typeof rawDesc === 'string' ? stripHtml(rawDesc) : JSON.stringify(rawDesc)
              requirementContent = `Jira Ticket: ${data.key || ''} - ${data.fields?.summary || ''}\n\nDescription:\n${cleanDesc}`
            }

            // Check if there is a matching template YAML test file in the confluence-templates folder
            try {
              const templatesDir = join(workspacePaths.configDir, 'tests/confluence-templates')
              const cleanTitle = confluenceTitle.toLowerCase()
              const cleanReqId = (body.requirementId || '').toLowerCase()
              const cleanKeyLower = cleanKey.toLowerCase()

              const templateFiles = await readdir(templatesDir).catch(() => [] as string[])
              const matchedTemplate = templateFiles.find(filename => {
                const nameLower = filename.toLowerCase()

                // Extract user story ID pattern like "us-101" or "us-103"
                const storyMatch = cleanTitle.match(/us-\d+/i) || cleanReqId.match(/us-\d+/i) || cleanKeyLower.match(/us-\d+/i)
                if (storyMatch) {
                  const storyId = storyMatch[0].toLowerCase()
                  if (nameLower.includes(storyId)) return true
                }

                return false
              })

              if (matchedTemplate && testFileManager) {
                console.log(`[Requirements Sync] Found matching confluence template: ${matchedTemplate}. Generating in workspace...`)
                const templateContent = await readFile(join(templatesDir, matchedTemplate), 'utf-8')

                // Write the test case to the active tests/web directory so it shows up in the UI
                const destPath = `tests/web/${matchedTemplate}`
                await testFileManager.write(destPath, templateContent)

                json(res, { yaml: templateContent })
                return
              }
            } catch (err) {
              console.warn('[Requirements Sync] Confluence templates matching failed:', err)
            }

             // Resolve LLM config and target URL context
            const config = configManager ? await configManager.read() : {}
            const targets = (config as any).registry?.targets ?? {}

            let targetName = body.target || ''
            if (!targetName) {
              const targetKeys = Object.keys(targets)
              const lowerReq = requirementContent.toLowerCase()
              for (const key of targetKeys) {
                const targetUrlStr = targets[key]?.url
                let hostname = ''
                if (targetUrlStr) {
                  try {
                    hostname = new URL(targetUrlStr).hostname.toLowerCase()
                  } catch (e) {}
                }
                if (lowerReq.includes(key.toLowerCase()) || (hostname && lowerReq.includes(hostname))) {
                  targetName = key
                  break
                }
              }
              if (!targetName && targetKeys.length > 0) {
                targetName = targetKeys[0]
              }
            }

            const targetConfig = targets[targetName]
            const targetUrl = targetConfig?.url

            // Resolve LLM Config
            const registryLlms = (config as any).registry?.llms ?? []
            const useLlm = (config as any).use?.llm
            const defaultCfg = registryLlms.find((c: any) => c.name === useLlm) ?? {}
            
            const llmConfig = {
              provider: defaultCfg.provider ?? 'openai-compatible',
              model: defaultCfg.model ?? 'gpt-4o-mini',
              baseURL: defaultCfg.baseURL,
              providerHeaders: defaultCfg.providerHeaders,
            }

            const { resolveLLMAuth } = await import('@vostride/agent-qa-core')
            const resolvedAuth = await resolveLLMAuth(useLlm || '', llmConfig as any)

            const modelConfig: Record<string, unknown> = { ...llmConfig }
            if (resolvedAuth.kind === 'api-key') {
              modelConfig.apiKey = resolvedAuth.apiKey
            } else if (resolvedAuth.kind === 'bearer-token') {
              modelConfig.authToken = resolvedAuth.token
            } else if (resolvedAuth.kind === 'auth-fetch') {
              modelConfig.fetch = resolvedAuth.fetch
              modelConfig.modelAdapter = resolvedAuth.modelAdapter
            }

            const { createModel } = await import('@vostride/agent-qa-core')
            const model = await createModel(modelConfig as any)

            console.log(`[Requirements Sync] Received request body:`, JSON.stringify(body))
            console.log(`[Requirements Sync] Resolved target: "${body.target || ''}" (auto-resolved: "${targetName}") -> URL: "${targetUrl || ''}"`)

            let pageContext = ''
            if (targetUrl) {
              let browser: any = null
              try {
                console.log(`[Requirements Sync] Launching Playwright browser for URL: ${targetUrl}`)
                const { chromium } = await import('playwright-core')
                browser = await chromium.launch({ headless: true })
                const page = await browser.newPage()
                console.log(`[Requirements Sync] Navigating to target page...`)
                const durationLimit = 16000
                await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: durationLimit })
                
                const history: string[] = []
                const explorationLogs: string[] = []
                const maxExploreSteps = 12
                const { generateText } = await import('ai')
                
                for (let stepIdx = 1; stepIdx <= maxExploreSteps; stepIdx++) {
                  console.log(`[Requirements Sync] Exploration Step ${stepIdx} at URL: ${page.url()}`)
                  
                  const headings = (await page.$$eval('h1, h2, h3, h4, h5, h6', (els: any[]) =>
                    els.map(el => el.textContent?.trim()).filter(Boolean).slice(0, 10)
                  )) as string[]

                  const interactiveElements = (await page.evaluate(() => {
                    const els = (globalThis as any).document.querySelectorAll('input, select, textarea, button, a, [role="button"], [role="option"]')
                    const elements: any[] = []
                    els.forEach((el: any, index: number) => {
                      const rect = el.getBoundingClientRect()
                      if (rect.width === 0 || rect.height === 0) return
                      
                      const tag = el.tagName.toLowerCase()
                      const type = (el as any).type || ''
                      const placeholder = (el as any).placeholder || ''
                      const name = (el as any).name || ''
                      const id = el.id || ''
                      const text = el.textContent?.trim() || (el as any).value?.trim() || ''
                      
                      let selector = tag
                      if (id) selector = `#${id}`
                      else if (name) selector = `${tag}[name="${name}"]`
                      else if (placeholder) selector = `${tag}[placeholder="${placeholder}"]`
                      else if (text && tag === 'button') selector = `button:has-text("${text.replace(/"/g, '\\"')}")`
                      
                      elements.push({
                        index,
                        tag,
                        type,
                        text,
                        name,
                        id,
                        placeholder,
                        selector
                      })
                    })
                    return elements.slice(0, 30)
                  })) as Array<{ index: number; tag: string; type: string; text: string; name: string; id: string; placeholder: string; selector: string }>

                  explorationLogs.push(`--- Discovered Screen #${stepIdx} ---\n` +
                    `URL: ${page.url()}\n` +
                    `Headings:\n${headings.map((h: string) => `- ${h}`).join('\n') || '- None'}\n` +
                    `Interactive Elements:\n${interactiveElements.map((el) => `- [Index ${el.index}] <${el.tag}> type: "${el.type}", text: "${el.text}", name: "${el.name}", placeholder: "${el.placeholder}" (Selector: ${el.selector})`).join('\n')}`
                  )

                  const explorePrompt = `You are an autonomous website crawler exploring a page flow.
Goal: Navigate the flow described in these requirements to discover all pages and inputs.
Requirements:
${requirementContent}

History of actions taken so far:
${history.map((h, i) => `${i + 1}. ${h}`).join('\n') || 'None'}

Current page URL: ${page.url()}
Current page headings:
${headings.map((h: string) => `- ${h}`).join('\n') || 'None'}

Discovered interactive elements on this screen:
${interactiveElements.map((el) => `[Index ${el.index}] <${el.tag}> text: "${el.text}", name: "${el.name}", placeholder: "${el.placeholder}" (Selector: ${el.selector})`).join('\n')}

Based on the requirements and the current page elements, determine the next action to proceed forward in the flow (e.g. typing an address, choosing a plan, or clicking next).
If you have finished the flow, cannot proceed further, or the page indicates complete success/failure, set "exploreComplete" to true.
Your response MUST be a valid JSON block enclosed in \`\`\`json ... \`\`\` matching this schema:
{
  "action": {
    "type": "fill" | "click",
    "index": number,
    "value": "text to enter (required only for fill type)"
  } | null,
  "exploreComplete": boolean,
  "reasoning": "explain why you chose this action based on the requirements"
}`

                  const exploreRes = await generateText({
                    model,
                    prompt: explorePrompt,
                  })
                  
                  let jsonText = exploreRes.text.trim()
                  const matchJson = jsonText.match(/```json([\s\S]*?)```/)
                  if (matchJson) jsonText = matchJson[1].trim()
                  
                  let actionData: any = null
                  try {
                    actionData = JSON.parse(jsonText)
                  } catch (err) {
                    console.warn(`[Requirements Sync] Failed to parse exploration action JSON: ${jsonText}`)
                    break
                  }

                  console.log(`[Requirements Sync] Action decided:`, JSON.stringify(actionData))
                  if (actionData.exploreComplete || !actionData.action) {
                    console.log(`[Requirements Sync] Exploration complete or no action provided. Ending exploration.`)
                    break
                  }

                  const act = actionData.action
                  const matchedEl = interactiveElements.find(e => e.index === act.index)
                  if (!matchedEl) {
                    console.warn(`[Requirements Sync] Decided action index ${act.index} did not match any visible element.`)
                    break
                  }

                  history.push(`${act.type.toUpperCase()} on <${matchedEl.tag}> (Selector: ${matchedEl.selector}) with value "${act.value || ''}" - Reasoning: ${actionData.reasoning}`)

                  const fallbackLimit = 5000
                  const loadLimit = 8000
                  try {
                    if (act.type === 'fill') {
                      // Try exact selector first, fall back to first visible match
                      try {
                        await page.fill(matchedEl.selector, act.value || '')
                      } catch {
                        const fallback = page.locator(matchedEl.selector).first()
                        await fallback.fill(act.value || '', { timeout: fallbackLimit })
                      }
                    } else if (act.type === 'click') {
                      try {
                        await page.click(matchedEl.selector)
                      } catch {
                        const fallback = page.locator(matchedEl.selector).first()
                        await fallback.click({ timeout: fallbackLimit })
                      }
                    }
                    // Wait for network/animation to settle after action
                    await page.waitForLoadState('domcontentloaded', { timeout: loadLimit }).catch(() => {})
                    const popupDelay = 1499
                    await page.waitForTimeout(popupDelay)
                  } catch (actErr: any) {
                    console.warn(`[Requirements Sync] Failed to execute action on step ${stepIdx}: ${actErr?.message || actErr}. Continuing exploration to capture remaining page context.`)
                    // Do NOT break — continue capturing other screens
                    explorationLogs.push(`--- Action Failed on Screen #${stepIdx} ---\nURL: ${page.url()}\nFailed action: ${act.type} on selector ${matchedEl.selector}\nReason: ${actErr?.message || actErr}`)
                    continue
                  }
                }

                pageContext = explorationLogs.join('\n\n')
                console.log(`[Requirements Sync] Playwright exploration completed. Total screens recorded: ${explorationLogs.length}`)
              } catch (playwrightError: any) {
                console.warn(`[Requirements Sync] Playwright crawler failed: ${playwrightError?.message || playwrightError}`)
                console.log(`[Requirements Sync] Falling back to static HTTP fetch...`)
                // Fallback to static fetch if browser launch fails
                try {
                  const pageRes = await fetch(targetUrl, {
                    headers: {
                      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                  })
                  if (pageRes.ok) {
                    const html = await pageRes.text()
                    const headingMatches = html.match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi) || []
                    const headings = headingMatches.map((h: string) => h.replace(/<[^>]*>/g, '').trim()).filter(Boolean).slice(0, 10)
                    
                    const buttonMatches = html.match(/<button\b[^>]*>([\s\S]*?)<\/button>/gi) || []
                    const buttons = buttonMatches.map((b: string) => b.replace(/<[^>]*>/g, '').trim()).filter(Boolean).slice(0, 10)
                    
                    const inputMatches = html.match(/<input\b[^>]*>/gi) || []
                    const inputs = inputMatches.map((input: string) => {
                      const placeholder = input.match(/placeholder=["']([\s\S]*?)["']/i)?.[1] || ''
                      const name = input.match(/name=["']([\s\S]*?)["']/i)?.[1] || ''
                      const type = input.match(/type=["']([\s\S]*?)["']/i)?.[1] || 'text'
                      return `Input - type: ${type}${name ? `, name: ${name}` : ''}${placeholder ? `, placeholder: "${placeholder}"` : ''}`
                    }).slice(0, 15)

                    pageContext = `Heading texts found on page:\n${headings.map((h: string) => `- ${h}`).join('\n')}\n\n` +
                      `Button labels found on page:\n${buttons.map((b: string) => `- ${b}`).join('\n')}\n\n` +
                      `Form inputs found on page:\n${inputs.map((i: string) => `- ${i}`).join('\n')}`
                    console.log(`[Requirements Sync] Successfully extracted page context via static fetch fallback.`)
                  } else {
                    console.warn(`[Requirements Sync] Fallback fetch returned status: ${pageRes.status}`)
                  }
                } catch (e: any) {
                  console.error(`[Requirements Sync] Fallback fetch failed: ${e?.message || e}`)
                }
              } finally {
                if (browser) {
                  await browser.close().catch(() => {})
                }
              }
            } else {
              console.log(`[Requirements Sync] No target URL was configured or found. Skipping page crawling.`)
            }

            const crawlHistoryText = pageContext
              ? pageContext
              : 'No page context was captured from the live site. Generate steps based solely on requirements.'

            const systemPrompt = `You are an expert QA test case generator for the agent-qa natural-language testing framework.
Your task is to convert the requirements below into a precise, correct agent-qa YAML test file.
Your output MUST be a single valid YAML block enclosed in \`\`\`yaml ... \`\`\`.

## CRITICAL RULES — READ CAREFULLY

### Steps must be natural language only
- Write each step as a plain English instruction or assertion (e.g. "Type the email address into the Email field").
- NEVER include Playwright code, CSS selectors, XPath, or JavaScript in steps.
- NEVER write TypeScript or import statements.

### Steps must be atomic (one action or one assertion per step)
- WRONG: "Fill in email, click submit, and verify confirmation page"
- RIGHT:
    - "Type the test email address into the Email field"
    - "Click the Submit button"
    - "Verify the page heading changes to Confirmation"

### Use the crawl history to build prerequisite-aware steps
- The crawl history below shows every screen visited in ORDER. Use this as your blueprint.
- If the crawl discovered that Screen 2 can only be reached after completing Screen 1 inputs, your steps MUST include the Screen 1 actions FIRST.
- Do NOT skip screens or assume the agent can jump to a later wizard page directly.
- Each wizard page/screen that was discovered should contribute at least 2-4 steps.

### Write a rich, multi-line context field
The context field MUST explain:
- The starting URL and what it shows
- What user state is assumed (logged in / anonymous / fresh session)
- What test data or environment variables are needed (e.g. {{env:VALID_ADDRESS}})
- Any preconditions visible in the crawl history (e.g. "The first page asks for an address before showing plan cards")

### Do NOT:
- Do not invent steps not grounded in the requirements or crawl history
- Do not combine pages into a single step
- Do not hand-write the test-id (use the value provided below)
- Do not add YAML comments unless they are very brief

## OUTPUT SCHEMA

\`\`\`yaml
name: "<descriptive name from requirements>"
test-id: "${body.testId || 't_prior-jet-tank-awan-idle-stud-hot-das-glyph-alary'}"
target: "${body.target || 'genesis-join'}"
use:
  browser:
    name: chromium
    headless: true
  timeout:
    step: 3m
    test: 30m
context: |
  <Multi-line rich context. Describe: starting URL, assumed user state,
  required test data/env vars, and key preconditions from the crawl.>
steps:
  - <Step 1: first atomic natural-language action from Screen 1>
  - <Step 2: next atomic action or assertion on Screen 1>
  - <Step 3: action that transitions to Screen 2 (e.g. clicking Continue)>
  - <Step 4: first action on Screen 2>
  ...
\`\`\`

## FULL MULTI-STEP EXAMPLE

\`\`\`yaml
name: "Genesis Energy Join Flow — Address and Plan Selection"
test-id: "t_acorn-basin-cinder-dawn-elm-fjord-grove-haze-ivory-jet"
target: "genesis-join"
use:
  browser:
    name: chromium
    headless: true
  timeout:
    step: 3m
    test: 30m
context: |
  The web app is the Genesis Energy residential join flow at https://www.genesisenergy.co.nz/join.
  The session starts fresh (no prior state or login required for this flow).
  Test address: "100 Queen Street, Auckland Central" (use {{env:TEST_ADDRESS}} if configured).
  The flow is a multi-step wizard: Step 1 asks for an address, Step 2 shows plan cards,
  Step 3 collects personal details. Each step must be completed before the next page loads.
steps:
  - Verify the page heading says "What's your address?"
  - Type "100 Queen Street, Auckland Central" into the address search input field
  - Wait for the autocomplete suggestions to appear below the address input
  - Click the first matching address suggestion from the dropdown list
  - Verify the "Is this your primary residence?" checkbox is visible and checked by default
  - Click the "Continue" button to proceed to the next step
  - Verify the page has moved to the plan selection screen and shows available energy plans
  - Select the first energy plan card by clicking on it
  - Verify the selected plan card appears highlighted or marked as selected
  - Click "Continue" to proceed to the personal details page
  - Verify the personal details form is displayed with fields for first name, last name, and email
\`\`\`

---

## REQUIREMENTS FROM ATLASSIAN

${requirementContent}

---

## LIVE WEBSITE CRAWL HISTORY (ordered screen-by-screen)

The following was captured by an automated crawler navigating the live target website.
Use this as the source of truth for what pages exist, what elements are on each page,
and what order actions must be performed in:

${crawlHistoryText}

---

Now generate the complete agent-qa YAML test file following all rules above.`

            const { generateText } = await import('ai')
            const result = await generateText({
              model,
              prompt: systemPrompt,
            })

            let yamlText = result.text.trim()
            const match = yamlText.match(/```yaml([\s\S]*?)```/)
            if (match) {
              yamlText = match[1].trim()
            } else {
              const plainMatch = yamlText.match(/```([\s\S]*?)```/)
              if (plainMatch) {
                yamlText = plainMatch[1].trim()
              }
            }

            json(res, { yaml: yamlText })
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to generate test case' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // POST /api/tests/validate — validate YAML content (must be before parameterized /api/tests/:path)
    if (path === '/api/tests/validate' && req.method === 'POST') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      readJsonBody<{ content: string; filePath?: string }>(req)
        .then(async (body) => {
          const result = await testFileManager.validate(body.content ?? '')
          json(res, result)
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // GET /api/tests — list all test files
    if (path === '/api/tests' && req.method === 'GET') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      testFileManager.list()
        .then(async files => {
          const targetPlatforms = await readTargetPlatformMap(configManager)
          const resolvedFiles = files.map((file) => ({
            ...file,
            platform: resolveEffectivePlatform(file.platform, file.targetName, targetPlatforms),
          }))
          const targets = Array.from(
            new Set(
              resolvedFiles
                .map((file) => file.targetName)
                .filter((value): value is string => typeof value === 'string' && value.length > 0),
            ),
          )
          json(res, { files: resolvedFiles, targets })
        })
        .catch(() => json(res, { error: 'Failed to list test files' }, 500))
      return
    }

    // POST /api/tests — create a new test file
    if (path === '/api/tests' && req.method === 'POST') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      readJsonBody<{ path: string; content: string }>(req)
        .then(async (body) => {
          if (!body.path || typeof body.path !== 'string' || !body.content || typeof body.content !== 'string') {
            json(res, { error: 'Both path and content are required' }, 400)
            return
          }
          try {
            await testFileManager.write(body.path, body.content)
            json(res, { path: body.path, created: true }, 201)
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to create test file' }, 400)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // DELETE /api/tests/:t_id — delete test file by test-id
    if (path.startsWith('/api/tests/') && req.method === 'DELETE') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      const tId = decodeURIComponent(path.slice('/api/tests/'.length))
      testFileManager.findByTestId(tId)
        .then(async (found) => {
          if (!found) {
            notFound(res, 'Test not found')
            return
          }
          await testFileManager.delete(found.path)
          json(res, { deleted: true, path: found.path })
        })
        .catch((err: unknown) => {
          const code = (err as NodeJS.ErrnoException)?.code
          if (code === 'ENOENT') {
            notFound(res, 'Test not found')
            return
          }
          json(res, { error: err instanceof Error ? err.message : 'Failed to delete test file' }, 500)
        })
      return
    }

    // PUT /api/tests/:t_id — update test file by test-id
    if (path.startsWith('/api/tests/') && req.method === 'PUT') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      const tId = decodeURIComponent(path.slice('/api/tests/'.length))
      readJsonBody<{ content: string }>(req)
        .then(async (body) => {
          if (!body.content || typeof body.content !== 'string') {
            json(res, { error: 'Content is required' }, 400)
            return
          }
          const found = await testFileManager.findByTestId(tId)
          if (!found) {
            notFound(res, 'Test not found')
            return
          }
          try {
            await testFileManager.write(found.path, body.content)
            json(res, { path: found.path, updated: true })
          } catch (err) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update test file' }, 400)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // GET /api/tests/:t_id — read test file by test-id
    if (path.startsWith('/api/tests/') && req.method === 'GET') {
      if (!testFileManager) {
        json(res, { error: 'Test file management not configured' }, 501)
        return
      }
      const tId = decodeURIComponent(path.slice('/api/tests/'.length))
      testFileManager.findByTestId(tId)
        .then(result => {
          if (!result) {
            notFound(res, 'Test not found')
            return
          }
          json(res, { path: result.path, content: result.content, testId: tId })
        })
        .catch(() => notFound(res, 'Test not found'))
      return
    }

    // GET /api/analytics/tests
    if (path === '/api/analytics/tests' && req.method === 'GET') {
      const minRuns = url.searchParams.has('minRuns') ? parseInt(url.searchParams.get('minRuns')!, 10) : 3
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const tests = db.getFlakyTests({ minRuns, limit })
      const result = tests.map(t => {
        return { ...t, isFlaky: t.flakyScore >= 0.4 }
      })
      json(res, { tests: result })
      return
    }

    // GET /api/analytics/tests/:name/report
    if (path.startsWith('/api/analytics/tests/') && path.endsWith('/report') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/analytics/tests/'.length, -'/report'.length))
      try {
        const runs = db.getRunsByTestName(name, { limit: 1000 })
        const steps = db.getStepsByTestName(name)
        
        generateDocxReport(name, runs, steps)
          .then(docxBuffer => {
            res.writeHead(200, {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}_report.docx"`
            })
            res.end(docxBuffer)
          })
          .catch(err => {
            json(res, { error: err instanceof Error ? err.message : 'Failed to generate report' }, 500)
          })
      } catch (err) {
        json(res, { error: err instanceof Error ? err.message : 'Failed to generate report' }, 500)
      }
      return
    }

    // GET /api/analytics/tests/:name
    if (path.startsWith('/api/analytics/tests/') && req.method === 'GET') {
      const name = decodeURIComponent(path.slice('/api/analytics/tests/'.length))
      const limit = url.searchParams.has('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 50
      const offset = url.searchParams.has('offset') ? parseInt(url.searchParams.get('offset')!, 10) : 0
      const from = url.searchParams.get('from') ?? undefined
      void readAnalyticsScopePredicates(configManager)
        .then((scopeResult) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }

          const runs = db.getRunsByTestName(name, { limit, offset })
          const total = db.getRunsByTestNameCount(name)
          const trends = db.getTestTrends(name, { from })
          const allRunsForFlakiness = db.getRunsByTestName(name, { limit: 100 })
          const flakyMetrics = calculateFlakyMetrics(allRunsForFlakiness)
          const flakyScore = flakyMetrics.score
          const configured = scopeResult.predicates.length > 0
          const scopedRuns = configured
            ? db.getRunsByTestName(name, { limit, offset, attributePredicates: scopeResult.predicates })
            : runs
          const scopedTotal = configured
            ? db.getRunsByTestNameCount(name, { attributePredicates: scopeResult.predicates })
            : total
          const scopedTrends = configured
            ? db.getTestTrends(name, { from, attributePredicates: scopeResult.predicates })
            : trends
          const scopedRunsForFlakiness = configured
            ? db.getRunsByTestName(name, { limit: 100, attributePredicates: scopeResult.predicates })
            : allRunsForFlakiness
          const scopedFlakyScore = calculateFlakyMetrics(scopedRunsForFlakiness).score

          // Calculate heal stats for all runs of this test
          const allRunsForHeal = db.getRunsByTestName(name)
          const allHealedIds = db.getHealedRunIds(allRunsForHeal.map(r => r.id))
          const healCount = allRunsForHeal.filter(r => r.status === 'flaky' || allHealedIds.has(r.id)).length
          const healRate = allRunsForHeal.length > 0 ? healCount / allRunsForHeal.length : 0

          // Calculate retry stats for all runs of this test
          const retryCount = allRunsForHeal.filter(r => r.retryCount > 0).length
          const retryRate = allRunsForHeal.length > 0 ? retryCount / allRunsForHeal.length : 0

          // Calculate heal stats for scoped runs of this test
          let scopedHealCount = 0
          let scopedHealRate = 0
          let scopedRetryCount = 0
          let scopedRetryRate = 0
          if (configured) {
            const scopedRunsForHeal = db.getRunsByTestName(name, { attributePredicates: scopeResult.predicates })
            const scopedHealedIds = db.getHealedRunIds(scopedRunsForHeal.map(r => r.id))
            scopedHealCount = scopedRunsForHeal.filter(r => r.status === 'flaky' || scopedHealedIds.has(r.id)).length
            scopedHealRate = scopedRunsForHeal.length > 0 ? scopedHealCount / scopedRunsForHeal.length : 0

            scopedRetryCount = scopedRunsForHeal.filter(r => r.retryCount > 0).length
            scopedRetryRate = scopedRunsForHeal.length > 0 ? scopedRetryCount / scopedRunsForHeal.length : 0
          }

          const allSteps = db.getStepsByTestName(name)
          let happyPathTotal = 0
          let happyPathPassed = 0
          let happyPathFailed = 0
          let happyPathHealed = 0

          let negativeTotal = 0
          let negativePassed = 0
          let negativeFailed = 0
          let negativeHealed = 0

          let edgeTotal = 0
          let edgePassed = 0
          let edgeFailed = 0
          let edgeHealed = 0

          for (const step of allSteps) {
            const stepName = step.name || ''
            const status = step.status
            const isHealed = status === 'healed'
            const isPassed = status === 'passed' || status === 'healed' || status === 'completed'
            
            if (stepName.startsWith('[Happy Path]')) {
              happyPathTotal++
              if (isHealed) happyPathHealed++
              if (isPassed) happyPathPassed++
              else happyPathFailed++
            } else if (stepName.startsWith('[Negative]')) {
              negativeTotal++
              if (isHealed) negativeHealed++
              if (isPassed) negativePassed++
              else negativeFailed++
            } else if (stepName.startsWith('[Edge]')) {
              edgeTotal++
              if (isHealed) edgeHealed++
              if (isPassed) edgePassed++
              else edgeFailed++
            }
          }

          const happyPathSuccessRate = happyPathTotal > 0 ? happyPathPassed / happyPathTotal : 0
          const happyPathHealRate = happyPathTotal > 0 ? happyPathHealed / happyPathTotal : 0

          const negativeSuccessRate = negativeTotal > 0 ? negativePassed / negativeTotal : 0
          const negativeHealRate = negativeTotal > 0 ? negativeHealed / negativeTotal : 0

          const edgeSuccessRate = edgeTotal > 0 ? edgePassed / edgeTotal : 0
          const edgeHealRate = edgeTotal > 0 ? edgeHealed / edgeTotal : 0

          json(res, {
            name,
            runs,
            total,
            trends,
            isFlaky: flakyScore >= 0.4 && flakyMetrics.statusCount >= 3,
            flakyScore,
            healCount,
            healRate,
            retryCount,
            retryRate,
            categoryAnalysis: {
              happyPath: { total: happyPathTotal, passed: happyPathPassed, failed: happyPathFailed, healed: happyPathHealed, successRate: happyPathSuccessRate, healRate: happyPathHealRate },
              negative: { total: negativeTotal, passed: negativePassed, failed: negativeFailed, healed: negativeHealed, successRate: negativeSuccessRate, healRate: negativeHealRate },
              edge: { total: edgeTotal, passed: edgePassed, failed: edgeFailed, healed: edgeHealed, successRate: edgeSuccessRate, healRate: edgeHealRate },
            },
            scope: {
              configured,
              predicates: scopeResult.predicates,
              scopedCount: scopedTotal,
              totalCount: total,
            },
            ...(configured ? {
              scopedRuns,
              scopedTrends,
              scopedFlakyScore,
              scopedHealCount,
              scopedHealRate,
              scopedRetryCount,
              scopedRetryRate,
            } : {}),
          })
        })
        .catch(() => json(res, { error: 'Failed to read analytics scope' }, 500))
      return
    }

    // GET /api/analytics/breakdowns
    if (path === '/api/analytics/breakdowns' && req.method === 'GET') {
      const dimension = url.searchParams.get('dimension')
      if (dimension !== 'test' && dimension !== 'platform') {
        json(res, { error: 'dimension must be one of: test, platform' }, 400)
        return
      }

      const limitResult = parseBoundedIntegerQueryParam(url.searchParams.get('limit'), 'limit', 1, 100, 25)
      if (!limitResult.ok) {
        json(res, { error: limitResult.error }, 400)
        return
      }

      const fromResult = parseIsoDateQueryParam(url.searchParams.get('from'), 'from')
      if (!fromResult.ok) {
        json(res, { error: fromResult.error }, 400)
        return
      }

      const toResult = parseIsoDateQueryParam(url.searchParams.get('to'), 'to')
      if (!toResult.ok) {
        json(res, { error: toResult.error }, 400)
        return
      }

      const scope = url.searchParams.get('scope') ?? undefined
      if (scope !== undefined && scope !== 'passRate') {
        json(res, { error: 'scope must be passRate when provided' }, 400)
        return
      }

      void readAnalyticsScopePredicates(configManager)
        .then(async (scopeResult) => {
          if (!scopeResult.ok) {
            json(res, { error: scopeResult.error }, 400)
            return
          }

          const configured = scopeResult.predicates.length > 0
          const attributePredicates = scope === 'passRate' && configured ? scopeResult.predicates : undefined
          const rows = db.getInsightsBreakdown(dimension as InsightsBreakdownDimension, {
            from: fromResult.value,
            to: toResult.value,
            limit: limitResult.value,
            attributePredicates,
          })
          const scopedCount = configured
            ? db.getInsightsBreakdown(dimension as InsightsBreakdownDimension, {
                from: fromResult.value,
                to: toResult.value,
                limit: 100,
                attributePredicates: scopeResult.predicates,
              }).reduce((sum, row) => sum + row.runs, 0)
            : 0
          const totalCount = db.getInsightsBreakdown(dimension as InsightsBreakdownDimension, {
            from: fromResult.value,
            to: toResult.value,
            limit: 100,
          }).reduce((sum, row) => sum + row.runs, 0)
          const payload = {
            dimension,
            rows,
            scope: {
              configured,
              predicates: scopeResult.predicates,
              scopedCount,
              totalCount,
            },
          }

          json(res, payload)
        })
        .catch(() => {
          json(res, { error: 'Unable to read analytics breakdown scope' }, 500)
        })
      return
    }

    // GET /api/app-metadata — return narrow non-sensitive app metadata
    if (path === '/api/app-metadata' && req.method === 'GET') {
      const version = getAgentQaVersion().trim() || '0.0.0'
      ;(async () => {
        try {
          const status = await getAgentQaUpdateStatus()
          const latestVersion = typeof status.latestVersion === 'string'
            ? status.latestVersion.trim()
            : ''
          if (status.updateAvailable === true && latestVersion) {
            json(res, { version, update: { latestVersion } })
            return
          }
        } catch {
          // Keep app metadata available even when update checks fail.
        }

        json(res, { version })
      })().catch(() => {
        json(res, { version })
      })
      return
    }

    // GET /api/config/targets — return registered target names
    if (path === '/api/config/targets' && req.method === 'GET') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const config = await configManager.read()
          const configObj = config as Record<string, unknown>
          const registry = configObj.registry as Record<string, unknown> | undefined
          const targets = registry?.targets as Record<string, unknown> | undefined
          const names = targets ? Object.keys(targets) : []
          json(res, { targets: names })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read targets' }, 500)
        }
      })()
      return
    }

    // GET /api/config — return masked config with active provider info
    if (path === '/api/config' && req.method === 'GET') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const config = await configManager.readMasked()
          const configObj = config as Record<string, unknown>
          const registry = configObj.registry as Record<string, unknown> | undefined
          const llms = (registry?.llms ?? configObj.llms) as Array<Record<string, unknown>> | undefined
          const use = configObj.use as Record<string, unknown> | undefined
          const activeLlm = (use?.llm ?? configObj.defaultLLM) as string | undefined
          const defaultCfg = llms?.find((c) => c.name === activeLlm)
          const provider = (defaultCfg?.provider as string) ?? null
          json(res, { config, provider })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read config' }, 500)
        }
      })()
      return
    }

    // PUT /api/config/llms — update registry.llms array + use.llm
    if (path === '/api/config/llms' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ llms: unknown[]; defaultLLM?: string; activeLlm?: string }>(req)
        .then(async (body) => {
          try {
            if (!Array.isArray(body.llms) || body.llms.length === 0) {
              json(res, { error: 'llms array is required and must not be empty' }, 400)
              return
            }
            const selectedLlm = body.activeLlm ?? body.defaultLLM
            const errors: string[] = []
            const names: string[] = []
            const sanitizedArray: Array<ReturnType<typeof NamedLLMConfigSchema.parse>> = []
            for (const item of body.llms) {
              const result = NamedLLMConfigSchema.safeParse(item)
              if (!result.success) {
                for (const issue of result.error.issues) {
                  errors.push(`${issue.path.join('.')}: ${issue.message}`)
                }
              } else {
                names.push(result.data.name)
                sanitizedArray.push(result.data)
              }
            }
            const dupes = names.filter((n, i) => names.indexOf(n) !== i)
            if (dupes.length > 0) {
              errors.push(`Duplicate config names: ${[...new Set(dupes)].join(', ')}`)
            }
            if (!selectedLlm || !names.includes(selectedLlm)) {
              errors.push(`use.llm "${selectedLlm}" does not match any name in registry.llms`)
            }
            if (errors.length > 0) {
              json(res, { error: 'Validation failed', details: errors }, 400)
              return
            }
            await configManager.replaceSectionRaw('registry.llms', sanitizedArray)
            await configManager.replaceSectionRaw('use.llm', selectedLlm)
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update LLM config' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // PUT /api/config/default-llm — switch active LLM (use.llm)
    if (path === '/api/config/default-llm' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ defaultLLM?: string; llm?: string }>(req)
        .then(async (body) => {
          try {
            const llmName = body.llm ?? body.defaultLLM
            if (!llmName || typeof llmName !== 'string') {
              json(res, { error: 'use.llm string is required' }, 400)
              return
            }
            const config = await configManager.readMasked()
            const configObj = config as Record<string, unknown>
            const registry = configObj.registry as Record<string, unknown> | undefined
            const llms = (registry?.llms ?? configObj.llms) as Array<Record<string, unknown>> | undefined
            const names = (llms ?? []).map((c) => c.name as string)
            if (!names.includes(llmName)) {
              json(res, { error: `use.llm "${llmName}" does not match any name in registry.llms` }, 400)
              return
            }
            await configManager.replaceSectionRaw('use.llm', llmName)
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update use.llm' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // POST /api/config/farm/test-connection — test farm provider credentials
    if (path === '/api/config/farm/test-connection' && req.method === 'POST') {
      readJsonBody<{ provider: string; username: string; accessKey: string }>(req)
        .then(async (body) => {
          if (body.provider !== 'browserstack') {
            json(res, { error: 'Only BrowserStack is currently supported' }, 400)
            return
          }
          try {
            const auth = Buffer.from(`${body.username}:${body.accessKey}`).toString('base64')
            const response = await fetch('https://api-cloud.browserstack.com/app-automate/devices.json', {
              headers: { Authorization: `Basic ${auth}` },
            })
            if (response.ok) {
              json(res, { success: true })
            } else if (response.status === 401) {
              json(res, { success: false, error: 'Invalid credentials' })
            } else {
              json(res, { success: false, error: `BrowserStack API returned ${response.status}` })
            }
          } catch (err) {
            json(res, { success: false, error: err instanceof Error ? err.message : 'Connection failed' })
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // PUT /api/config/settings — update config sections
    if (path === '/api/config/settings' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<Record<string, unknown>>(req)
        .then(async (body) => {
          try {
            const sectionValidators: Record<string, { safeParse: (v: unknown) => ConfigSectionValidationResult }> = {
              'use.timeout': TimeoutConfigSchema,
              'use.healing': HealingConfigSchema,
              'use.planner': PlannerConfigSchema,
              'use.logCapture': LogCaptureConfigSchema,
              'use.browser': BrowserConfigSchema,
              'use.browser.headless': BrowserConfigSchema.shape.headless,
              'services.memory': ServicesSchema.shape.memory,
              'services.cache': CacheConfigSchema,
              'services.logging': LoggingConfigSchema,
              'services.recording': RecordingConfigSchema,
              'services.accessibility': AccessibilityConfigSchema,
              'services.dashboard': DashboardConfigSchema,
              'services.mcp': McpConfigSchema,
              'registry.targets': RegistrySchema.shape.targets,
              'registry.devices': RegistrySchema.shape.devices,
              'registry.providers': RegistrySchema.shape.providers,
              'analytics.passRateScope': { safeParse: validateAnalyticsPassRateScope },
              'workspace.testMatch': WorkspaceSchema.shape.testMatch,
              'workspace.agentRules': WorkspaceSchema.shape.agentRules,
              'workspace.envFile': WorkspaceSchema.shape.envFile,
              'workspace.secretsFile': WorkspaceSchema.shape.secretsFile,
              'use.mobile': UseSchema.shape.mobile,
              'use.mobile.appState': MobileAppStateSchema,
              'use.parallel': UseSchema.shape.parallel,
            }
            const objectSections = [
              'use.timeout',
              'use.healing',
              'use.planner',
              'use.logCapture',
              'use.browser',
              'use.mobile',
              'services.memory',
              'services.cache',
              'services.logging',
              'services.recording',
              'services.accessibility',
              'services.dashboard',
              'services.mcp',
              'registry.targets',
              'registry.devices',
              'registry.providers',
              'analytics.passRateScope',
            ] as const
            const arraySections = ['workspace.testMatch', 'workspace.testPathIgnore', 'registry.llms'] as const
            const scalarSections = [
              'workspace.agentRules',
              'workspace.envFile',
              'workspace.secretsFile',
              'use.llm',
              'use.mobile.appState',
              'use.browser.headless',
              'use.parallel',
            ] as const

            const currentConfig = await configManager.read()
            const currentUse = isRecord(currentConfig.use) ? currentConfig.use : {}
            const currentBrowser = isRecord(currentUse.browser) ? currentUse.browser : {}
            const currentHasRootHeadless = typeof currentUse.headless === 'boolean'
            const currentHasBrowserHeadless = typeof currentBrowser.headless === 'boolean'
            const requestHasRootHeadless = Object.prototype.hasOwnProperty.call(body, 'use.headless')
            const requestHasBrowserHeadlessScalar = Object.prototype.hasOwnProperty.call(body, 'use.browser.headless')
            const requestBrowserBlock = body['use.browser']
            const requestHasBrowserHeadlessObject = isRecord(requestBrowserBlock) && typeof requestBrowserBlock.headless === 'boolean'
            if (
              currentHasRootHeadless
              && !currentHasBrowserHeadless
              && !requestHasBrowserHeadlessScalar
              && !requestHasBrowserHeadlessObject
            ) {
              body['use.browser.headless'] = currentUse.headless
            }

            const allowedSettingsPaths = new Set<string>([
              ...Object.keys(sectionValidators),
              ...objectSections,
              ...arraySections,
              ...scalarSections,
              'use.headless',
            ])
            const unsupportedKeys = Object.keys(body).filter((key) => !allowedSettingsPaths.has(key))
            if (unsupportedKeys.length > 0) {
              json(res, { error: 'Unsupported setting path', details: unsupportedKeys }, 400)
              return
            }

            const errors: string[] = []
            for (const [section, validator] of Object.entries(sectionValidators)) {
              const value = body[section]
              if (value !== undefined) {
                const result = validator.safeParse(value)
                if (!result.success) {
                  for (const issue of result.error!.issues) {
                    const path = issue.path.length ? `${section}.${issue.path.map(String).join('.')}` : section
                    errors.push(`${path}: ${issue.message}`)
                  }
                }
              }
            }

            if (Array.isArray(body['registry.llms'])) {
              for (const [idx, item] of (body['registry.llms'] as unknown[]).entries()) {
                const result = NamedLLMConfigSchema.safeParse(item)
                if (!result.success) {
                  for (const issue of result.error!.issues) {
                    const p = issue.path.length ? `registry.llms[${idx}].${issue.path.join('.')}` : `registry.llms[${idx}]`
                    errors.push(`${p}: ${issue.message}`)
                  }
                }
              }
            }

            if (errors.length > 0) {
              json(res, { error: 'Validation failed', details: errors }, 400)
              return
            }

            for (const section of objectSections) {
              if (body[section] && typeof body[section] === 'object') {
                await configManager.replaceSection(section, body[section] as Record<string, unknown>)
              }
            }
            for (const section of arraySections) {
              if (body[section] !== undefined) {
                await configManager.replaceSectionRaw(section, body[section])
              }
            }
            for (const section of scalarSections) {
              if (body[section] !== undefined) {
                await configManager.replaceSectionRaw(section, body[section])
              }
            }
            if (currentHasRootHeadless || requestHasRootHeadless) {
              await configManager.deleteSectionRaw('use.headless')
            }
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update settings' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // DELETE /api/auth/:configName — remove stored credential
    if (path.startsWith('/api/auth/') && req.method === 'DELETE') {
      const segments = path.split('/')
      if (segments.length === 4 && segments[2] === 'auth') {
        const providerName = decodeURIComponent(segments[3])
        if (providerName === 'status' || providerName === 'credential' || providerName === 'oauth') {
          // Fall through to other handlers
        } else {
          ;(async () => {
            try {
              await removeAuth(providerName)
              json(res, { deleted: true })
            } catch (err: unknown) {
              json(res, { error: err instanceof Error ? err.message : 'Failed to delete credential' }, 500)
            }
          })()
          return
        }
      }
    }

    // GET /api/auth/status — return credential info from auth store
    if (path === '/api/auth/status' && req.method === 'GET') {
      ;(async () => {
        try {
          const credentials: Array<{
            type: string
            provider: string
            configName: string
            expires: number | null
            source: string
          }> = []
          const store = await readAuth() as Record<string, DashboardAuthCredential>
          for (const [key, cred] of Object.entries(store)) {
            if (cred) {
              let provider = cred.provider ?? key
              if (cred.type === 'oauth') {
                provider = toProductProviderLabel(provider)
              } else if (cred.type === 'bearer') {
                provider = cred.provider
              }
              credentials.push({
                type: cred.type,
                provider,
                configName: key,
                expires: cred.type === 'oauth' ? cred.tokens.expires : null,
                source: 'auth-store',
              })
            }
          }
          json(res, { credentials })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read auth status' }, 500)
        }
      })()
      return
    }

    // GET /api/llm/providers — built-in and plugin-provided LLM provider metadata
    if (path === '/api/llm/providers' && req.method === 'GET') {
      json(res, {
        providers: [
          ...builtinLLMProviderMetadata(),
          ...listLLMAuthProviderPlugins().map(serializeAuthProviderPlugin),
        ],
      })
      return
    }

    if (path.startsWith('/api/auth/plugin/')) {
      pruneExpiredPluginOAuthSessions(pluginOAuthSessions)
      const segments = path.split('/')
      const provider = segments.length >= 6 ? decodeURIComponent(segments[4] ?? '') : ''
      const action = segments.length >= 6 ? segments[5] : ''
      const plugin = provider ? getLLMAuthProviderPlugin(provider) : undefined

      if (!plugin) {
        json(res, { error: `Auth plugin provider "${provider}" is not registered` }, 404)
        return
      }

      if (action === 'start' && req.method === 'POST') {
        readJsonBody<{ configName?: string; callbackUrl?: string }>(req)
          .then(async (body) => {
            if (!plugin.startAuth) {
              json(res, { error: `Provider "${provider}" does not support dashboard auth start` }, 400)
              return
            }

            try {
              const target = await requirePluginAuthConfig(configManager, body.configName, plugin)
              if (!target.ok) {
                json(res, { error: target.error }, 400)
                return
              }
              const started = await plugin.startAuth({
                configName: target.configName,
                callbackUrl: typeof body.callbackUrl === 'string' ? body.callbackUrl : undefined,
              })
              const sessionId = randomUUID()
              const session: PluginOAuthSession = {
                providerId: plugin.providerId,
                credentialProviderId: plugin.credentialProviderId,
                configName: target.configName,
                sessionState: started.sessionState,
                cleanup: started.cleanup,
                status: 'pending',
                expiresAt: Date.now() + PLUGIN_OAUTH_SESSION_TTL_MS,
              }
              pluginOAuthSessions.set(sessionId, session)

              if (started.waitForTokens) {
                started.waitForTokens
                  .then(async (tokens: OAuthTokens) => {
                    await writeDashboardAuth(target.configName, {
                      type: 'oauth',
                      provider: plugin.credentialProviderId,
                      tokens,
                    })
                    session.status = 'completed'
                  })
                  .catch((err: unknown) => {
                    session.status = 'error'
                    session.error = err instanceof Error ? err.message : 'Authentication failed'
                  })
                  .finally(() => cleanupPluginOAuthSession(session))
              }

              json(res, {
                authorizeUrl: started.authorizeUrl,
                sessionId,
                mode: plugin.dashboardAuth.mode,
              })
            } catch (err: unknown) {
              json(res, { error: err instanceof Error ? err.message : 'Failed to start auth plugin flow' }, 500)
            }
          })
          .catch(() => json(res, { error: 'Invalid request body' }, 400))
        return
      }

      if (action === 'result' && req.method === 'GET') {
        const sessionId = url.searchParams.get('session') ?? ''
        const session = pluginOAuthSessions.get(sessionId)
        if (!session || session.providerId !== provider) {
          json(res, { error: 'Auth session not found' }, 404)
          return
        }
        if (session.status === 'completed') {
          cleanupPluginOAuthSession(session)
          pluginOAuthSessions.delete(sessionId)
          json(res, { status: 'completed', saved: true })
          return
        }
        if (session.status === 'error') {
          cleanupPluginOAuthSession(session)
          pluginOAuthSessions.delete(sessionId)
          json(res, { status: 'error', error: session.error ?? 'Authentication failed' })
          return
        }
        json(res, { status: 'pending' })
        return
      }

      if (action === 'exchange' && req.method === 'POST') {
        readJsonBody<{ sessionId?: string; code?: string }>(req)
          .then(async (body) => {
            if (!plugin.exchangeCode) {
              json(res, { error: `Provider "${provider}" does not support code exchange` }, 400)
              return
            }
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            const code = typeof body.code === 'string' ? body.code.trim() : ''
            if (!sessionId || !code) {
              json(res, { error: 'sessionId and code are required' }, 400)
              return
            }
            const session = pluginOAuthSessions.get(sessionId)
            if (!session || session.providerId !== provider) {
              json(res, { error: 'Auth session not found' }, 404)
              return
            }
            if (session.status !== 'pending') {
              json(res, { error: 'Auth session is no longer pending' }, 409)
              return
            }

            try {
              const tokens = await plugin.exchangeCode({
                code,
                sessionState: session.sessionState,
              })
              await writeDashboardAuth(session.configName, {
                type: 'oauth',
                provider: session.credentialProviderId,
                tokens,
              })
              session.status = 'completed'
              cleanupPluginOAuthSession(session)
              pluginOAuthSessions.delete(sessionId)
              json(res, { status: 'completed', saved: true })
            } catch (err: unknown) {
              session.status = 'error'
              session.error = err instanceof Error ? err.message : 'Token exchange failed'
              cleanupPluginOAuthSession(session)
              pluginOAuthSessions.delete(sessionId)
              json(res, { error: session.error }, 500)
            }
          })
          .catch(() => json(res, { error: 'Invalid request body' }, 400))
        return
      }

      json(res, { error: 'Auth plugin route not found' }, 404)
      return
    }

    // POST /api/auth/credential — store typed credentials from dashboard
    if (path === '/api/auth/credential' && req.method === 'POST') {
      readJsonBody<{
        configName?: string
        provider?: string
        type?: string
        secret?: string
      }>(req)
        .then(async (body) => {
          const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
          const credentialType = typeof body.type === 'string' ? body.type.trim() : ''
          const secret = typeof body.secret === 'string' ? body.secret.trim() : ''

          if (typeof body.configName !== 'string' || body.configName.trim() === '') {
            json(res, { error: 'configName is required' }, 400)
            return
          }
          if (!provider || !isKnownLLMProvider(provider)) {
            json(res, { error: 'valid provider is required' }, 400)
            return
          }
          if (credentialType !== 'api-key' && credentialType !== 'bearer-token') {
            json(res, { error: 'type must be api-key or bearer-token' }, 400)
            return
          }
          if (!secret) {
            json(res, { error: 'secret is required' }, 400)
            return
          }

          if (getLLMAuthProviderPlugin(provider)) {
            json(res, { error: 'Subscription providers use OAuth login' }, 400)
            return
          }

          if (credentialType === 'bearer-token' && provider !== 'anthropic-compatible') {
            json(res, { error: 'bearer-token credentials are only supported for anthropic-compatible configs' }, 400)
            return
          }

          if (credentialType === 'api-key' && !API_KEY_CREDENTIAL_PROVIDERS.has(provider)) {
            json(res, { error: 'api-key credentials are not supported for this provider' }, 400)
            return
          }

          try {
            const target = await requireCredentialConfig(configManager, body.configName, provider)
            if (!target.ok) {
              json(res, { error: target.error }, 400)
              return
            }

            if (credentialType === 'bearer-token') {
              await writeDashboardAuth(target.configName, { type: 'bearer', provider, token: secret })
            } else {
              await writeDashboardAuth(target.configName, { type: 'api', provider, key: secret })
            }
            json(res, { saved: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to save credential' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // POST /api/llm/test — test LLM connection
    if (path === '/api/llm/test' && req.method === 'POST') {
      readJsonBody<{
        configName?: string
        provider?: string
        model?: string
        baseURL?: string
        providerHeaders?: Record<string, string>
      }>(req)
        .then(async (body) => {
          const rawBody = body as Record<string, unknown>
          if ('apiKey' in rawBody) {
            json(res, {
              success: false,
              error: 'invalid_request',
              message: 'apiKey is not accepted in LLM test requests. Save credentials for the named config instead.',
            }, 400)
            return
          }
          const providerName = typeof body.provider === 'string' ? body.provider.trim() : ''
          const modelName = typeof body.model === 'string' ? body.model.trim() : ''
          if (!providerName || !modelName) {
            json(res, { success: false, error: 'invalid_request', message: 'provider and model are required' }, 400)
            return
          }
          const configName = typeof body.configName === 'string' ? body.configName.trim() : ''

          const llmCandidate: Record<string, unknown> = {
            provider: providerName,
            model: modelName,
          }
          if (typeof body.baseURL === 'string') {
            llmCandidate.baseURL = body.baseURL
          }
          if (body.providerHeaders !== undefined) {
            llmCandidate.providerHeaders = body.providerHeaders
          }

          const parsedConfig = ModelConfigSchema.safeParse(llmCandidate)
          if (!parsedConfig.success) {
            json(res, {
              success: false,
              error: 'invalid_request',
              message: parsedConfig.error.issues
                .map((issue: { path: PropertyKey[]; message: string }) => `${issue.path.map(String).join('.') || 'config'}: ${issue.message}`)
                .join('; '),
            }, 400)
            return
          }

          const start = Date.now()
          const llmConfig = parsedConfig.data
          const coreAuth = await import('@vostride/agent-qa-core') as typeof import('@vostride/agent-qa-core') & {
            resolveLLMAuth: (name: string, config: typeof llmConfig) => Promise<
              | { kind: 'api-key'; apiKey: string }
              | { kind: 'bearer-token'; token: string }
              | { kind: 'auth-fetch'; fetch: typeof globalThis.fetch; modelAdapter: 'openai-responses' | 'anthropic-messages' }
              | { kind: 'unauthenticated'; message: string }
              | { kind: 'missing'; message: string }
            >
          }
          const resolvedAuth = await coreAuth.resolveLLMAuth(configName, llmConfig)
          if (resolvedAuth.kind === 'missing') {
            json(res, {
              success: false,
              error: 'missing_credential',
              message: resolvedAuth.message,
            })
            return
          }

          const modelConfig: Record<string, unknown> = { ...llmConfig }
          let unauthenticated = false
          let authMessage: string | undefined

          if (resolvedAuth.kind === 'api-key') {
            modelConfig.apiKey = resolvedAuth.apiKey
          } else if (resolvedAuth.kind === 'bearer-token') {
            modelConfig.authToken = resolvedAuth.token
          } else if (resolvedAuth.kind === 'auth-fetch') {
            modelConfig.fetch = resolvedAuth.fetch
            modelConfig.modelAdapter = resolvedAuth.modelAdapter
          } else if (resolvedAuth.kind === 'unauthenticated') {
            unauthenticated = true
            authMessage = resolvedAuth.message
          }

          try {
            const { createModel } = await import('@vostride/agent-qa-core')
            const model = await createModel(modelConfig as unknown as Parameters<typeof createModel>[0])

            const testProviderOpts = getProviderOptions(modelConfig as unknown as Parameters<typeof getProviderOptions>[0])
            const connectionTimeoutMs = llmConnectionTestTimeoutMs(llmConfig)

            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), connectionTimeoutMs)
            try {
              const { generateText } = await import('ai')
              await generateText({
                model,
                prompt: 'Say "ok"',
                abortSignal: controller.signal,
                providerOptions: testProviderOpts,
              })
            } finally {
              clearTimeout(timeout)
            }

            json(res, {
              success: true,
              model: modelName,
              provider: providerName,
              timeoutMs: connectionTimeoutMs,
              responseTime: Date.now() - start,
              ...(unauthenticated ? { unauthenticated: true, message: authMessage ?? LLM_TEST_UNAUTHENTICATED_MESSAGE } : {}),
            })
          } catch (err: unknown) {
            const connectionTimeoutMs = llmConnectionTestTimeoutMs(llmConfig)
            const { message: providerMessage, statusCode } = extractProviderErrorMessage(err)
            const errorCategory = classifyProviderError(providerMessage, statusCode)
            const message = publicLLMTestMessage(errorCategory, providerMessage)

            json(res, {
              success: false,
              error: errorCategory,
              message,
              timeoutMs: connectionTimeoutMs,
              ...(statusCode ? { statusCode } : {}),
              ...(message !== providerMessage ? { details: providerMessage } : {}),
              ...(unauthenticated ? { unauthenticated: true, authMessage: authMessage ?? LLM_TEST_UNAUTHENTICATED_MESSAGE } : {}),
            })
          }
        })
        .catch(() => json(res, { success: false, error: 'invalid_request', message: 'Invalid request body' }, 400))
      return
    }

    // POST /api/cache/purge — purge cached action plans for a test or all tests
    if (path === '/api/cache/purge' && req.method === 'POST') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 503)
        return
      }
      readJsonBody<{ file?: string; all?: boolean }>(req)
        .then(async (body) => {
          if (!body.file && !body.all) {
            json(res, { error: 'Either file or all is required' }, 400)
            return
          }
          try {
            const cfg = await configManager.read()
            const targetPlatforms = getTargetPlatformMap(cfg)
            const cacheDir = (cfg as {
              services?: { cache?: { dir?: string } }
              cache?: { dir?: string }
            }).services?.cache?.dir
              ?? (cfg as { cache?: { dir?: string } }).cache?.dir
            if (!cacheDir) {
              json(res, { error: 'Cache directory not configured' }, 400)
              return
            }
            if (body.file) {
              // Read raw config file content for cache key scoping
              let configContent = ''
              if (deps.configPath) {
                try { configContent = await readFile(deps.configPath, 'utf-8') } catch { /* best-effort */ }
              }
              const resolvedPath = (await normalizeDashboardWorkspacePath(body.file, workspacePaths, 'test')).executionPath
              const content = await readFile(resolvedPath, 'utf-8')
              const doc = parseYaml(content)
              const metadata = extractTestFileMetadata(content)
              const platform = resolveEffectivePlatform(
                metadata.platform,
                metadata.targetName,
                targetPlatforms,
                'web',
              ) ?? 'web'
              const steps: string[] = (doc.steps ?? []).map((s: unknown) =>
                typeof s === 'string' ? s : (s as Record<string, string>).step,
              )
              const configDir = deps.configPath ? dirname(resolve(deps.configPath)) : process.cwd()
              const resolvedCacheDir = resolve(configDir, cacheDir)
              let purged = 0
              for (const step of steps) {
                const stepHash = hashStepInstruction(step, platform, configContent, content)
                const dirPath = join(resolvedCacheDir, stepHash)
                try {
                  await stat(dirPath)
                  await rm(dirPath, { recursive: true, force: true })
                  purged++
                } catch {
                  // directory doesn't exist — skip
                }
              }
              json(res, { purged })
            } else {
              const configDir = deps.configPath ? dirname(resolve(deps.configPath)) : process.cwd()
              const resolvedDir = resolve(configDir, cacheDir)
              let entries: string[]
              try {
                entries = await readdir(resolvedDir)
              } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                  json(res, { purged: 0 })
                  return
                }
                throw err
              }
              for (const entry of entries) {
                await rm(join(resolvedDir, entry), { recursive: true, force: true })
              }
              json(res, { purged: entries.length })
            }
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Cache purge failed' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // Agent Rules API
    if (path === '/api/agent-rules' && req.method === 'GET') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 503)
            return
          }
          let content: string
          try {
            content = await readFile(workspacePaths.agentRules.absolutePath, 'utf-8')
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              json(res, { content: null, filePath: workspacePaths.agentRules.workspaceRelativePath, error: 'workspace.agentRules file_not_found' }, 500)
              return
            }
            throw err
          }
          json(res, { content, filePath: workspacePaths.agentRules.workspaceRelativePath })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read agent rules' }, 500)
        }
      })()
      return
    }



    if (path === '/api/agent-rules' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ content: string }>(req)
        .then(async (body) => {
          try {
            if (typeof body.content !== 'string') {
              json(res, { error: 'Missing required field: content' }, 400)
              return
            }
            if (!workspacePaths) {
              json(res, { error: 'Workspace path resolution not available' }, 503)
              return
            }
            await writeFile(workspacePaths.agentRules.absolutePath, body.content, 'utf-8')
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to save agent rules' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    if (path === '/api/agent-rules/create' && req.method === 'POST') {
      if (!configManager || !deps.configPath) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      const configPath = deps.configPath
      readJsonBody<{ fileName?: string }>(req)
        .then(async (body) => {
          try {
            const fileName = typeof body.fileName === 'string' && body.fileName.trim()
              ? body.fileName.trim()
              : 'agent-rules.md'
            if (!isPlainFileName(fileName)) {
              json(res, { error: 'fileName must be a plain file name' }, 400)
              return
            }

            const configDir = dirname(configPath)
            const resolvedPath = resolve(configDir, fileName)
            if (!getPathInsideDir(resolvedPath, configDir)) {
              json(res, { error: 'Invalid agent rules path' }, 400)
              return
            }

            await writeFile(resolvedPath, '', { encoding: 'utf-8', flag: 'wx' })
            await configManager!.replaceSectionRaw('workspace.agentRules', `./${fileName}`)
            json(res, { created: true, filePath: `./${fileName}` })
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
              json(res, { error: 'Agent rules file already exists' }, 409)
              return
            }
            json(res, { error: err instanceof Error ? err.message : 'Failed to create agent rules file' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    // Variables API
    if (path === '/api/variables' && req.method === 'GET') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 503)
            return
          }
          let content: string
          try {
            content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              json(res, { error: `workspace.envFile not found: ${workspacePaths.envFile.workspaceRelativePath}` }, 500)
              return
            }
            throw err
          }
          const parsed = parseEnvFile(content)
          const variables = Object.entries(parsed).map(([key, value]) => ({ key, value }))
          json(res, { variables, filePath: workspacePaths.envFile.workspaceRelativePath })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read variables' }, 500)
        }
      })()
      return
    }

    if (path === '/api/variables' && req.method === 'PUT') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      readJsonBody<{ oldKey?: string; key: string; value: string }>(req)
        .then(async (body) => {
          try {
            if (!body.key || typeof body.key !== 'string') {
              json(res, { error: 'Missing required field: key' }, 400)
              return
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.key)) {
              json(res, { error: 'Variable names must contain only letters, numbers, and underscores' }, 400)
              return
            }
            if (!workspacePaths) {
              json(res, { error: 'Workspace path resolution not available' }, 503)
              return
            }
            let content = ''
            try {
              content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                json(res, { error: `workspace.envFile not found: ${workspacePaths.envFile.workspaceRelativePath}` }, 500)
                return
              }
              throw err
            }
            const vars = parseEnvFile(content)
            if (body.oldKey && body.oldKey !== body.key) {
              delete vars[body.oldKey]
            }
            vars[body.key] = body.value ?? ''
            await writeFile(workspacePaths.envFile.absolutePath, serializeEnvFile(vars), 'utf-8')
            json(res, { updated: true })
          } catch (err: unknown) {
            json(res, { error: err instanceof Error ? err.message : 'Failed to update variable' }, 500)
          }
        })
        .catch(() => json(res, { error: 'Invalid request body' }, 400))
      return
    }

    const varDeleteMatch = path.match(/^\/api\/variables\/(.+)$/)
    if (varDeleteMatch && req.method === 'DELETE') {
      if (!configManager) {
        json(res, { error: 'Config management not available' }, 501)
        return
      }
      ;(async () => {
        try {
          const varKey = decodeURIComponent(varDeleteMatch[1])
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 503)
            return
          }
          let content = ''
          try {
            content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              json(res, { error: `workspace.envFile not found: ${workspacePaths.envFile.workspaceRelativePath}` }, 500)
              return
            }
            throw err
          }
          const vars = parseEnvFile(content)
          const existed = varKey in vars
          delete vars[varKey]
          await writeFile(workspacePaths.envFile.absolutePath, serializeEnvFile(vars), 'utf-8')
          json(res, { deleted: existed })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to delete variable' }, 500)
        }
      })()
      return
    }

    // POST /api/live-editor/sessions/:id/auth-state — save auth state from active web Live Mode context
    const liveEditorAuthStateMatch = path.match(/^\/api\/live-editor\/sessions\/([^/]+)\/auth-state$/)
    if (liveEditorAuthStateMatch && req.method === 'POST') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
        return
      }
      ;(async () => {
        let stateName = ''
        let session: { captureWebAuthState?: (name: string, options: { replace: boolean }) => Promise<unknown>; getState?: () => unknown } | undefined
        try {
          const body = await readJsonBody<{ name?: unknown; replace?: unknown }>(req)
          const parsedName = AuthStateNameSchema.safeParse(typeof body?.name === 'string' ? body.name : '')
          if (!parsedName.success) {
            json(res, { error: 'Auth state name must be a lowercase slug.' }, 400)
            return
          }

          stateName = parsedName.data
          session = sessionManager.getSession(decodeURIComponent(liveEditorAuthStateMatch[1]))
          if (!session) {
            notFound(res, 'Session not found')
            return
          }

          if (typeof session.captureWebAuthState !== 'function') {
            json(res, {
              error: `Could not save auth state "${stateName}" for target "${getSessionTargetNameForAuthState(session)}".`,
            }, 500)
            return
          }

          const authState = await session.captureWebAuthState(stateName, { replace: body?.replace === true })
          json(res, { authState })
        } catch (err: unknown) {
          const targetName = getSessionTargetNameForAuthState(session)
          const response = buildAuthStateSaveErrorMessage(stateName || 'unknown', targetName, err)
          json(res, { error: response.message }, response.status)
        }
      })()
      return
    }

    // POST /api/live-editor/sessions — create a new live editor session
    if (path === '/api/live-editor/sessions' && req.method === 'POST') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
        return
      }
      ;(async () => {
        try {
          const body = await readJsonBody<{
            platform?: string
            targetName?: string
            url?: string
            headless?: boolean
            device?: Record<string, unknown>
            useDeviceName?: string
            appState?: string
            bundleId?: string
            appPackage?: string
            appActivity?: string
            setupHooks?: unknown
            teardownHooks?: unknown
            entity?: { type?: string; id?: string }
          }>(req)
          const platform = body?.platform ?? 'web'
          const runtimeLLM = await resolveDashboardRuntimeLLM(configManager, llmConfig, authFetch)
          if (!runtimeLLM.ok) {
            json(res, { error: runtimeLLM.error }, 400)
            return
          }
          const setupHooks = Array.isArray(body?.setupHooks)
            ? body.setupHooks.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : []
          const teardownHooks = Array.isArray(body?.teardownHooks)
            ? body.teardownHooks.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
            : []
          // Validate entity (ASVS V5). Only 'suite' | 'test' with a non-empty id
          // are honoured; malformed shapes are silently ignored — client may
          // send {} during the test-editor retrofit before entity threading
          // lands (downgrades to sessionNumber=null instead of a 400 error).
          let entityRef: { type: 'suite' | 'test'; id: string } | undefined
          if (body?.entity && typeof body.entity === 'object') {
            const t = body.entity.type
            const id = body.entity.id
            if ((t === 'suite' || t === 'test') && typeof id === 'string' && id.length > 0) {
              entityRef = { type: t, id }
            }
          }
          let agentRules: string | undefined
          let envVars: Record<string, string> | undefined
          let secretStore: SecretStore | undefined
          let secretRedactor: SecretRedactor | undefined
          let resolvedHooks = new Map<string, Record<string, unknown>>()
          let hookRegistryError: string | undefined
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 500)
            return
          }

          try {
            agentRules = await readFile(workspacePaths.agentRules.absolutePath, 'utf-8')
          } catch {
            json(res, { error: `workspace.agentRules file could not be loaded: ${workspacePaths.agentRules.workspaceRelativePath}` }, 400)
            return
          }

          try {
            const envContent = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
            envVars = parseEnvFile(envContent)
          } catch {
            json(res, { error: `workspace.envFile file could not be loaded: ${workspacePaths.envFile.workspaceRelativePath}` }, 400)
            return
          }

          try {
            const secretsContent = await readFile(workspacePaths.secretsFile.absolutePath, 'utf-8')
            secretStore = SecretStore.fromEnvContent(secretsContent)
            secretRedactor = new SecretRedactor(secretStore)
          } catch {
            json(res, { error: `workspace.secretsFile file could not be loaded: ${workspacePaths.secretsFile.workspaceRelativePath}` }, 400)
            return
          }

          const hookCatalog = await readWorkspaceHooks(configManager, deps.configPath)
          resolvedHooks = hookCatalog.resolvedHooks
          hookRegistryError = hookCatalog.hookRegistryError
          const { sessionId, sessionNumber } = await sessionManager.createSession(
            {
              platform: platform as 'web' | 'android' | 'ios',
              targetName: typeof body?.targetName === 'string' ? body.targetName : undefined,
              llmConfig: runtimeLLM.llmConfig,
              authFetch: runtimeLLM.authFetch,
              agentRules,
              envVars,
              secretStore,
              secretRedactor,
              setupHooks,
              teardownHooks,
              resolvedHooks,
              hookRegistryError,
              url: body?.url,
              headless: body?.headless ?? false,
              useDeviceName: typeof body?.useDeviceName === 'string' ? body.useDeviceName : undefined,
              appState: body?.appState === 'preserve' || body?.appState === 'reset' ? body.appState : undefined,
              bundleId: typeof body?.bundleId === 'string' ? body.bundleId : undefined,
              appPackage: typeof body?.appPackage === 'string' ? body.appPackage : undefined,
              appActivity: typeof body?.appActivity === 'string' ? body.appActivity : undefined,
              device: body?.device as import('../live-editor/types.js').LiveSessionConfig['device'],
            },
            entityRef,
          )
          json(res, { sessionId, sessionNumber }, 201)
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          json(res, { error: message }, 500)
        }
      })()
      return
    }

    // GET /api/live-editor/sessions — list all active live editor sessions
    if (path === '/api/live-editor/sessions' && req.method === 'GET') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
        return
      }
      json(res, { sessions: sessionManager.listSessions() })
      return
    }

    // DELETE /api/live-editor/sessions/:id — terminate a live editor session
    const liveEditorSessionMatch = path.match(/^\/api\/live-editor\/sessions\/([^/]+)$/)
    if (liveEditorSessionMatch && req.method === 'DELETE') {
      if (!sessionManager) {
        json(res, { error: 'Live editor not available' }, 503)
        return
      }
      const sessionId = liveEditorSessionMatch[1]
      ;(async () => {
        const terminated = await sessionManager.terminateSession(sessionId)
        if (terminated) {
          json(res, { ok: true })
        } else {
          notFound(res, 'Session not found')
        }
      })()
      return
    }

    // Variable suggestions: env keys
    if (path === '/api/variables/env' && req.method === 'GET') {
      if (!configManager) {
        json(res, { keys: [] })
        return
      }
      ;(async () => {
        try {
          if (!workspacePaths) {
            json(res, { error: 'Workspace path resolution not available' }, 503)
            return
          }
          const content = await readFile(workspacePaths.envFile.absolutePath, 'utf-8')
          const parsed = parseEnvFile(content)
          json(res, { keys: Object.keys(parsed) })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read env variables' }, 500)
        }
      })()
      return
    }

    // Variable suggestions: hook names
    if (path === '/api/variables/hooks' && req.method === 'GET') {
      ;(async () => {
        try {
          const { hooks } = await readWorkspaceHooks(configManager, deps.configPath)
          json(res, { names: hooks.map((hook) => hook.name) })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read hooks' }, 500)
        }
      })()
      return
    }

    // Variable suggestions: captured variable names from prior runs
    const capturedMatch = path.match(/^\/api\/variables\/captured\/([^/]+)$/)
    if (capturedMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const testId = decodeURIComponent(capturedMatch[1])
          const names = db.getCapturedVariableNames(testId)
          json(res, { names })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read captured variables' }, 500)
        }
      })()
      return
    }

    if (path === '/api/memory/catalog' && req.method === 'GET') {
      ;(async () => {
        try {
          json(res, await memoryCatalogManager.readCatalog())
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read memory catalog' }, 500)
        }
      })()
      return
    }

    const memoryProductMatch = path.match(/^\/api\/memory\/products\/([^/]+)$/)
    if (memoryProductMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const productKey = decodeURIComponent(memoryProductMatch[1])
          if (!isValidMemoryScopeId(productKey)) {
            json(res, { error: 'Invalid memory product id' }, 400)
            return
          }
          const product = await memoryCatalogManager.readProductDetail(productKey)
          if (!product) {
            json(res, { error: 'Memory product not found' }, 404)
            return
          }
          json(res, { product })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read memory product' }, 500)
        }
      })()
      return
    }

    const memoryScopeMatch = path.match(/^\/api\/memory\/scopes\/([^/]+)\/([^/]+)$/)
    if (memoryScopeMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const scope = decodeURIComponent(memoryScopeMatch[1])
          const scopeId = decodeURIComponent(memoryScopeMatch[2])
          if (!isMemoryScope(scope)) {
            json(res, { error: 'Invalid memory scope' }, 400)
            return
          }
          if (!isValidMemoryScopeId(scopeId)) {
            json(res, { error: 'Invalid memory scope id' }, 400)
            return
          }
          const payload = await memoryCatalogManager.readScopedObservations(scope, scopeId)
          if (!payload) {
            json(res, { error: 'Memory scope not found' }, 404)
            return
          }
          json(res, payload)
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read memory scope' }, 500)
        }
      })()
      return
    }

    // Memory observations: list for a test
    const obsListMatch = path.match(/^\/api\/memory\/observations\/([^/]+)$/)
    if (obsListMatch && req.method === 'GET') {
      ;(async () => {
        try {
          const testId = decodeURIComponent(obsListMatch[1])
          const payload = await memoryCatalogManager.readScopedObservations('test', testId)
          json(res, {
            observations: payload?.observations ?? [],
            invalidFiles: payload?.invalidFiles ?? [],
          })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to read observations' }, 500)
        }
      })()
      return
    }

    // Memory observations: delete
    const obsDeleteMatch = path.match(/^\/api\/memory\/observations\/([^/]+)\/([^/]+)$/)
    if (obsDeleteMatch && req.method === 'DELETE') {
      ;(async () => {
        try {
          const testId = decodeURIComponent(obsDeleteMatch[1])
          const obsId = decodeURIComponent(obsDeleteMatch[2])
          if (!isValidMemoryScopeId(testId) || !isValidMemoryScopeId(obsId)) {
            json(res, { error: 'Invalid memory observation id' }, 400)
            return
          }

          const configDir = deps.configPath ? dirname(resolve(deps.configPath)) : process.cwd()
          const cfg = configManager ? await configManager.read().catch(() => undefined) : undefined
          const parsedConfig = AgentQaConfigSchema.safeParse(cfg ?? {})
          const memoryRoot = parsedConfig.success
            ? resolveMemoryRoot(parsedConfig.data, configDir)
            : resolveMemoryRoot(undefined, configDir)
          const testsRoot = join(memoryRoot, 'tests')
          const resolved = resolve(testsRoot, testId, `${obsId}.md`)
          if (!getPathInsideDir(resolved, testsRoot)) {
            json(res, { error: 'Invalid path' }, 400)
            return
          }

          await rm(resolved, { force: true })
          json(res, { deleted: true })
        } catch (err: unknown) {
          json(res, { error: err instanceof Error ? err.message : 'Failed to delete observation' }, 500)
        }
      })()
      return
    }

    // Unknown API route
    if (path.startsWith('/api/')) {
      notFound(res)
      return
    }

    // Non-API routes handled by server.ts (static files)
    notFound(res)
  }
}

function isMemoryScope(value: string): value is MemoryScope {
  return value === 'product' || value === 'suite' || value === 'test'
}

function generateDocxReport(testName: string, runs: RunRow[], steps: StepRow[]): Promise<Buffer> {
  const totalRuns = runs.length
  const passedRuns = runs.filter(r => r.status === 'passed')
  const failedRuns = runs.filter(r => r.status === 'failed')
  const flakyRuns = runs.filter(r => r.status === 'flaky')
  
  const passRate = totalRuns > 0 ? (passedRuns.length / totalRuns) * 100 : 0
  const flakeRate = totalRuns > 0 ? (flakyRuns.length / totalRuns) * 100 : 0
  const avgDuration = totalRuns > 0 ? runs.reduce((acc, r) => acc + r.duration, 0) / totalRuns : 0
  
  let totalPromptTokens = 0
  let totalCompletionTokens = 0
  for (const step of steps) {
    totalPromptTokens += step.promptTokens || 0
    totalCompletionTokens += step.completionTokens || 0
  }
  const totalTokens = totalPromptTokens + totalCompletionTokens
  const estimatedCost = (totalPromptTokens / 1_000_000) * 2.50 + (totalCompletionTokens / 1_000_000) * 10.00

  const stepMap = new Map<string, {
    name: string
    executions: number
    passed: number
    failed: number
    healed: number
    totalDuration: number
    promptTokens: number
    completionTokens: number
    errors: string[]
  }>()

  for (const step of steps) {
    const key = step.originalStepName || step.name || 'Unnamed Step'
    let stats = stepMap.get(key)
    if (!stats) {
      stats = {
        name: key, executions: 0, passed: 0, failed: 0, healed: 0,
        totalDuration: 0, promptTokens: 0, completionTokens: 0, errors: []
      }
      stepMap.set(key, stats)
    }
    stats.executions++
    stats.totalDuration += step.duration
    stats.promptTokens += step.promptTokens || 0
    stats.completionTokens += step.completionTokens || 0
    
    if (step.status === 'passed' || step.status === 'completed') {
      stats.passed++
    } else if (step.status === 'failed') {
      stats.failed++
      if (step.error) stats.errors.push(step.error)
    } else if (step.status === 'healed') {
      stats.healed++
      stats.passed++
    }
  }

  const stepAnalysis = Array.from(stepMap.values()).map(s => {
    const successRate = s.executions > 0 ? ((s.passed + s.healed) / s.executions) * 100 : 0
    const healRate = s.executions > 0 ? (s.healed / s.executions) * 100 : 0
    const avgDuration = s.executions > 0 ? s.totalDuration / s.executions : 0
    const avgTokens = s.executions > 0 ? (s.promptTokens + s.completionTokens) / s.executions : 0
    
    const errCounts: Record<string, number> = {}
    let mostCommonError = ''
    let maxCount = 0
    for (const err of s.errors) {
      errCounts[err] = (errCounts[err] || 0) + 1
      if (errCounts[err] > maxCount) {
        maxCount = errCounts[err]
        mostCommonError = err
      }
    }
    return { name: s.name, executions: s.executions, successRate, healRate, avgDuration, avgTokens, mostCommonError }
  })

  const errorMap = new Map<string, number>()
  for (const step of steps) {
    if (step.error) {
      errorMap.set(step.error, (errorMap.get(step.error) || 0) + 1)
    }
  }
  const topErrors = Array.from(errorMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  const healedSteps = steps.filter(step => step.status === 'healed' || (step.healingAttempts && Array.isArray(step.healingAttempts) && step.healingAttempts.length > 0))
  const healingLogs = healedSteps.map(step => {
    const run = runs.find(r => r.id === step.runId)
    let attemptsParsed: any[] = []
    if (step.healingAttempts) {
      if (typeof step.healingAttempts === 'string') {
        try { attemptsParsed = JSON.parse(step.healingAttempts) } catch {}
      } else if (Array.isArray(step.healingAttempts)) {
        attemptsParsed = step.healingAttempts
      }
    }
    return {
      runId: step.runId,
      date: run ? run.createdAt : step.createdAt,
      stepName: step.name,
      error: step.error || 'Unknown execution error',
      attempts: attemptsParsed
    }
  })

  const formatDurationMs = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const children: docx.FileChild[] = [
    new docx.Paragraph({
      children: [
        new docx.TextRun({
          text: "Agent QA - Execution Analysis Report",
          bold: true,
          size: 32,
        })
      ],
      spacing: { after: 200 }
    }),
    new docx.Paragraph({
      children: [
        new docx.TextRun({ text: "Test Name: ", bold: true }),
        new docx.TextRun({ text: testName }),
      ],
      spacing: { after: 100 }
    }),
    new docx.Paragraph({
      children: [
        new docx.TextRun({ text: "Generated: ", bold: true }),
        new docx.TextRun({ text: new Date().toLocaleString() }),
      ],
      spacing: { after: 300 }
    }),
  ]

  // --- Test Scenario Overview ---
  const stepNames = Array.from(stepMap.keys())
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: 'Test Scenario Overview', bold: true, size: 28 })],
    spacing: { before: 100, after: 120 }
  }))
  if (stepNames.length > 0) {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({
        text: `This test validates the target application through ${stepNames.length} distinct verification step${stepNames.length !== 1 ? 's' : ''}. ` +
          `The workflow proceeds sequentially: ${stepNames.map((name, idx) => `(${idx + 1}) ${name}`).join('; ')}. ` +
          `A total of ${totalRuns} execution${totalRuns !== 1 ? 's have' : ' has'} been recorded, ` +
          `producing ${steps.length} individual step observation${steps.length !== 1 ? 's' : ''} available for analysis.`,
        size: 20,
      })],
      spacing: { after: 200 }
    }))
  } else {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: 'No step executions have been recorded for this test yet. Execute the test to begin collecting data.', size: 20 })],
      spacing: { after: 200 }
    }))
  }

  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: 'Summary Metrics', bold: true, size: 24 })],
    spacing: { before: 200, after: 150 }
  }))

  const summaryHeaders = ["Metric", "Value", "Details"]
  const summaryRowsData = [
    ["Success Rate", `${passRate.toFixed(1)}%`, `${passedRuns.length} passed / ${totalRuns} total`],
    ["Flake Rate", `${flakeRate.toFixed(1)}%`, `${flakyRuns.length} flaky runs`],
    ["Avg Duration", formatDurationMs(avgDuration), "Across all runs"],
    ["LLM Tokens / Cost", `$${estimatedCost.toFixed(4)}`, `${totalTokens.toLocaleString()} total tokens`]
  ]

  const summaryTable = new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    rows: [
      new docx.TableRow({
        children: summaryHeaders.map(text => new docx.TableCell({
          children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true })] })]
        }))
      }),
      ...summaryRowsData.map(row => new docx.TableRow({
        children: row.map(text => new docx.TableCell({
          children: [new docx.Paragraph({ text })]
        }))
      }))
    ]
  })
  children.push(summaryTable)

  // --- Executive Summary ---
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: 'Executive Summary', bold: true, size: 28 })],
    spacing: { before: 300, after: 120 }
  }))
  const healthRating = passRate >= 95 ? 'excellent' : passRate >= 85 ? 'good' : passRate >= 70 ? 'moderate' : 'poor'
  const flakeAssessment = flakeRate === 0 ? 'no flakiness detected' : flakeRate < 5 ? 'minimal flakiness' : flakeRate < 15 ? 'moderate flakiness that warrants investigation' : 'significant flakiness requiring immediate attention'
  const costAssessment = estimatedCost < 0.01 ? 'negligible' : estimatedCost < 0.10 ? 'low' : estimatedCost < 1.0 ? 'moderate' : 'high'
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({
      text: `The test "${testName}" demonstrates ${healthRating} reliability with a ${passRate.toFixed(1)}% success rate across ${totalRuns} execution${totalRuns !== 1 ? 's' : ''}. ` +
        `${failedRuns.length > 0 ? `${failedRuns.length} run${failedRuns.length !== 1 ? 's' : ''} ended in failure. ` : 'No outright failures have been recorded. '}` +
        `The analysis shows ${flakeAssessment}, with an average execution time of ${formatDurationMs(avgDuration)}. ` +
        `LLM resource consumption is ${costAssessment} at an estimated $${estimatedCost.toFixed(4)} across ${totalTokens.toLocaleString()} tokens.`,
      size: 20,
    })],
    spacing: { after: 200 }
  }))

  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: "Step-by-Step Reliability Analysis", bold: true, size: 24 })],
    spacing: { before: 300, after: 150 }
  }))

  const stepHeaders = ["Step Name", "Execs", "Success Rate", "Heal Rate", "Avg Duration", "Avg Tokens", "Common Failure"]
  const stepTable = new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    rows: [
      new docx.TableRow({
        children: stepHeaders.map(text => new docx.TableCell({
          children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true })] })]
        }))
      }),
      ...stepAnalysis.map(step => new docx.TableRow({
        children: [
          step.name,
          String(step.executions),
          `${step.successRate.toFixed(1)}%`,
          step.healRate > 0 ? `${step.healRate.toFixed(1)}%` : "-",
          formatDurationMs(step.avgDuration),
          String(Math.round(step.avgTokens)),
          step.mostCommonError || "-"
        ].map(text => new docx.TableCell({
          children: [new docx.Paragraph({ text })]
        }))
      }))
    ]
  })
  children.push(stepTable)

  // --- Step Reliability Assessment ---
  if (stepAnalysis.length > 0) {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: 'Step Reliability Assessment', bold: true, size: 28 })],
      spacing: { before: 200, after: 120 }
    }))
    const weakSteps = stepAnalysis.filter(s => s.successRate < 90).sort((a, b) => a.successRate - b.successRate)
    const strongSteps = stepAnalysis.filter(s => s.successRate >= 99)
    const healedStepNames = stepAnalysis.filter(s => s.healRate > 0)
    const slowestStep = stepAnalysis.reduce((prev, curr) => curr.avgDuration > prev.avgDuration ? curr : prev, stepAnalysis[0])
    let reliabilityText = weakSteps.length === 0
      ? `All ${stepAnalysis.length} steps demonstrate strong reliability with success rates above 90%. `
      : `${weakSteps.length} of ${stepAnalysis.length} steps show sub-90% success rates. The least reliable is "${weakSteps[0].name}" at ${weakSteps[0].successRate.toFixed(1)}%, which should be prioritized for investigation. `
    if (strongSteps.length > 0) reliabilityText += `${strongSteps.length} step${strongSteps.length !== 1 ? 's' : ''} achieve near-perfect reliability (>=99%). `
    if (healedStepNames.length > 0) reliabilityText += `AI self-healing was triggered on ${healedStepNames.length} step${healedStepNames.length !== 1 ? 's' : ''}, indicating selector or DOM volatility. `
    reliabilityText += `The slowest step is "${slowestStep.name}" averaging ${formatDurationMs(slowestStep.avgDuration)}, which may indicate complex page interactions or slow backend responses.`
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: reliabilityText, size: 20 })],
      spacing: { after: 200 }
    }))
  }

  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: "Top Failure Errors", bold: true, size: 24 })],
    spacing: { before: 300, after: 150 }
  }))

  if (topErrors.length > 0) {
    for (const [err, count] of topErrors) {
      children.push(new docx.Paragraph({
        children: [
          new docx.TextRun({ text: `• [${count}x] `, bold: true }),
          new docx.TextRun({ text: err, font: "Courier New" })
        ],
        spacing: { after: 50 }
      }))
    }
  } else {
    children.push(new docx.Paragraph({ text: "No execution errors captured.", spacing: { after: 100 } }))
  }

  // --- Failure Pattern Analysis ---
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: 'Failure Pattern Analysis', bold: true, size: 28 })],
    spacing: { before: 200, after: 120 }
  }))
  if (topErrors.length > 0) {
    const totalErrorOccurrences = topErrors.reduce((sum, [, c]) => sum + c, 0)
    const topErrorPct = ((topErrors[0][1] / totalErrorOccurrences) * 100).toFixed(0)
    const hasConnectivity = topErrors.some(([e]) => /connect|timeout|network|ECONNREFUSED|certificate/i.test(e))
    const hasSelectorIssues = topErrors.some(([e]) => /selector|element|not found|visible|locator/i.test(e))
    const hasAssertion = topErrors.some(([e]) => /assert|expect|match|verify|heading|text/i.test(e))
    let failureText = `${topErrors.length} distinct error pattern${topErrors.length !== 1 ? 's were' : ' was'} identified across ${totalErrorOccurrences} total occurrences. The most frequent error accounts for ${topErrorPct}% of all failures. `
    if (hasConnectivity) failureText += 'Network or connectivity errors are present, suggesting infrastructure instability or certificate/proxy issues. '
    if (hasSelectorIssues) failureText += 'Element selector failures indicate DOM structure changes — consider more resilient selectors or enabling healing. '
    if (hasAssertion) failureText += 'Assertion failures point to functional regressions or content changes in the application. '
    children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: failureText, size: 20 })], spacing: { after: 200 } }))
  } else {
    children.push(new docx.Paragraph({ children: [new docx.TextRun({ text: 'No failure patterns have been recorded. The test has executed without encountering errors.', size: 20 })], spacing: { after: 200 } }))
  }

  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: "Auto-Healing & AI Adjustments Log", bold: true, size: 24 })],
    spacing: { before: 300, after: 150 }
  }))

  if (healingLogs.length > 0) {
    for (const log of healingLogs) {
      children.push(new docx.Paragraph({
        children: [
          new docx.TextRun({ text: `${log.stepName} (Run ID: ${log.runId.slice(0, 8)})`, bold: true }),
        ],
        spacing: { before: 100, after: 50 }
      }))
      children.push(new docx.Paragraph({
        children: [
          new docx.TextRun({ text: `Error: `, bold: true }),
          new docx.TextRun({ text: log.error, font: "Courier New" })
        ],
        spacing: { after: 50 }
      }))
      log.attempts.forEach((att: any, attIdx: number) => {
        children.push(new docx.Paragraph({
          children: [
            new docx.TextRun({ text: `  - Attempt #${att.attemptNumber || (attIdx + 1)} ${att.success ? "(Success)" : "(Failed)"}: `, bold: true, color: att.success ? "10b981" : "ef4444" }),
            new docx.TextRun({ text: att.reasoning || "" })
          ],
          spacing: { after: 50 }
        }))
      })
    }
  } else {
    children.push(new docx.Paragraph({ text: "No auto-healing events occurred.", spacing: { after: 100 } }))
  }

  // --- AI Healing Effectiveness ---
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: 'AI Healing Effectiveness', bold: true, size: 28 })],
    spacing: { before: 200, after: 120 }
  }))
  if (healingLogs.length > 0) {
    const successfulHeals = healingLogs.filter(l => l.attempts.some((a: any) => a.success))
    const healSuccessRate = ((successfulHeals.length / healingLogs.length) * 100).toFixed(0)
    const uniqueHealedStepCount = new Set(healingLogs.map(l => l.stepName)).size
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({
        text: `The AI healing system intervened ${healingLogs.length} time${healingLogs.length !== 1 ? 's' : ''} across ${uniqueHealedStepCount} distinct step${uniqueHealedStepCount !== 1 ? 's' : ''}, achieving a ${healSuccessRate}% recovery rate. ` +
          `${successfulHeals.length > 0 ? 'Self-healing successfully recovered execution where selectors or page structure had changed, preventing false negatives. ' : 'Recovery attempts were made but did not fully resolve the underlying issues. '}` +
          'Frequent healing on the same steps may indicate unstable selectors that should be refactored for long-term maintainability.',
        size: 20,
      })],
      spacing: { after: 200 }
    }))
  } else {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: 'No AI healing interventions were required, indicating stable element selectors and consistent application behavior.', size: 20 })],
      spacing: { after: 200 }
    }))
  }

  // --- Recommendations ---
  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: 'Recommendations', bold: true, size: 28 })],
    spacing: { before: 300, after: 120 }
  }))
  const recs: string[] = []
  if (passRate < 80) recs.push('Critical: Success rate is below 80%. Investigate top failure errors and check for application regressions.')
  if (flakeRate > 10) recs.push('Flake rate exceeds 10%. Review steps with high heal rates for selector stability and consider adding explicit waits.')
  const recWeakSteps = stepAnalysis.filter(s => s.successRate < 90).sort((a, b) => a.successRate - b.successRate)
  if (recWeakSteps.length > 0) recs.push(`Focus reliability improvements on: ${recWeakSteps.slice(0, 3).map(s => `"${s.name}" (${s.successRate.toFixed(0)}%)`).join(', ')}.`)
  if (estimatedCost > 0.50) recs.push('LLM token usage is elevated. Consider simplifying step instructions to reduce planning overhead.')
  if (avgDuration > 60000) recs.push('Average execution exceeds 60s. Consider parallelizing independent steps or optimizing slow interactions.')
  if (recs.length === 0) recs.push('The test is performing well. Continue monitoring for regressions and consider expanding coverage to adjacent workflows.')
  for (const rec of recs) {
    children.push(new docx.Paragraph({
      children: [new docx.TextRun({ text: '\u2022 ', bold: true }), new docx.TextRun({ text: rec, size: 20 })],
      spacing: { after: 80 }
    }))
  }

  children.push(new docx.Paragraph({
    children: [new docx.TextRun({ text: "Execution History (Last 50 Runs)", bold: true, size: 24 })],
    spacing: { before: 300, after: 150 }
  }))

  const historyHeaders = ["Run ID", "Status", "Duration", "Model", "Timestamp", "Failure Summary"]
  const historyTable = new docx.Table({
    width: { size: 100, type: docx.WidthType.PERCENTAGE },
    rows: [
      new docx.TableRow({
        children: historyHeaders.map(text => new docx.TableCell({
          children: [new docx.Paragraph({ children: [new docx.TextRun({ text, bold: true })] })]
        }))
      }),
      ...runs.slice(0, 50).map(run => new docx.TableRow({
        children: [
          run.id.slice(0, 8),
          run.status.toUpperCase(),
          formatDurationMs(run.duration),
          run.modelName || "default",
          new Date(run.createdAt).toLocaleString(),
          run.failureSummary || "-"
        ].map(text => new docx.TableCell({
          children: [new docx.Paragraph({ text })]
        }))
      }))
    ]
  })
  children.push(historyTable)

  const doc = new docx.Document({
    sections: [{
      properties: {},
      children
    }]
  })

  return docx.Packer.toBuffer(doc)
}
