import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, ConnectionStatus } from '../src/core/connection/manager.js'

type FakeResponse = {
  statusCode: number
  headers: Record<string, string>
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
    headers: {},
    body: '',
    setHeader: vi.fn((key: string, value: string) => {
      res.headers[key] = value
    }),
    end: vi.fn((body?: string) => {
      res.body = body ?? ''
    }),
  }
  return res
}

const makeReq = (method: string, url: string, body = '') => ({
  method,
  url,
  headers: {},
  on: vi.fn((event: string, cb: (chunk?: unknown) => void) => {
    if (event === 'data' && body) cb(Buffer.from(body))
    if (event === 'end') cb()
  }),
})

const makeSock = () => ({
  groupFetchAllParticipating: vi.fn(async () => ({})),
  groupParticipantsUpdate: vi.fn(async () => [{ status: '200' }]),
  groupSettingUpdate: vi.fn(async () => undefined),
  groupUpdateSubject: vi.fn(async () => undefined),
  groupUpdateDescription: vi.fn(async () => undefined),
  groupToggleEphemeral: vi.fn(async () => undefined),
  groupInviteCode: vi.fn(async () => 'INVITE123'),
  groupRevokeInvite: vi.fn(async () => 'NEWCODE123'),
  groupMemberAddMode: vi.fn(async () => undefined),
  groupJoinApprovalMode: vi.fn(async () => undefined),
  groupRequestParticipantsList: vi.fn(async () => [{ jid: '5511999999999@s.whatsapp.net', request_method: 'NonAdminAdd' }]),
  groupRequestParticipantsUpdate: vi.fn(async () => [{ jid: '5511999999999@s.whatsapp.net', status: '200' }]),
})

const encodedGroupJid = '120363000000000001%40g.us'
const decodedGroupJid = '120363000000000001@g.us'
const makeAdminPath = (connectionId = 'sess', groupJid = encodedGroupJid): string => `/connections/${connectionId}/groups/${groupJid}/admin`

