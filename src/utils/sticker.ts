import { downloadContentFromMessage, extractMessageContent, getContentType, normalizeMessageContent, type proto } from 'baileys'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const STICKER_SIZE = 512

export type StickerInputMediaType = 'image' | 'video' | 'sticker'

/**
 * Representa a mídia de entrada pronta para geração de figurinha.
 */
export type StickerSourceMedia = {
  buffer: Buffer
  mediaType: StickerInputMediaType
}

/**
 * Saída padronizada de processos externos executados via `spawn`.
 */
type ProcessResult = {
  stdout: string
  stderr: string
}

/**
 * Nó de mídia extraído da mensagem do WhatsApp.
 */
type MediaNode = {
  media: unknown
  mediaType: StickerInputMediaType
}

/**
 * Estrutura mínima para validar se um payload de mídia é baixável pelo Baileys.
 */
type DownloadableMedia = {
  url?: string | null
  directPath?: string | null
  mediaKey?: Uint8Array | null
}

/**
 * Envia sinal de finalização para o processo sem propagar erro caso ele já tenha encerrado.
 */
function safeKill(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // ignore
  }
}

/**
 * Executa um comando externo com timeout e captura `stdout`/`stderr`.
 * Finaliza o processo com `SIGTERM` seguido de `SIGKILL` quando o tempo estoura.
 */
