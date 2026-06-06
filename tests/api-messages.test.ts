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
const beginApiMessageSendMock = vi.fn()
const finishApiMessageSendMock = vi.fn()
const getApiSentMessageMock = vi.fn()
const listApiSentMessagesMock = vi.fn()
const saveApiMediaUploadMock = vi.fn()
const getApiMediaUploadMock = vi.fn()

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

vi.mock('../src/store/api-message-store.js', () => ({
  beginApiMessageSend: (...args: unknown[]) => beginApiMessageSendMock(...args),
  finishApiMessageSend: (...args: unknown[]) => finishApiMessageSendMock(...args),
  getApiSentMessage: (...args: unknown[]) => getApiSentMessageMock(...args),
  listApiSentMessages: (...args: unknown[]) => listApiSentMessagesMock(...args),
  saveApiMediaUpload: (...args: unknown[]) => saveApiMediaUploadMock(...args),
  getApiMediaUpload: (...args: unknown[]) => getApiMediaUploadMock(...args),
  hashApiMessageRequest: (rawBody: string) => `hash:${rawBody}`,
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

const makeApiRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'api_msg_1',
  connectionId: 'sess',
  clientMessageId: null,
  idempotencyKey: null,
  to: '5511@s.whatsapp.net',
  type: 'text',
  requestHash: 'hash',
  messageId: 'msg-id',
  status: 'sent',
  messageStatus: null,
  derivedStatus: 'sent',
  errorMessage: null,
  request: null,
  response: { key: { id: 'msg-id' } },
  createdAt: 1,
  sentAt: 2,
  failedAt: null,
  updatedAt: 2,
  ...overrides,
})

const makeReq = (method: string, url: string, body = '', headers: Record<string, string> = {}) => ({
  method,
  url,
  headers,
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
    beginApiMessageSendMock.mockImplementation(async (input: { connectionId: string }) => ({
      status: 'created',
      record: makeApiRecord({ connectionId: input.connectionId }),
    }))
    finishApiMessageSendMock.mockImplementation(async (input: { connectionId: string; status: string; messageId?: string | null }) =>
      makeApiRecord({
        connectionId: input.connectionId,
        status: input.status,
        messageId: input.messageId ?? 'msg-id',
        derivedStatus: input.status,
      })
    )
    getApiSentMessageMock.mockResolvedValue(null)
    listApiSentMessagesMock.mockResolvedValue([])
    saveApiMediaUploadMock.mockResolvedValue({
      id: 'media_1',
      fileName: 'foto.png',
      mimeType: 'image/png',
      fileLength: 3,
      sha256: 'abc',
      localPath: 'data/api-media/media_1.png',
      createdAt: 1,
    })
    getApiMediaUploadMock.mockResolvedValue(null)
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
    expect(beginApiMessageSendMock).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'sess-txt', to: '5511@s.whatsapp.net', type: 'text' }))
    expect(finishApiMessageSendMock).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'sess-txt', messageId: 'msg-id', status: 'sent' }))
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

  it('envia sticker com URL', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'sticker', to: '5511@s.whatsapp.net', url: 'https://example.com/sticker.webp', isAnimated: true })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', {
      sticker: { url: 'https://example.com/sticker.webp' },
      isAnimated: true,
    })
  })

  it('envia contatos', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'contacts',
      to: '5511@s.whatsapp.net',
      contacts: {
        displayName: 'Equipe',
        contacts: [{ displayName: 'João', vcard: 'BEGIN:VCARD\nFN:João\nTEL;waid=5511999999999:+55 11 99999-9999\nEND:VCARD' }],
      },
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', {
      contacts: {
        displayName: 'Equipe',
        contacts: [{ displayName: 'João', vcard: 'BEGIN:VCARD\nFN:João\nTEL;waid=5511999999999:+55 11 99999-9999\nEND:VCARD' }],
      },
    })
  })

  it('envia localização', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'location',
      to: '5511@s.whatsapp.net',
      latitude: -23.55052,
      longitude: -46.633308,
      name: 'São Paulo',
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', {
      location: {
        degreesLatitude: -23.55052,
        degreesLongitude: -46.633308,
        name: 'São Paulo',
      },
    })
  })

  it('envia reação', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'react',
      to: 'grupo@g.us',
      text: '🔥',
      messageKey: { id: 'msg-id', remoteJid: 'grupo@g.us', fromMe: false },
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('grupo@g.us', {
      react: {
        text: '🔥',
        key: { id: 'msg-id', remoteJid: 'grupo@g.us', fromMe: false },
      },
    })
  })

  it('envia enquete', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'poll',
      to: 'grupo@g.us',
      name: 'Qual opção?',
      values: ['A', 'B'],
      selectableCount: 1,
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('grupo@g.us', {
      poll: {
        name: 'Qual opção?',
        values: ['A', 'B'],
        selectableCount: 1,
      },
    })
  })

  it('envia evento convertendo datas para Date', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'event',
      to: 'grupo@g.us',
      name: 'Reunião',
      startDate: '2026-06-05T12:00:00.000Z',
      endDate: '2026-06-05T13:00:00.000Z',
      description: 'Sprint review',
      call: 'video',
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    const content = sock.sendMessage.mock.calls[0]?.[1] as { event: { startDate: Date; endDate: Date; call: string; name: string } }
    expect(content.event.name).toBe('Reunião')
    expect(content.event.call).toBe('video')
    expect(content.event.startDate).toBeInstanceOf(Date)
    expect(content.event.endDate).toBeInstanceOf(Date)
  })

  it('envia payload raw compatível com AnyMessageContent', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'raw',
      to: '5511@s.whatsapp.net',
      content: { sharePhoneNumber: true },
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', { sharePhoneNumber: true })
  })

  it('preserva chaves extras ao normalizar event no modo raw', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'raw',
      to: 'grupo@g.us',
      content: {
        event: {
          name: 'Plantão',
          startDate: '2026-06-05T18:00:00.000Z',
        },
        viewOnce: true,
      },
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    const content = sock.sendMessage.mock.calls[0]?.[1] as { event: { startDate: Date; name: string }; viewOnce: boolean }
    expect(content.viewOnce).toBe(true)
    expect(content.event.name).toBe('Plantão')
    expect(content.event.startDate).toBeInstanceOf(Date)
  })

  it('envia status com options.statusJidList e broadcast', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'text',
      to: 'status@broadcast',
      text: 'Status via API',
      options: {
        statusJidList: ['5511999999999', '5511888888888@s.whatsapp.net'],
        backgroundColor: '#102030',
        font: 3,
      },
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith(
      'status@broadcast',
      { text: 'Status via API' },
      {
        statusJidList: ['5511999999999@s.whatsapp.net', '5511888888888@s.whatsapp.net'],
        backgroundColor: '#102030',
        font: 3,
        broadcast: true,
      },
    )
  })

  it('retorna 400 ao enviar status sem statusJidList', async () => {
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(makeSock())
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'text',
      to: 'status@broadcast',
      text: 'Status sem audiência',
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('statusJidList') })
  })

  it('fixa mensagem por 7 dias com type=pin', async () => {
    const sock = makeSock()
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'pin',
      to: 'grupo@g.us',
      messageKey: { id: 'msg-id', remoteJid: 'grupo@g.us', fromMe: true },
      time: 604800,
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('grupo@g.us', {
      pin: { id: 'msg-id', remoteJid: 'grupo@g.us', fromMe: true },
      type: 1,
      time: 604800,
    })
  })

  it('retorna 400 para pin sem messageKey.id', async () => {
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(makeSock())
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'pin', to: 'grupo@g.us', messageKey: {} })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('messageKey.id') })
  })

  it('retorna 400 para pin com time inválido', async () => {
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(makeSock())
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      type: 'pin',
      to: 'grupo@g.us',
      messageKey: { id: 'msg-id' },
      time: 123,
    })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('86400') })
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
    expect(finishApiMessageSendMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
    expect(logger.error).toHaveBeenCalled()
  })

  it('reaproveita envio existente com Idempotency-Key sem reenviar', async () => {
    const sock = makeSock()
    const existingResponse = { key: { id: 'already-sent' } }
    beginApiMessageSendMock.mockResolvedValueOnce({
      status: 'existing',
      record: makeApiRecord({
        id: 'api_msg_existing',
        idempotencyKey: 'idem-1',
        response: existingResponse,
      }),
    })
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'text', to: '5511@s.whatsapp.net', text: 'oi' })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body, { 'idempotency-key': 'idem-1' }) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(existingResponse)
    expect(res.headers['x-idempotent-replay']).toBe('true')
    expect(sock.sendMessage).not.toHaveBeenCalled()
  })

  it('retorna 409 quando clientMessageId conflita com outro payload', async () => {
    beginApiMessageSendMock.mockResolvedValueOnce({
      status: 'conflict',
      reason: 'clientMessageId ou Idempotency-Key já usado com outro payload',
    })
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(makeSock())
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'text', to: '5511@s.whatsapp.net', text: 'oi', clientMessageId: 'cli-1' })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(409)
  })

  it('lista histórico de mensagens enviadas pela API', async () => {
    listApiSentMessagesMock.mockResolvedValueOnce([makeApiRecord({ id: 'api_msg_1' })])
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()

    await handleMessagesRoutes(makeReq('GET', '/connections/sess/messages?to=5511@s.whatsapp.net&status=sent&limit=10') as never, res as never, '/connections/sess/messages', logger as never)

    expect(res.statusCode).toBe(200)
    expect(listApiSentMessagesMock).toHaveBeenCalledWith({
      connectionId: 'sess',
      to: '5511@s.whatsapp.net',
      status: 'sent',
      limit: 10,
    })
    expect(JSON.parse(res.body)).toMatchObject({ connectionId: 'sess', count: 1 })
  })

  it('busca status de mensagem enviada pela API', async () => {
    getApiSentMessageMock.mockResolvedValueOnce(makeApiRecord({ id: 'api_msg_1', messageId: 'msg-id' }))
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()

    await handleMessagesRoutes(makeReq('GET', '/connections/sess/messages/msg-id') as never, res as never, '/connections/sess/messages/msg-id', logger as never)

    expect(res.statusCode).toBe(200)
    expect(getApiSentMessageMock).toHaveBeenCalledWith('sess', 'msg-id')
    expect(JSON.parse(res.body)).toMatchObject({ messageId: 'msg-id', derivedStatus: 'sent' })
  })

  it('retorna 404 para status de mensagem inexistente', async () => {
    getApiSentMessageMock.mockResolvedValueOnce(null)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()

    await handleMessagesRoutes(makeReq('GET', '/connections/sess/messages/missing') as never, res as never, '/connections/sess/messages/missing', logger as never)

    expect(res.statusCode).toBe(404)
  })

  it('faz upload de mídia via JSON/base64', async () => {
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({
      fileName: 'foto.png',
      mimetype: 'image/png',
      base64: Buffer.from('abc').toString('base64'),
    })

    await handleMessagesRoutes(makeReq('POST', '/media', body) as never, res as never, '/media', logger as never)

    expect(res.statusCode).toBe(201)
    expect(saveApiMediaUploadMock).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'foto.png', mimeType: 'image/png' }))
    expect(JSON.parse(res.body)).toMatchObject({ id: 'media_1' })
  })

  it('envia mídia usando mediaId', async () => {
    const sock = makeSock()
    getApiMediaUploadMock.mockResolvedValueOnce({
      id: 'media_1',
      fileName: 'foto.png',
      mimeType: 'image/png',
      fileLength: 3,
      sha256: 'abc',
      localPath: 'data/api-media/media_1.png',
      createdAt: 1,
    })
    getConnectionMock.mockReturnValue(makeInfo())
    getActiveSocketMock.mockReturnValue(sock)
    const { handleMessagesRoutes } = await import('../src/api/routes/messages.ts')
    const res = createResponse()
    const body = JSON.stringify({ type: 'image', to: '5511@s.whatsapp.net', mediaId: 'media_1', caption: 'foto' })

    await handleMessagesRoutes(makeReq('POST', '/connections/sess/messages/send', body) as never, res as never, '/connections/sess/messages/send', logger as never)

    expect(res.statusCode).toBe(200)
    expect(sock.sendMessage).toHaveBeenCalledWith('5511@s.whatsapp.net', {
      image: { url: 'data/api-media/media_1.png' },
      caption: 'foto',
    })
  })
})
