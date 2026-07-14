import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  loadConfigFile: vi.fn().mockResolvedValue(null),
}))

vi.mock('picocolors', () => ({
  default: {
    green: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    blue: (s: string) => s,
  },
}))

describe('doctor command creation', () => {
  it('creates the doctor command', async () => {
    const { createDoctorCommand } = await import('../doctor.js')
    const cmd = createDoctorCommand()
    expect(cmd.name()).toBe('doctor')
    expect(cmd.description()).toBe('Validate environment and dependencies')
  })
})
