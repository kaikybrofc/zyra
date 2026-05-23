import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const loadEnvMock = vi.fn()
const initMysqlSchemaMock = vi.fn(async () => undefined)
const closeRedisClientMock = vi.fn(async () => undefined)
const flushSocketCredsNowMock = vi.fn(async () => undefined)
const unregisterShutdownTargetMock = vi.fn()
const endMock = vi.fn(async () => undefined)
const renderQrInTerminalMock = vi.fn()
const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
}

const mockConfig = {
  mysqlUrl: 'mysql://user:pass@localhost:3306/zyra',
}

let currentEmitter: EventEmitter | null = null
const createdEmitters: EventEmitter[] = []
const createSocketMock = vi.fn(async () => {
  currentEmitter = new EventEmitter()
  createdEmitters.push(currentEmitter)
  return {
    ev: currentEmitter,
    end: endMock,
  }
})

const getMysqlPoolMock = vi.fn(() => null)
type ExecFileResult = { stdout: string; stderr: string }
const execFilePromiseMock = vi.fn<(...args: unknown[]) => Promise<ExecFileResult>>()
const execFileMock = Object.assign(
  (...args: unknown[]) => {
    const callback = args[args.length - 1] as ((error: Error | null, stdout?: string, stderr?: string) => void) | undefined
    void execFilePromiseMock(...args.slice(0, -1))
      .then((result) => callback?.(null, result.stdout, result.stderr))
      .catch((error) => callback?.(error instanceof Error ? error : new Error(String(error))))
  },
  {
    [promisify.custom]: (...args: unknown[]) => execFilePromiseMock(...args),
  }
)

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}))
vi.mock('../src/bootstrap/env.js', () => ({
  loadEnv: () => loadEnvMock(),
}))
vi.mock('../src/config/index.js', () => ({ config: mockConfig }))
vi.mock('../src/core/db/init.js', () => ({
  initMysqlSchema: (...args: unknown[]) => initMysqlSchemaMock(...args),
}))
vi.mock('../src/core/db/mysql.js', () => ({
  getMysqlPool: (...args: unknown[]) => getMysqlPoolMock(...args),
}))
vi.mock('../src/core/redis/client.js', () => ({
  closeRedisClient: (...args: unknown[]) => closeRedisClientMock(...args),
}))
vi.mock('../src/core/connection/socket.js', () => ({
  createSocket: (...args: unknown[]) => createSocketMock(...args),
  flushSocketCredsNow: (...args: unknown[]) => flushSocketCredsNowMock(...args),
  unregisterShutdownTarget: (...args: unknown[]) => unregisterShutdownTargetMock(...args),
}))
vi.mock('../src/observability/logger.js', () => ({
  createLogger: vi.fn(() => logger),
}))
vi.mock('../src/events/qr-terminal.js', () => ({
  renderQrInTerminal: (...args: unknown[]) => renderQrInTerminalMock(...args),
}))

async function waitForPairFlowToSettle() {
  await vi.waitFor(() => {
    expect(closeRedisClientMock).toHaveBeenCalled()
  })
}

