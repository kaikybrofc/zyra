import type { Command } from './types.js'
import { formatDurationMs, isLikelyTransientPlayStreamError, refreshTrackIfNeeded, resolvePlayInput, type ResolvedPlayTrack } from '../utils/play-resolver.js'
import { createLogger } from '../observability/logger.js'

const logger = createLogger()
const WHATSAPP_VIDEO_MAX_BYTES = 100 * 1024 * 1024

async function fetchVideoBuffer(track: ResolvedPlayTrack): Promise<Buffer> {
  const response = await fetch(track.streamUrl, { signal: AbortSignal.timeout(60_000) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao baixar vídeo`)
  }

  const contentLengthHeader = response.headers.get('content-length')?.trim()
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader)
    if (Number.isFinite(declaredSize) && declaredSize > WHATSAPP_VIDEO_MAX_BYTES) {
      throw new Error('Vídeo acima do limite de 100 MB do WhatsApp')
    }
  }

  const arrayBuffer = await response.arrayBuffer()
  const videoBuffer = Buffer.from(arrayBuffer)
  if (videoBuffer.length > WHATSAPP_VIDEO_MAX_BYTES) {
    throw new Error('Vídeo acima do limite de 100 MB do WhatsApp')
  }
  return videoBuffer
}

function buildVideoCaption(track: ResolvedPlayTrack): string {
  const duration = formatDurationMs(track.durationMs)
  return [`🎬 ${track.title}`, track.uploaderName ? `Artista/Canal: ${track.uploaderName}` : null, duration ? `Duração: ${duration}` : null, `ID: ${track.identifier}`, track.webpageUrl].filter((value): value is string => Boolean(value)).join('\n')
}

/**
 * Busca um vídeo por nome ou URL, resolve um stream utilizável
 * e envia o arquivo MP4 no chat respeitando o limite do WhatsApp.
 */
export const playVideoCommand: Command = {
  name: 'playvid',
  description: 'Busca um vídeo por nome ou URL e envia o MP4 no chat',
  execute: async (ctx) => {
    const safeReply = async (text: string): Promise<void> => {
      try {
        await ctx.reply(text)
      } catch {
        // evita erro secundário ao responder
      }
    }

    const input = ctx.args.join(' ').trim()
    if (!input) {
      await safeReply('Use `!playvid nome do vídeo` ou `!playvid <url>`.')
      return
    }

    const attemptedLookupKeys = new Set<string>()
    let lastError: unknown = null

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let track: ResolvedPlayTrack
      try {
        track = await resolvePlayInput(input, { mode: 'video', skipLookupKeys: [...attemptedLookupKeys] })
        attemptedLookupKeys.add(track.lookupKey)
        track = await refreshTrackIfNeeded(track, { mode: 'video', skipLookupKeys: [...attemptedLookupKeys] })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'erro desconhecido'
        logger.warn('playvid falhou ao resolver entrada', {
          command: ctx.commandName,
          chatId: ctx.chatId,
          sender: ctx.sender,
          input,
          err: error,
        })
        if (lastError) break
        await safeReply(`❌ Não foi possível localizar o vídeo: ${message}`)
        return
      }

      try {
        let videoBuffer: Buffer
        try {
          videoBuffer = await fetchVideoBuffer(track)
        } catch (error) {
          if (!isLikelyTransientPlayStreamError(error)) throw error
          track = await refreshTrackIfNeeded(track, { forceRefresh: true, mode: 'video', skipLookupKeys: [...attemptedLookupKeys] })
          videoBuffer = await fetchVideoBuffer(track)
        }

        await ctx.sendVideo({
          video: videoBuffer,
          mimetype: 'video/mp4',
          caption: buildVideoCaption(track),
        })
        return
      } catch (error) {
        lastError = error
        logger.warn('playvid falhou ao baixar/enviar vídeo', {
          command: ctx.commandName,
          chatId: ctx.chatId,
          sender: ctx.sender,
          input,
          track: {
            identifier: track.identifier,
            title: track.title,
            webpageUrl: track.webpageUrl,
          },
          err: error,
        })
      }
    }

    const message = lastError instanceof Error ? lastError.message : 'erro desconhecido'
    await safeReply(`❌ Não foi possível enviar o vídeo: ${message}`)
  },
}