const callAdminRoute = async (
  body: string,
  options: {
    connectionId?: string
    groupPath?: string
    info?: ConnectionInfo | null
    sock?: ReturnType<typeof makeSock> | null
  } = {},
) => {
  const connectionId = options.connectionId ?? 'sess'
  const path = makeAdminPath(connectionId, options.groupPath)
  getConnectionMock.mockReturnValue(options.info ?? makeInfo({ connectionId }))
  getActiveSocketMock.mockReturnValue(options.sock === undefined ? makeSock() : options.sock)

  const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
  const res = createResponse()
  await handleGroupsRoutes(makeReq('POST', path, body) as never, res as never, path, logger as never)
  return res
}

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

  it('retorna 400 para groupJid inválido na rota administrativa', async () => {
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(makeSock())

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'ban', participants: ['5511999999999'] })
    await handleGroupsRoutes(makeReq('POST', '/connections/sess/groups/invalido/admin', body) as never, res as never, '/connections/sess/groups/invalido/admin', logger as never)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('groupJid inválido') })
  })

  it('retorna 409 quando socket não está disponível na rota administrativa', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'getInviteCode' }), {
      sock: null,
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('socket não disponível') })
  })

  it('retorna 400 para corpo inválido na rota administrativa', async () => {
    const res = await callAdminRoute('{invalid-json')

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('corpo da requisição inválido') })
  })

  it('retorna 400 para action administrativa desconhecida', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'unknown-action' }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('action inválida') })
  })

  it('executa ban via API mapeando para remove e normalizando participantes', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-admin' }))
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({
      action: 'ban',
      participants: ['5511999999999', '5511999999999@s.whatsapp.net', '(11) 98888-7777'],
    })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath('sess-admin'), body) as never, res as never, makeAdminPath('sess-admin'), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupParticipantsUpdate).toHaveBeenCalledWith(
      decodedGroupJid,
      ['5511999999999@s.whatsapp.net', '11988887777@s.whatsapp.net'],
      'remove',
    )
  })

  it('retorna 400 quando participants não contém alvo válido', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'add', participants: ['...', ''] }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('participants') })
  })

  it('alterna announcementMode via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'announcementMode', enabled: true })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupSettingUpdate).toHaveBeenCalledWith(decodedGroupJid, 'announcement')
  })

  it('retorna 400 quando enabled não é boolean', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'lockedMode', enabled: 'yes' }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('enabled') })
  })

  it('atualiza subject via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'subject', subject: 'Novo Nome' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupUpdateSubject).toHaveBeenCalledWith(decodedGroupJid, 'Novo Nome')
  })

  it('retorna 400 quando subject está vazio', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'subject', subject: '   ' }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('subject') })
  })

  it('limpa description via API quando recebe null', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'description', description: null })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupUpdateDescription).toHaveBeenCalledWith(decodedGroupJid, undefined)
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, action: 'description', description: null })
  })

  it('retorna 400 para description com tipo inválido', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'description', description: 123 }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('description') })
  })

  it('atualiza ephemeral via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'ephemeral', expirationSeconds: 86400 })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupToggleEphemeral).toHaveBeenCalledWith(decodedGroupJid, 86400)
  })

  it('retorna 400 para ephemeral inválido', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'ephemeral', expirationSeconds: -1 }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('expirationSeconds') })
  })

  it('retorna invite code e link via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'getInviteCode' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupInviteCode).toHaveBeenCalledWith(decodedGroupJid)
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      action: 'getInviteCode',
      inviteCode: 'INVITE123',
      inviteLink: 'https://chat.whatsapp.com/INVITE123',
    })
  })

  it('revoga invite e retorna novo link via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'revokeInvite' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupRevokeInvite).toHaveBeenCalledWith(decodedGroupJid)
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      action: 'revokeInvite',
      inviteCode: 'NEWCODE123',
      inviteLink: 'https://chat.whatsapp.com/NEWCODE123',
    })
  })

  it('atualiza memberAddMode via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'memberAddMode', mode: 'all_member_add' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupMemberAddMode).toHaveBeenCalledWith(decodedGroupJid, 'all_member_add')
  })

  it('retorna 400 para memberAddMode inválido', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'memberAddMode', mode: 'invalid' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('admin_add') })
  })

  it('atualiza joinApprovalMode via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'joinApprovalMode', mode: 'on' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupJoinApprovalMode).toHaveBeenCalledWith(decodedGroupJid, 'on')
  })

  it('retorna 400 para joinApprovalMode inválido', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'joinApprovalMode', mode: 'invalid' }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('on ou off') })
  })

  it('lista solicitações de entrada pendentes via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'listJoinRequests' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupRequestParticipantsList).toHaveBeenCalledWith(decodedGroupJid)
    expect(JSON.parse(res.body)).toMatchObject({
      ok: true,
      action: 'listJoinRequests',
      requests: [{ jid: '5511999999999@s.whatsapp.net' }],
    })
  })

  it('aprova solicitações de entrada via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'approveJoinRequests', participants: '5511999999999, 5511888888888' })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupRequestParticipantsUpdate).toHaveBeenCalledWith(
      decodedGroupJid,
      ['5511999999999@s.whatsapp.net', '5511888888888@s.whatsapp.net'],
      'approve',
    )
  })

  it('retorna 400 quando approveJoinRequests não recebe participantes válidos', async () => {
    const res = await callAdminRoute(JSON.stringify({ action: 'approveJoinRequests', participants: [] }))

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('participants') })
  })

  it('rejeita solicitações de entrada via API', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)

    const { handleGroupsRoutes } = await import('../src/api/routes/groups.ts')
    const res = createResponse()
    const body = JSON.stringify({ action: 'rejectJoinRequests', participants: ['5511999999999@s.whatsapp.net'] })

    await handleGroupsRoutes(makeReq('POST', makeAdminPath(), body) as never, res as never, makeAdminPath(), logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.groupRequestParticipantsUpdate).toHaveBeenCalledWith(
      decodedGroupJid,
      ['5511999999999@s.whatsapp.net'],
      'reject',
    )
  })

  it('retorna 500 e loga quando uma ação administrativa lança erro', async () => {
    const sock = makeSock()
    sock.groupInviteCode.mockRejectedValueOnce(new Error('wa-failure'))

    const res = await callAdminRoute(JSON.stringify({ action: 'getInviteCode' }), { sock })

    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('falha ao executar ação administrativa de grupo') })
    expect(logger.error).toHaveBeenCalledWith(
      'falha ao executar ação administrativa de grupo via API',
      expect.objectContaining({
        groupJid: decodedGroupJid,
        action: 'getInviteCode',
        err: expect.any(Error),
      }),
    )
  })
})
