import { downloadContentFromMessage } from 'baileys'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config/index.js'

type MediaMessageType = 'imageMessage' | 'videoMessage' | 'audioMessage' | 'documentMessage' | 'stickerMessage' | 'ptvMessage'
type StreamType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

const MEDIA_STREAM_TYPE: Record<MediaMessageType, StreamType> = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video',
}

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_')
const MS_PER_DAY = 24 * 60 * 60 * 1000
const pruneInFlightByDir = new Map<string, Promise<void>>()

type StoredMediaFile = {
  absolutePath: string
  size: number
  mtimeMs: number
}

const extensionFromMime = (mimeType?: string | null): string => {
  if (!mimeType) return 'bin'
  const clean = mimeType.split(';')[0]?.trim().toLowerCase()
  if (!clean || !clean.includes('/')) return 'bin'
  const subType = clean.split('/')[1] ?? 'bin'
  return safeName(subType) || 'bin'
}

const buildFileName = (params: { messageId: string; mediaType: MediaMessageType; fileName?: string | null; mimeType?: string | null }) => {
  const explicitFileName = params.fileName?.trim()
  if (explicitFileName) return safeName(explicitFileName)
  const ext = extensionFromMime(params.mimeType)
  return `${safeName(params.messageId)}-${params.mediaType}.${ext}`
}

const toRelativePath = (absolutePath: string) => {
  const relative = path.relative(process.cwd(), absolutePath)
  return relative && !relative.startsWith('..') ? relative : absolutePath
}

const collectStoredMediaFiles = async (dir: string): Promise<StoredMediaFile[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: StoredMediaFile[] = []
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectStoredMediaFiles(absolutePath)))
      continue
    }
    if (!entry.isFile()) continue
    const stat = await fs.stat(absolutePath)
    files.push({
      absolutePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    })
  }
  return files
}

const withPruneLock = async (dir: string, worker: () => Promise<void>): Promise<void> => {
  const running = pruneInFlightByDir.get(dir)
  if (running) {
    await running
    return
  }
  const next = worker().finally(() => {
    const current = pruneInFlightByDir.get(dir)
    if (current === next) pruneInFlightByDir.delete(dir)
  })
  pruneInFlightByDir.set(dir, next)
  await next
}

const pruneMediaStorage = async (baseDir: string): Promise<void> => {
  const maxBytes = config.mediaMaxBytes
  const retentionDays = config.mediaRetentionDays
  const retentionMs = retentionDays > 0 ? retentionDays * MS_PER_DAY : 0
  const enforceSize = maxBytes > 0
  const enforceRetention = retentionMs > 0
  if (!enforceSize && !enforceRetention) return

  await withPruneLock(baseDir, async () => {
    let files = await collectStoredMediaFiles(baseDir)
    if (!files.length) return
    const now = Date.now()

    if (enforceRetention) {
      const kept: StoredMediaFile[] = []
      for (const file of files) {
        const expired = now - file.mtimeMs > retentionMs
        if (!expired) {
          kept.push(file)
          continue
        }
        await fs.rm(file.absolutePath, { force: true })
      }
      files = kept
    }

    if (!enforceSize || !files.length) return
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0)
    if (totalBytes <= maxBytes) return

    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of files) {
      if (totalBytes <= maxBytes) break
      await fs.rm(file.absolutePath, { force: true })
      totalBytes -= file.size
    }
  })
}

export async function downloadIncomingMediaToDisk(params: {
  messageId: string
  messageDbId: number
  mediaType: MediaMessageType
  mediaNode: unknown
  fileName?: string | null
  mimeType?: string | null
  connectionId: string
}): Promise<string | null> {
  if (!config.mediaAutoDownload) return null
  const streamType = MEDIA_STREAM_TYPE[params.mediaType]
  if (!streamType || !params.mediaNode || typeof params.mediaNode !== 'object') return null

  const chunks: Buffer[] = []
  const stream = await downloadContentFromMessage(params.mediaNode as never, streamType as never)
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const buffer = Buffer.concat(chunks)
  if (!buffer.length) return null

  const baseDir = path.resolve(process.cwd(), config.mediaDownloadDir, safeName(params.connectionId))
  await fs.mkdir(baseDir, { recursive: true })

  const name = buildFileName({
    messageId: params.messageId,
    mediaType: params.mediaType,
    fileName: params.fileName,
    mimeType: params.mimeType,
  })
  const absolutePath = path.join(baseDir, `${params.messageDbId}-${name}`)
  await fs.writeFile(absolutePath, buffer)
  await pruneMediaStorage(baseDir)
  return toRelativePath(absolutePath)
}
