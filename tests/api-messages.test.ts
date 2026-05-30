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
  sendMessage: vi.fn(async () => ({ key: { id: 'msg-id' } })),
})

describe('handleMessagesRoutes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getConnectionMock.mockReturnValue(null)
    getActiveSocketMock.mockReturnValue(null)
  })

  it('retorna false para rotas não reconhecidas', async () => {
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const handled = await handleMessagesRoutes(makeReq('GET', '/other') as never, res as never, '/other', logger as never)
    expect(handled).toBe(false)
  })

  it('retorna 404 para conexão inexistente', async () => {
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    await handleMessagesRoutes(makeReq('POST', '/connections/nao-existe/messages/send', '{}') as never, res as never, '/connections/nao-existe/messages/send', logger as never)
    expect(res.statusCode).toBe(404)
  })

  it('retorna 409 quando instância não está open', async () => {
    getConnectionMock.mockReturnValue(makeInfo({ status: 'qr' }))
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', JSON.stringify({ type: 'text', to: '5511@s.whatsapp.net', text: 'oi' })) as never, res as never, '/connections/sess/messages/send', logger as never)
    expect(res.statusCode).toBe(409)
  })

  it('retorna 400 sem campo to', async () => {
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(makeSock())
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', JSON.stringify({ type: 'text', text: 'oi' })) as never, res as never, '/connections/sess/messages/send', logger as never)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('to') })
  })

  it('envia mensagem de texto e retorna resultado do Baileys', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-txt' }))
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'text', to: '5511@s.whatsapp.net', text: 'Olá!' })
    await handleMessagesRoutes(makeReq('POST', '/connections/sess-txt/messages/send', body) as never, res as never, '/connections/sess-txt/messages/send', logger as never)
    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', { text: 'Olá!' })
  })

  it('envia imagem com URL e retorna resultado do Baileys', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo({ connectionId: 'sess-img' }))
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'image', to: '5511@s.whatsapp.net', url: 'https://example.com/img.png', caption: 'foto' })
    await handleMessagesRoutes(makeReq('POST', '/connections/sess-img/messages/send', body) as never, res as never, '/connections/sess-img/messages/send', logger as never)
    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', {
      image: { url: 'https://example.com/img.png' },
      caption: 'foto',
    })
  })

  it('envia vídeo com URL', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'video', to: '5511@s.whatsapp.net', url: 'https://example.com/vid.mp4' })
    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', { video: { url: 'https://example.com/vid.mp4' }, caption: undefined })
  })

  it('envia áudio com URL', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'audio', to: '5511@s.whatsapp.net', url: 'https://example.com/audio.mp3' })
    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', { audio: { url: 'https://example.com/audio.mp3' } })
  })

  it('envia documento com URL, fileName e mimetype', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'document', to: '5511@s.whatsapp.net', url: 'https://example.com/doc.pdf', fileName: 'doc.pdf', mimetype: 'application/pdf' })
    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', {
      document: { url: 'https://example.com/doc.pdf' },
      fileName: 'doc.pdf',
      mimetype: 'application/pdf',
    })
  })

  it('retorna 400 para type desconhecido', async () => {
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(makeSock())
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'sticker', to: '5511@s.whatsapp.net' })
    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)
    expect(res.statusCode).toBe(400)
  })

  it('retorna 500 quando sendMessage lança erro', async () => {
    const sock = { sendMessage: vi.fn().mockRejectedValue(new Error('network error')) }
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'text', to: '5511@s.whatsapp.net', text: 'test' })
    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)
    expect(res.statusCode).toBe(500)
    expect(logger.error).toHaveBeenCalled()
  })
})
