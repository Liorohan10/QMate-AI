import { shouldRouteRunToLive } from '@/lib/status'

export const routes = {
  runs: '/runs',
  tests: '/tests',
  testNew: '/tests/new',
  memory: '/memory',
  insights: '/insights',
  config: '/config',

  runDetail: (id: string) => `/runs/${id}`,
  runLive: (id: string) => `/runs/${id}/live`,
  runDetailOrLive: (id: string, status: string) =>
    shouldRouteRunToLive(status) ? `/runs/${id}/live` : `/runs/${id}`,
  testView: (testId: string) => `/test/${testId}`,
  testEdit: (testId: string) => `/test/${testId}/edit`,
  testEditLive: (testId: string) => `/test/${testId}/edit?live=1`,
  memoryProduct: (product: string) => `/memory/${product}`,
  configItem: (bucket: string, item: string) => `/config?bucket=${bucket}&item=${item}`,
} as const
