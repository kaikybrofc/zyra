import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const downloadContentFromMessageMock = vi.fn()

const mockConfig = {
  mediaAutoDownload: false,
  mediaDownloadDir: 'data/media',
  mediaMaxBytes: 0,
  mediaRetentionDays: 0,
}

vi.mock('baileys', () => ({
  downloadContentFromMessage: (...args: unknown[]) => downloadContentFromMessageMock(...args),
}))

vi.mock('../src/config/index.js', () => ({ config: mockConfig }))

const toAsyncIterable = (chunks: Buffer[]) => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk
  },
})

let tempDir = ''

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mockConfig.mediaAutoDownload = false
  mockConfig.mediaMaxBytes = 0
  mockConfig.mediaRetentionDays = 0
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zyra-media-test-'))
  mockConfig.mediaDownloadDir = tempDir
})

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

describe('media-download', () => {
  it('retorna null quando auto download esta desativado', async () => {
    const { downloadIncomingMediaToDisk } = await import('../src/utils/media-download.ts')
    const localPath = await downloadIncomingMediaToDisk({
      messageId: 'm1',
      messageDbId: 1,
      mediaType: 'imageMessage',
      mediaNode: {},
      connectionId: 'default',
    })
    expect(localPath).toBeNull()
    expect(downloadContentFromMessageMock).not.toHaveBeenCalled()
  })

  it('baixa e salva arquivo quando auto download esta ativado', async () => {
    mockConfig.mediaAutoDownload = true
    downloadContentFromMessageMock.mockResolvedValueOnce(toAsyncIterable([Buffer.from('abc'), Buffer.from('123')]))
    const { downloadIncomingMediaToDisk } = await import('../src/utils/media-download.ts')

    const localPath = await downloadIncomingMediaToDisk({
      messageId: 'msg-1',
      messageDbId: 42,
      mediaType: 'audioMessage',
      mediaNode: { any: 'payload' },
      fileName: null,
      mimeType: 'audio/ogg; codecs=opus',
      connectionId: 'tenant',
    })

    expect(localPath).toContain('42-msg-1-audioMessage.ogg')
    expect(downloadContentFromMessageMock).toHaveBeenCalledTimes(1)
    const absolutePath = path.resolve(process.cwd(), localPath as string)
    const content = await fs.readFile(absolutePath)
    expect(content.toString()).toBe('abc123')
  })

  it('aborta o download e retorna null quando o arquivo excede mediaMaxBytes', async () => {
    mockConfig.mediaAutoDownload = true
    mockConfig.mediaMaxBytes = 5
    // 3-byte chunk then 3-byte chunk → cumulative 6 > 5 → should abort after second chunk
    downloadContentFromMessageMock.mockResolvedValueOnce(toAsyncIterable([Buffer.from('abc'), Buffer.from('123')]))
    const { downloadIncomingMediaToDisk } = await import('../src/utils/media-download.ts')

    const localPath = await downloadIncomingMediaToDisk({
      messageId: 'big-msg',
      messageDbId: 99,
      mediaType: 'videoMessage',
      mediaNode: { any: 'payload' },
      connectionId: 'default',
    })

    expect(localPath).toBeNull()
    // file must not have been written
    const dir = path.join(tempDir, 'default')
    const exists = await fs.access(dir).then(() => true).catch(() => false)
    expect(exists).toBe(false)
  })

  it('permite download quando tamanho total esta dentro do limite', async () => {
    mockConfig.mediaAutoDownload = true
    mockConfig.mediaMaxBytes = 10
    downloadContentFromMessageMock.mockResolvedValueOnce(toAsyncIterable([Buffer.from('hello')]))
    const { downloadIncomingMediaToDisk } = await import('../src/utils/media-download.ts')

    const localPath = await downloadIncomingMediaToDisk({
      messageId: 'small-msg',
      messageDbId: 7,
      mediaType: 'imageMessage',
      mediaNode: { any: 'payload' },
      connectionId: 'default',
    })

    expect(localPath).not.toBeNull()
    expect(localPath).toContain('7-small-msg-imageMessage')
  })
})