function runProcess(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timeoutRef = setTimeout(() => {
      timedOut = true
      safeKill(child, 'SIGTERM')
      setTimeout(() => safeKill(child, 'SIGKILL'), 1500)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      clearTimeout(timeoutRef)
      reject(error)
    })

    child.on('close', (code) => {
      clearTimeout(timeoutRef)

      if (timedOut) {
        reject(new Error(`${command} excedeu o timeout de ${timeoutMs}ms.`))
        return
      }

      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} finalizou com código ${code}.`))
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

/**
 * Type guard para diferenciar `IWebMessageInfo` de `IMessage`.
 */
function isWebMessageInfo(message: proto.IWebMessageInfo | proto.IMessage): message is proto.IWebMessageInfo {
  return 'key' in message
}

/**
 * Normaliza entrada de mensagem para o payload `IMessage` consumido pelos helpers.
 */
function normalizeIncomingMessage(message: proto.IWebMessageInfo | proto.IMessage | null | undefined): proto.IMessage | undefined {
  if (!message) return undefined
  if (isWebMessageInfo(message)) return message.message as proto.IMessage | undefined
  return message
}

/**
 * Extrai nó de mídia suportado (imagem, vídeo ou sticker) da mensagem atual
 * ou de uma mensagem citada (`quotedMessage`), de forma recursiva.
 */
function extractMediaNode(message: proto.IWebMessageInfo | proto.IMessage | null | undefined): MediaNode | null {
  const incoming = normalizeIncomingMessage(message)
  if (!incoming) return null

  const content = extractMessageContent(normalizeMessageContent(incoming))
  if (!content) return null

  const type = getContentType(content)
  if (!type) return null

  if (type === 'imageMessage' && content.imageMessage && isDownloadableMedia(content.imageMessage)) {
    return { media: content.imageMessage, mediaType: 'image' }
  }
  if (type === 'videoMessage' && content.videoMessage && isDownloadableMedia(content.videoMessage)) {
    return { media: content.videoMessage, mediaType: 'video' }
  }
  if (type === 'stickerMessage' && content.stickerMessage && isDownloadableMedia(content.stickerMessage)) {
    return { media: content.stickerMessage, mediaType: 'sticker' }
  }

  const node = (content as Record<string, unknown>)[type] as { contextInfo?: proto.IContextInfo | null } | undefined
  return extractMediaNode(node?.contextInfo?.quotedMessage)
}

/**
 * Faz download de um nó de mídia para `Buffer`.
 */
async function mediaNodeToBuffer(node: MediaNode): Promise<Buffer> {
  const streamType = node.mediaType === 'sticker' ? 'sticker' : node.mediaType
  const stream = await downloadContentFromMessage(node.media as never, streamType as never)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * Verifica se um objeto contém os campos mínimos para download de mídia.
 */
function isDownloadableMedia(value: unknown): value is DownloadableMedia {
  if (!value || typeof value !== 'object') return false
  const record = value as DownloadableMedia
  return Boolean(record.url || record.directPath || record.mediaKey)
}

/**
 * Checa assinatura básica de um arquivo WEBP (RIFF + WEBP).
 */
function looksLikeWebp(buffer: Buffer): boolean {
  if (buffer.length < 12) return false
  return buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
}

/**
 * Resolve a mídia fonte para sticker a partir de uma mensagem do WhatsApp.
 *
 * Suporta mídia da mensagem atual e mídia citada.
 */
export async function resolveStickerSourceMedia(message: proto.IWebMessageInfo): Promise<StickerSourceMedia | null> {
  const node = extractMediaNode(message)
  if (!node) return null
  const buffer = await mediaNodeToBuffer(node)
  if (!buffer.length) return null
  return { buffer, mediaType: node.mediaType }
}

/**
 * Converte mídia de entrada para WEBP compatível com sticker.
 *
 * - sticker: copia o arquivo diretamente
 * - image/video: transcodifica com `ffmpeg`
 */
async function convertToWebp(inputPath: string, mediaType: StickerInputMediaType, outputPath: string): Promise<void> {
  if (mediaType === 'sticker') {
    // Sticker já vem em WEBP na maioria dos casos; evita transcodificar payload potencialmente corrompido.
    await fs.copyFile(inputPath, outputPath)
    return
  }

  const scaleFilter = `scale=${STICKER_SIZE}:${STICKER_SIZE}`
  const filter = mediaType === 'video' ? `fps=10,${scaleFilter}` : scaleFilter

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath]
  args.push('-t', mediaType === 'video' ? '8' : '1')

  args.push('-vcodec', 'libwebp', '-loop', '0', '-preset', 'default', '-an')

  args.push('-vsync', '0', '-lossless', '0', '-q:v', '70', '-compression_level', '6')

  args.push('-vf', filter, outputPath)
  await runProcess('ffmpeg', args, mediaType === 'video' ? 30_000 : 15_000)
}

/**
 * Cria bloco EXIF com metadados de pack para sticker WhatsApp.
 */
function createExifBuffer(packName: string, packAuthor: string): Buffer {
  const exifData = {
    'sticker-pack-id': `com.zyra.${randomUUID()}`,
    'sticker-pack-name': packName,
    'sticker-pack-publisher': packAuthor,
  }

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00,
    0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00,
    0x00, 0x00,
  ])
  const jsonBuffer = Buffer.from(JSON.stringify(exifData), 'utf8')
  const exifBuffer = Buffer.concat([exifAttr, jsonBuffer])
  exifBuffer.writeUIntLE(jsonBuffer.length, 14, 4)
  return exifBuffer
}

/**
 * Injeta metadados EXIF em um WEBP usando `webpmux` e retorna o buffer final.
 */
async function addStickerMetadata(webpPath: string, packName: string, packAuthor: string): Promise<Buffer> {
  const workDir = path.dirname(webpPath)
  const id = randomUUID()
  const exifPath = path.join(workDir, `${id}.exif`)
  const outputPath = path.join(workDir, `${id}-meta.webp`)

  try {
    await fs.writeFile(exifPath, createExifBuffer(packName, packAuthor))
    await runProcess('webpmux', ['-set', 'exif', exifPath, webpPath, '-o', outputPath], 12_000)
    return await fs.readFile(outputPath)
  } finally {
    await fs.rm(exifPath, { force: true })
    await fs.rm(outputPath, { force: true })
  }
}

/**
 * Gera um sticker WEBP final a partir de mídia suportada, com metadados de pack.
 *
 * Dependências externas:
 * - `ffmpeg`
 * - `webpmux`
 */
export async function createStickerFromMedia(
  source: StickerSourceMedia,
  options: { packName?: string; packAuthor?: string } = {}
): Promise<Buffer> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zyra-sticker-'))
  const inputPath = path.join(tempDir, `input.${source.mediaType === 'image' ? 'jpg' : source.mediaType === 'video' ? 'mp4' : 'webp'}`)
  const webpPath = path.join(tempDir, 'sticker.webp')

  try {
    if (source.mediaType === 'sticker' && !looksLikeWebp(source.buffer)) {
      throw new Error('A figurinha citada não contém WEBP válido para conversão.')
    }

    await fs.writeFile(inputPath, source.buffer)
    await convertToWebp(inputPath, source.mediaType, webpPath)
    return await addStickerMetadata(webpPath, options.packName ?? 'Zyra', options.packAuthor ?? 'Zyra')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Dependência externa ausente: instale ffmpeg e webpmux no servidor.')
    }
    throw error
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}
