import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const downloadContentFromMessageMock = vi.fn()

const mockConfig = {
  mediaAutoDownload: false,
  mediaDownloadDir: 'data/media',
}

vi.mock('@whiskeysockets/baileys', () => ({
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
})
