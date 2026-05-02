import { downloadContentFromMessage } from '@whiskeysockets/baileys'
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
  return toRelativePath(absolutePath)
}
