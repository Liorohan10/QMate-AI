import { z } from 'zod'

export const WorkspaceSchema = z.object({
  testMatch: z.array(z.string().min(1)).min(1),
  testPathIgnore: z.array(z.string()).optional(),
  agentRules: z.string().min(1, 'agentRules is required.'),
  envFile: z.string().min(1, 'envFile is required.'),
  secretsFile: z.string().min(1, 'secretsFile is required.'),
}).strict()
