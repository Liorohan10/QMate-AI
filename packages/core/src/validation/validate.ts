import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { glob } from 'glob'
import { AgentQaConfigSchema } from '../schema/config-schema.js'
import { parseTestFile } from '../parser/yaml-parser.js'
import {
  discoverWorkspaceFiles,
  resolveWorkspaceFileTarget,
  type ResolvedWorkspacePaths,
  type WorkspaceFileKind,
} from '../workspace/workspace-paths.js'

export interface ValidationDiagnostic {
  file: string
  line: number
  column: number
  message: string
  severity: 'error' | 'warning'
}

export interface ValidationResult {
  diagnostics: ValidationDiagnostic[]
  fileCount: number
  errorCount: number
  warningCount: number
}

export const VALID_FILENAME_RE = /^[a-zA-Z0-9._-]+\.(yaml|yml)$/

export async function validateConfig(configPath: string): Promise<ValidationDiagnostic[]> {
  const diagnostics: ValidationDiagnostic[] = []

  let content: string
  try {
    content = await readFile(configPath, 'utf-8')
  } catch (err) {
    diagnostics.push({
      file: configPath,
      line: 1,
      column: 1,
      message: `Cannot read config file: ${(err as Error).message}`,
      severity: 'error',
    })
    return diagnostics
  }

  let parsed: unknown
  try {
    parsed = parseYaml(content)
  } catch (err) {
    diagnostics.push({
      file: configPath,
      line: 1,
      column: 1,
      message: `YAML syntax error: ${(err as Error).message}`,
      severity: 'error',
    })
    return diagnostics
  }

  const result = AgentQaConfigSchema.safeParse(parsed)
  if (!result.success) {
    for (const issue of result.error.issues) {
      diagnostics.push({
        file: configPath,
        line: 1,
        column: 1,
        message: `${issue.path.join('.')}: ${issue.message}`,
        severity: 'error',
      })
    }
  }

  return diagnostics
}

function buildDiagnostic(file: string, message: string, severity: 'error' | 'warning' = 'error'): ValidationDiagnostic {
  return {
    file,
    line: 1,
    column: 1,
    message,
    severity,
  }
}

export function validateTestFile(filePath: string, content: string): ValidationDiagnostic[] {
  const result = parseTestFile(content, filePath)
  return result.errors.map((e) => ({
    file: e.file,
    line: e.line,
    column: e.column,
    message: e.message,
    severity: e.severity,
  }))
}

export function validateFilename(filePath: string): ValidationDiagnostic[] {
  const basename = path.basename(filePath)
  if (!VALID_FILENAME_RE.test(basename)) {
    return [{
      file: filePath,
      line: 1,
      column: 1,
      message: `Invalid filename "${basename}" — expected pattern: [a-zA-Z0-9._-]+.(yaml|yml)`,
      severity: 'warning',
    }]
  }
  return []
}

export async function validateFiles(
  filePaths: string[],
  configPath?: string,
  options: { basedir?: string } = {},
): Promise<ValidationResult> {
  const diagnostics: ValidationDiagnostic[] = []

  if (configPath) {
    diagnostics.push(...await validateConfig(configPath))
  }

  for (const filePath of filePaths) {
    diagnostics.push(...validateFilename(filePath))

    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      diagnostics.push({
        file: filePath,
        line: 1,
        column: 1,
        message: `Cannot read file: ${(err as Error).message}`,
        severity: 'error',
      })
      continue
    }

    diagnostics.push(...validateTestFile(filePath, content))
  }

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length

  return {
    diagnostics,
    fileCount: filePaths.length,
    errorCount,
    warningCount,
  }
}

async function resolveExplicitWorkspaceFile(
  workspace: ResolvedWorkspacePaths,
  filePath: string,
): Promise<{ record?: { absolutePath: string }; diagnostic?: ValidationDiagnostic }> {
  try {
    const record = await resolveWorkspaceFileTarget({
      workspace,
      kind: 'test',
      filePath,
      requireExisting: true,
    })
    return { record }
  } catch {
    // Try other checks if needed, but only test kind remains.
  }

  return {
    diagnostic: buildDiagnostic(
      filePath,
      `File is not matched by configured workspace testMatch patterns: ${filePath}`,
    ),
  }
}

function appendDiagnostics(result: ValidationResult, diagnostics: ValidationDiagnostic[]): void {
  for (const diagnostic of diagnostics) {
    result.diagnostics.push(diagnostic)
    if (diagnostic.severity === 'error') result.errorCount++
    else result.warningCount++
  }
}

function validateRequiredWorkspaceFiles(workspace: ResolvedWorkspacePaths): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = []
  for (const [key, file] of [
    ['workspace.agentRules', workspace.agentRules],
    ['workspace.envFile', workspace.envFile],
    ['workspace.secretsFile', workspace.secretsFile],
  ] as const) {
    if (!file || !existsSync(file.absolutePath)) {
      diagnostics.push(buildDiagnostic(file?.absolutePath || '', `Configured workspace file not found: ${key}`))
    }
  }
  return diagnostics
}

export async function validateProject(options: {
  configPath?: string
  files?: string[]
  testMatch?: string[]
  testPathIgnore?: string[]
  workspace?: ResolvedWorkspacePaths
} = {}): Promise<ValidationResult> {
  let filePaths: string[]
  const preDiagnostics: ValidationDiagnostic[] = []

  if (options.files && options.files.length > 0 && options.workspace) {
    const resolvedFiles: string[] = []
    for (const file of options.files) {
      const { record, diagnostic } = await resolveExplicitWorkspaceFile(options.workspace, file)
      if (record) resolvedFiles.push(record.absolutePath)
      if (diagnostic) preDiagnostics.push(diagnostic)
    }
    filePaths = resolvedFiles
  } else if (options.files && options.files.length > 0) {
    filePaths = options.files.map((f) => path.resolve(f))
  } else if (options.workspace) {
    const testFiles = await discoverWorkspaceFiles({ workspace: options.workspace, kind: 'test' })
    filePaths = testFiles.map(file => file.absolutePath)
  } else {
    const testPatterns = options.testMatch ?? []
    const ignore = options.testPathIgnore ?? []
    filePaths = testPatterns.length > 0
      ? await glob(testPatterns, { ignore, absolute: true })
      : []
  }

  const configPath = options.configPath ?? options.workspace?.configPath

  const result = await validateFiles(filePaths, configPath, {
    basedir: options.workspace?.configDir,
  })
  appendDiagnostics(result, preDiagnostics)

  appendDiagnostics(result, options.workspace ? validateRequiredWorkspaceFiles(options.workspace) : [])

  return result
}
