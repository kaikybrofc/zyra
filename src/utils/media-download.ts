import { downloadContentFromMessage } from 'baileys'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config/index.js'

type MediaMessageType = 'imageMessage' | 'videoMessage' | 'audioMessage' | 'documentMessage' | 'stickerMessage' | 'ptvMessage'
type StreamType = 'image' | 'video' | 'audio' | 'document' | 'sticker'

type MediaDownloadSkipReason = 'invalid-node' | 'unsupported-type' | 'missing-media-key' | 'empty-media-key' | 'missing-transport' | 'downloadable'

type MediaNodeLike = {
  url?: string | null
  directPath?: string | null
  mediaKey?: Uint8Array | Buffer | string | null
}

export type IncomingMediaDownloadInspection = {
  downloadable: boolean
  reason: MediaDownloadSkipReason
  hasUrl: boolean
  hasDirectPath: boolean
  hasMediaKey: boolean
  mediaKeyLength: number | null
  urlHost: string | null
  directPathPrefix: string | null
}

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

const getUrlHost = (url: string | null): string | null => {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

const getMediaKeyLength = (mediaKey: MediaNodeLike['mediaKey']): number | null => {
  if (typeof mediaKey === 'string') return mediaKey.length
  if (mediaKey && typeof mediaKey === 'object') {
    if (typeof mediaKey.byteLength === 'number') return mediaKey.byteLength
    if (typeof mediaKey.length === 'number') return mediaKey.length
  }
  return null
}

export const inspectIncomingMediaDownload = (mediaType: MediaMessageType, mediaNode: unknown): IncomingMediaDownloadInspection => {
  const streamType = MEDIA_STREAM_TYPE[mediaType]
  if (!streamType) {
    return {
      downloadable: false,
      reason: 'unsupported-type',
      hasUrl: false,
      hasDirectPath: false,
      hasMediaKey: false,
      mediaKeyLength: null,
      urlHost: null,
      directPathPrefix: null,
    }
  }

  if (!mediaNode || typeof mediaNode !== 'object') {
    return {
      downloadable: false,
      reason: 'invalid-node',
      hasUrl: false,
      hasDirectPath: false,
      hasMediaKey: false,
      mediaKeyLength: null,
      urlHost: null,
      directPathPrefix: null,
    }
  }

  const node = mediaNode as MediaNodeLike
  const url = typeof node.url === 'string' ? node.url : null
  const directPath = typeof node.directPath === 'string' ? node.directPath : null
  const mediaKeyLength = getMediaKeyLength(node.mediaKey)
  const hasMediaKey = mediaKeyLength !== null && mediaKeyLength > 0
  const base = {
    hasUrl: Boolean(url),
    hasDirectPath: Boolean(directPath),
    hasMediaKey,
    mediaKeyLength,
    urlHost: getUrlHost(url),
    directPathPrefix: directPath ? directPath.slice(0, 80) : null,
  }

  if (mediaKeyLength === null) {
    return {
      downloadable: false,
      reason: 'missing-media-key',
      ...base,
    }
  }

  if (mediaKeyLength <= 0) {
    return {
      downloadable: false,
      reason: 'empty-media-key',
      ...base,
    }
  }

  if (!url && !directPath) {
    return {
      downloadable: false,
      reason: 'missing-transport',
      ...base,
    }
  }

  return {
    downloadable: true,
    reason: 'downloadable',
    ...base,
  }
}

type StoredMediaFile = {
  absolutePath: string
  size: number
  mtimeMs: number
}

/**
 * Deriva uma extensão de arquivo segura a partir do MIME type.
 * Retorna `bin` quando o formato é desconhecido.
 */
const extensionFromMime = (mimeType?: string | null): string => {
  if (!mimeType) return 'bin'
  const clean = mimeType.split(';')[0]?.trim().toLowerCase()
  if (!clean || !clean.includes('/')) return 'bin'
  const subType = clean.split('/')[1] ?? 'bin'
  return safeName(subType) || 'bin'
}

/**
 * Monta um nome de arquivo seguro para persistência local da mídia.
 * Prioriza o nome explícito e aplica fallback para `{messageId}-{mediaType}.{ext}`.
 */
const buildFileName = (params: { messageId: string; mediaType: MediaMessageType; fileName?: string | null; mimeType?: string | null }) => {
  const explicitFileName = params.fileName?.trim()
  if (explicitFileName) return safeName(explicitFileName)
  const ext = extensionFromMime(params.mimeType)
  return `${safeName(params.messageId)}-${params.mediaType}.${ext}`
}

/**
 * Converte caminho absoluto para relativo ao `cwd` quando possível.
 */
const toRelativePath = (absolutePath: string) => {
  const relative = path.relative(process.cwd(), absolutePath)
  return relative && !relative.startsWith('..') ? relative : absolutePath
}

/**
 * Percorre recursivamente um diretório e coleta metadados dos arquivos armazenados.
 */
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

/**
 * Garante exclusão mútua de poda por diretório para evitar concorrência entre chamadas.
 */
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

/**
 * Aplica políticas de retenção e limite de espaço no armazenamento de mídia.
 *
 * Regras:
 * - remove arquivos expirados por idade (`WA_MEDIA_RETENTION_DAYS`)
 * - remove arquivos mais antigos até respeitar o limite (`WA_MEDIA_MAX_BYTES`)
 */
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

/**
 * Faz download da mídia recebida, persiste em disco e retorna o caminho salvo.
 *
 * O fluxo respeita as configurações de runtime:
 * - só executa quando `WA_MEDIA_AUTO_DOWNLOAD=true`
 * - interrompe o download se exceder `WA_MEDIA_MAX_BYTES`
 * - aplica poda após gravação (retenção e limite de armazenamento)
 *
 * @returns Caminho relativo do arquivo salvo, ou `null` quando não aplicável/falha de validação.
 */
export async function downloadIncomingMediaToDisk(params: { messageId: string; messageDbId: number; mediaType: MediaMessageType; mediaNode: unknown; fileName?: string | null; mimeType?: string | null; connectionId: string }): Promise<string | null> {
  if (!config.mediaAutoDownload) return null
  const streamType = MEDIA_STREAM_TYPE[params.mediaType]
  const inspection = inspectIncomingMediaDownload(params.mediaType, params.mediaNode)
  if (!streamType || !inspection.downloadable) return null

  const chunks: Buffer[] = []
  let totalSize = 0
  const maxBytes = config.mediaMaxBytes
  const stream = await downloadContentFromMessage(params.mediaNode as never, streamType as never)
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += buf.length
    if (maxBytes > 0 && totalSize > maxBytes) return null
    chunks.push(buf)
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
