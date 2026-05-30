import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, ConnectionStatus } from '../src/core/connection/manager.js'

type FakeResponse = {
  statusCode: number
  body: string
  setHeader: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

const getConnectionMock = vi.fn()
const getActiveSocketMock = vi.fn()

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

vi.mock('../src/core/connection/manager.js', () => ({
  getConnection: (...args: unknown[]) => getConnectionMock(...args),
  getActiveSocket: (...args: unknown[]) => getActiveSocketMock(...args),
}))

const makeInfo = (overrides: Partial<ConnectionInfo> = {}): ConnectionInfo => ({
  connectionId: 'test-id',
  label: null,
  status: 'open' as ConnectionStatus,
  socketGeneration: 1,
  lastReconnectAt: 0,
  reconnectInFlight: false,
  socketActive: true,
  qrCode: null,
  qrCodeAt: null,
  ...overrides,
})

const createResponse = (): FakeResponse => {
  const res: FakeResponse = {
    statusCode: 200,
    body: '',
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      res.body = body ?? ''
    }),
  }
  return res
}

const makeReq = (method: string, url: string) => ({
  method,
  url,
  headers: {},
  on: vi.fn(),
})

describe('handleGroupsRoutes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getConnectionMock.mockReturnValue(null)
    getActiveSocketMock.mockReturnValue(null)
  })

  it('retorna false para rotas não reconhecidas', async () => {
    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const handled = await handleGroupsRoutes(makeReq('GET', '/other') as never, res as never, '/other', logger as never)
    expect(handled).toBe(false)
  })

  it('retorna 404 para conexão inexistente', async () => {
    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    await handleGroupsRoutes(makeReq('GET', '/connections/nao-existe/groups') as never, res as never, '/connections/nao-existe/groups', logger as never)
    expect(res.statusCode).toBe(404)
  })

  it('retorna 409 quando instância não está open', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ status: 'created' }))
    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    await handleGroupsRoutes(makeReq('GET', '/connections/sess/groups') as never, res as never, '/connections/sess/groups', logger as never)
    expect(res.statusCode).toBe(409)
  })

  it('retorna grupos do Baileys no formato original', async () => {
    const groups = {
      'group1@g.us': { id: 'group1@g.us', subject: 'Grupo 1', participants: [] },
      'group2@g.us': { id: 'group2@g.us', subject: 'Grupo 2', participants: [] },
    }
    const sock = { groupFetchAllParticipating: vi.fn(async () => groups) }
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-groups' }))
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    await handleGroupsRoutes(makeReq('GET', '/connections/sess-groups/groups') as never, res as never, '/connections/sess-groups/groups', logger as never)

    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body) as typeof groups
    expect(Object.keys(data)).toEqual(['group1@g.us', 'group2@g.us'])
    expect(data['group1@g.us']?.subject).toBe('Grupo 1')
  })

  it('retorna 500 quando groupFetchAllParticipating lança erro', async () => {
    const sock = { groupFetchAllParticipating: vi.fn().mockRejectedValue(new Error('timeout')) }
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    await handleGroupsRoutes(makeReq('GET', '/connections/sess/groups') as never, res as never, '/connections/sess/groups', logger as never)

    expect(res.statusCode).toBe(500)
    expect(logger.error).toHaveBeenCalled()
  })
})