describe('session pair command', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useRealTimers()
    mockConfig.mysqlUrl = 'mysql://user:pass@localhost:3306/zyra'
    currentEmitter = null
    createdEmitters.length = 0
    getMysqlPoolMock.mockReturnValue(null)
    execFilePromiseMock.mockRejectedValue(new Error('pm2 unavailable'))
    createSocketMock.mockImplementation(async () => {
      currentEmitter = new EventEmitter()
      createdEmitters.push(currentEmitter)
      return {
        ev: currentEmitter,
        end: endMock,
      }
    })
  })

  it('renderiza QR e faz flush ao abrir a conexão', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
      expect(currentEmitter).toBeTruthy()
    })
    createdEmitters[0]?.emit('connection.update', { qr: 'qr-value' })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()
    await vi.waitFor(() => {
      expect(renderQrInTerminalMock).toHaveBeenCalledWith(logger, 'qr-value', 'loja2')
      expect(flushSocketCredsNowMock).toHaveBeenCalledTimes(3)
      expect(endMock).toHaveBeenCalledTimes(2)
    })

    expect(loadEnvMock).toHaveBeenCalledTimes(1)
    expect(initMysqlSchemaMock).toHaveBeenCalledTimes(1)
    expect(createSocketMock).toHaveBeenCalledWith('loja2', logger)
    expect(flushSocketCredsNowMock.mock.calls[0]?.[1]).toBe('pairing_complete')
    expect(flushSocketCredsNowMock.mock.calls.map((call) => call[1])).toEqual([
      'pairing_complete',
      'pairing_finalize',
      'pairing_validation_finalize',
    ])

    process.argv = argv
  })

  it('conclui com sucesso quando o novo login pede restart antes do open', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
      expect(currentEmitter).toBeTruthy()
    })
    createdEmitters[0]?.emit('connection.update', { isNewLogin: true })
    createdEmitters[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledTimes(3)
    expect(flushSocketCredsNowMock.mock.calls[0]?.[1]).toBe('pairing_restart_required')

    process.argv = argv
  })

  it('falha quando mysql não está configurado', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']
    mockConfig.mysqlUrl = null

    await import('../src/core/connection/pair.ts')

    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('MYSQL_URL é obrigatório'),
        usage: 'uso: npm run session:pair -- --connection <id>',
      })
    )
    expect(createSocketMock).not.toHaveBeenCalled()

    process.argv = argv
  })

  it('falha quando --connection não é informado', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts']

    await import('../src/core/connection/pair.ts')

    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('informe a conexão com --connection <id>'),
        usage: 'uso: npm run session:pair -- --connection <id>',
      })
    )
    expect(createSocketMock).not.toHaveBeenCalled()

    process.argv = argv
  })

  it('falha quando --connection está vazio', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', '   ']

    await import('../src/core/connection/pair.ts')

    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('informe a conexão com --connection <id>'),
      })
    )
    expect(createSocketMock).not.toHaveBeenCalled()

    process.argv = argv
  })

  it('falha quando MYSQL_URL é inválida', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']
    mockConfig.mysqlUrl = 'not-a-url'

    await import('../src/core/connection/pair.ts')

    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('MYSQL_URL não é uma URL válida'),
      })
    )
    expect(createSocketMock).not.toHaveBeenCalled()

    process.argv = argv
  })

  it('falha quando MYSQL_URL não possui nome de banco', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']
    mockConfig.mysqlUrl = 'mysql://user:pass@localhost:3306/'

    await import('../src/core/connection/pair.ts')

    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('MYSQL_URL precisa apontar para um banco de dados'),
      })
    )
    expect(createSocketMock).not.toHaveBeenCalled()

    process.argv = argv
  })

  it('encerra o socket inicial quando o pairing falha por close antes do open', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })

    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledWith(expect.anything(), 'pairing_finalize')
    expect(endMock).toHaveBeenCalledTimes(1)
    expect(unregisterShutdownTargetMock).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('pairing encerrado antes de abrir a conexão loja2 (status 401)'),
      })
    )

    process.argv = argv
  })

  it('falha com loggedOut mesmo após novo login', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', { isNewLogin: true })
    createdEmitters[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })

    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledWith(expect.anything(), 'pairing_finalize')
    expect(flushSocketCredsNowMock).not.toHaveBeenCalledWith(expect.anything(), 'pairing_restart_required')
    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('status 401'),
      })
    )

    process.argv = argv
  })

  it('ignora restartRequired antes de novo login e continua aguardando', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    })

    await vi.waitFor(() => {
      expect(flushSocketCredsNowMock).not.toHaveBeenCalled()
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledWith(expect.anything(), 'pairing_complete')

    process.argv = argv
  })

  it('aceita fechamento ambiguo pos-login e segue por compatibilidade', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', { isNewLogin: true })
    createdEmitters[0]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: new Error('socket closed sem codigo') },
    })

    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledWith(expect.anything(), 'pairing_post_login_close')
    expect(logger.warn).toHaveBeenCalledWith(
      'pairing: encerramento pos-login sem status explicito, seguindo por compatibilidade',
      { connectionId: 'loja2' }
    )

    process.argv = argv
  })

  it('falha quando QR reaparece na validação', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { qr: 'qr-again' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledWith(expect.anything(), 'pairing_validation_finalize')
    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('QR reapareceu para a conexao loja2'),
      })
    )

    process.argv = argv
  })

  it('falha quando validação fecha antes de abrir', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })
    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledWith(expect.anything(), 'pairing_validation_finalize')
    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('validacao falhou: conexao loja2 encerrou antes de abrir (status 401)'),
      })
    )

    process.argv = argv
  })

  it('falha quando validação expira por timeout e encerra o socket de validação', async () => {
    vi.useFakeTimers()
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })

    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })

    await vi.advanceTimersByTimeAsync(120_000)
    await importPromise
    await waitForPairFlowToSettle()

    expect(flushSocketCredsNowMock).toHaveBeenCalledWith(expect.anything(), 'pairing_validation_finalize')
    expect(endMock).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith(
      'falha no pairing via terminal',
      expect.objectContaining({
        message: expect.stringContaining('timeout no validacao da conexao loja2'),
      })
    )

    process.argv = argv
  })

  it('ignora pm2 indisponível sem falhar o pairing', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    execFilePromiseMock.mockRejectedValue(new Error('pm2 unavailable'))

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(logger.info).toHaveBeenCalledWith(
      'pairing: pm2 indisponivel, reinicio automatico ignorado',
      expect.objectContaining({ connectionId: 'loja2' })
    )
    expect(logger.error).not.toHaveBeenCalledWith('falha no pairing via terminal', expect.anything())

    process.argv = argv
  })

  it('ignora JSON inválido do pm2 jlist', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    execFilePromiseMock.mockResolvedValue({ stdout: 'not-json', stderr: '' })

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(logger.warn).toHaveBeenCalledWith(
      'pairing: falha ao ler lista de processos do pm2',
      expect.objectContaining({ connectionId: 'loja2' })
    )

    process.argv = argv
  })

  it('ignora app pm2 offline', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    execFilePromiseMock.mockResolvedValue({
      stdout: JSON.stringify([{ name: 'zyra', pm2_env: { status: 'stopped' } }]),
      stderr: '',
    })

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(logger.info).toHaveBeenCalledWith(
      'pairing: app do pm2 nao esta online, reinicio automatico ignorado',
      expect.objectContaining({ connectionId: 'loja2', appStatus: 'stopped' })
    )

    process.argv = argv
  })

  it('ignora falha no pm2 restart após validação bem-sucedida', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    execFilePromiseMock.mockImplementation(async (...args: unknown[]) => {
      const commandArgs = args[1] as string[]
      if (commandArgs[0] === 'jlist') {
        return {
          stdout: JSON.stringify([{ name: 'zyra', pm2_env: { status: 'online', WA_CONNECTION_IDS: 'base1' } }]),
          stderr: '',
        }
      }
      throw new Error('restart failed')
    })

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(logger.warn).toHaveBeenCalledWith(
      'pairing: falha ao reiniciar app do pm2 apos validacao',
      expect.objectContaining({ connectionId: 'loja2', source: 'pm2-env', connectionIds: ['base1', 'loja2'] })
    )
    expect(logger.error).not.toHaveBeenCalledWith('falha no pairing via terminal', expect.anything())

    process.argv = argv
  })

  it('mescla WA_CONNECTION_IDS do pm2 com a conexão atual', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    execFilePromiseMock.mockImplementation(async (...args: unknown[]) => {
      const commandArgs = args[1] as string[]
      if (commandArgs[0] === 'jlist') {
        return {
          stdout: JSON.stringify([{ name: 'zyra', pm2_env: { status: 'online', env: { WA_CONNECTION_IDS: 'base1,loja2,base2' } } }]),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    })

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(execFilePromiseMock).toHaveBeenCalledWith(
      'pm2',
      ['restart', 'zyra', '--update-env'],
      expect.objectContaining({
        env: expect.objectContaining({ WA_CONNECTION_IDS: 'base1,loja2,base2' }),
      })
    )
    expect(logger.info).toHaveBeenCalledWith(
      'pairing: pm2 reiniciado com lista atualizada de conexoes',
      expect.objectContaining({ source: 'pm2-env', connectionIds: ['base1', 'loja2', 'base2'] })
    )

    process.argv = argv
  })

  it('faz fallback para auth_creds quando pm2 não expõe WA_CONNECTION_IDS', async () => {
    const argv = process.argv
    process.argv = ['node', 'pair.ts', '--connection', 'loja2']

    getMysqlPoolMock.mockReturnValue({
      execute: vi.fn(async () => [[{ connection_id: 'base1' }, { connection_id: 'loja2' }, { connection_id: 'base3' }]]),
      end: vi.fn(async () => undefined),
    })

    execFilePromiseMock.mockImplementation(async (...args: unknown[]) => {
      const commandArgs = args[1] as string[]
      if (commandArgs[0] === 'jlist') {
        return {
          stdout: JSON.stringify([{ name: 'zyra', pm2_env: { status: 'online', env: {} } }]),
          stderr: '',
        }
      }
      return { stdout: '', stderr: '' }
    })

    const importPromise = import('../src/core/connection/pair.ts')
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(1)
    })
    createdEmitters[0]?.emit('connection.update', { connection: 'open' })
    await vi.waitFor(() => {
      expect(createSocketMock).toHaveBeenCalledTimes(2)
    })
    createdEmitters[1]?.emit('connection.update', { connection: 'open' })
    await importPromise
    await waitForPairFlowToSettle()

    expect(execFilePromiseMock).toHaveBeenCalledWith(
      'pm2',
      ['restart', 'zyra', '--update-env'],
      expect.objectContaining({
        env: expect.objectContaining({ WA_CONNECTION_IDS: 'base1,loja2,base3' }),
      })
    )
    expect(logger.info).toHaveBeenCalledWith(
      'pairing: pm2 reiniciado com lista atualizada de conexoes',
      expect.objectContaining({ source: 'mysql-fallback', connectionIds: ['base1', 'loja2', 'base3'] })
    )

    process.argv = argv
  })
})
