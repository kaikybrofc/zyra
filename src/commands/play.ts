import type { AnyMessageContent } from 'baileys'
import type { Command } from './types.js'
import {
  formatDurationMs,
  isLikelyTransientPlayStreamError,
  refreshTrackIfNeeded,
  resolvePlayInput,
  type ResolvedPlayTrack,
} from '../utils/play-resolver.js'
import { createLogger } from '../observability/logger.js'

const logger = createLogger()
const WHATSAPP_AUDIO_MAX_BYTES = 100 * 1024 * 1024

async function fetchAudioBuffer(track: ResolvedPlayTrack): Promise<Buffer> {
  const response = await fetch(track.streamUrl, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao baixar áudio`)
  }

  const contentLengthHeader = response.headers.get('content-length')?.trim()
  if (contentLengthHeader) {
    const declaredSize = Number(contentLengthHeader)
    if (Number.isFinite(declaredSize) && declaredSize > WHATSAPP_AUDIO_MAX_BYTES) {
      throw new Error('Áudio acima do limite de 100 MB do WhatsApp')
    }
  }

  const arrayBuffer = await response.arrayBuffer()
  const audioBuffer = Buffer.from(arrayBuffer)
  if (audioBuffer.length > WHATSAPP_AUDIO_MAX_BYTES) {
    throw new Error('Áudio acima do limite de 100 MB do WhatsApp')
  }
  return audioBuffer
}

async function buildNowPlayingPayload(track: ResolvedPlayTrack): Promise<AnyMessageContent> {
  const duration = formatDurationMs(track.durationMs)
  const lines = [
    `🎵 ${track.title}`,
    track.uploaderName ? `Artista/Canal: ${track.uploaderName}` : null,
    duration ? `Duração: ${duration}` : null,
    `ID: ${track.identifier}`,
    track.webpageUrl,
  ].filter((value): value is string => Boolean(value))

  const text = lines.join('\n')
  if (!track.thumbnailUrl) {
    return { text }
  }

  try {
    const response = await fetch(track.thumbnailUrl, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) {
      return { text }
    }

    const thumbnailBuffer = Buffer.from(await response.arrayBuffer())
    return {
      image: thumbnailBuffer,
      caption: text,
    }
  } catch {
    return { text }
  }
}

export const playCommand: Command = {
  name: 'play',
  description: 'Busca um áudio por nome ou URL e envia o MP3 no chat',
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
      await safeReply('Use `!play nome da música` ou `!play <url>`.')
      return
    }

    const attemptedLookupKeys = new Set<string>()
    let lastError: unknown = null

    for (let attempt = 0; attempt < 5; attempt += 1) {
      let track: ResolvedPlayTrack
      try {
        track = await resolvePlayInput(input, { skipLookupKeys: [...attemptedLookupKeys] })
        attemptedLookupKeys.add(track.lookupKey)
        track = await refreshTrackIfNeeded(track, { skipLookupKeys: [...attemptedLookupKeys] })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'erro desconhecido'
        logger.warn('play falhou ao resolver entrada', {
          command: ctx.commandName,
          chatId: ctx.chatId,
          sender: ctx.sender,
          input,
          err: error,
        })
        if (lastError) break
        await safeReply(`❌ Não foi possível localizar o áudio: ${message}`)
        return
      }

      try {
        let audioBuffer: Buffer
        try {
          audioBuffer = await fetchAudioBuffer(track)
        } catch (error) {
          if (!isLikelyTransientPlayStreamError(error)) throw error
          track = await refreshTrackIfNeeded(track, { forceRefresh: true, skipLookupKeys: [...attemptedLookupKeys] })
          audioBuffer = await fetchAudioBuffer(track)
        }

        const nowPlayingPayload = await buildNowPlayingPayload(track)
        await ctx.send(nowPlayingPayload)
        await ctx.sendAudio({
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          ptt: false,
        })
        return
      } catch (error) {
        lastError = error
        logger.warn('play falhou ao baixar/enviar áudio', {
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
    await safeReply(`❌ Não foi possível enviar o áudio: ${message}`)
  },
}
