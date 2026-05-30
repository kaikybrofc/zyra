import { createLogger } from '../observability/logger.js'

const logger = createLogger()

const SEARCH_URL = 'https://yt-meta.ytconvert.org/search'
const DOWNLOAD_API_URL = 'https://hub.ytconvert.org/api/download'
const SEARCH_TIMEOUT_MS = 8_000
const CREATE_TIMEOUT_MS = 22_000
const STATUS_TIMEOUT_MS = 12_000
const POLL_INTERVAL_MS = 1_000
const MAX_POLLS = 30
const MAX_CANDIDATES = 5
const CACHE_TTL_MS = 900_000
const CACHE_MAX_ENTRIES = 4_000
const STREAM_REFRESH_WINDOW_MS = 90_000
const TRANSIENT_FETCH_STATUSES = new Set([401, 403, 410, 429, 500, 502, 503, 504])
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/
const SEARCH_RESULT_KEYS = ['resultado', 'resultados', 'results', 'itens', 'items', 'entries'] as const
const CANDIDATE_URL_KEYS = ['webpage_url', 'original_url', 'url', 'link', 'webpageUrl', 'originalUrl'] as const
const THUMBNAIL_KEYS = ['thumbnail', 'thumbnail_url', 'thumbnailUrl', 'thumb', 'cover', 'image'] as const

/**
 * Representa uma mídia resolvida com metadados suficientes para envio e cache.
 */
export type ResolvedPlayTrack = {
  lookupKey: string
  originalInput: string
  searchQuery: string | null
  identifier: string
  title: string
  uploaderName: string | null
  durationMs: number | null
  webpageUrl: string
  thumbnailUrl: string | null
  streamUrl: string
  streamExpiresAt: number | null
  resolvedAt: number
  playAttempts: number
}

type SearchCandidate = {
  url: string
  title: string | null
  uploaderName: string | null
  durationMs: number | null
  thumbnailUrl: string | null
}

type CacheEntry = {
  track: ResolvedPlayTrack
  expiresAt: number
}

type JsonRecord = Record<string, unknown>

type ResolveMode = 'audio' | 'video'

type ResolveOptions = {
  forceRefresh?: boolean
  mode?: ResolveMode
  skipLookupKeys?: string[]
}

const resolvedCache = new Map<string, CacheEntry>()
const inFlightResolutions = new Map<string, Promise<ResolvedPlayTrack>>()
const YOUTUBE_ALLOWED_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function extractYoutubeVideoId(value: string): string | null {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    const pathname = url.pathname

    if (hostname === 'youtu.be') {
      const candidate = pathname.split('/').filter(Boolean)[0] ?? ''
      return YOUTUBE_ID_RE.test(candidate) ? candidate : null
    }

    if (!YOUTUBE_ALLOWED_HOSTS.has(hostname)) return null

    const watchId = url.searchParams.get('v')?.trim() ?? ''
    if (YOUTUBE_ID_RE.test(watchId)) return watchId

    const segments = pathname.split('/').filter(Boolean)
    const candidate = segments.length >= 2 && ['shorts', 'embed', 'live', 'watch'].includes(segments[0] ?? '') ? (segments[1] ?? '') : (segments[0] ?? '')

    return YOUTUBE_ID_RE.test(candidate) ? candidate : null
  } catch {
    return null
  }
}

function normalizeLookupKey(input: string): string {
  const normalized = collapseWhitespace(input)
  if (!normalized) return 'q:'

  if (isUrl(normalized)) {
    const youtubeId = extractYoutubeVideoId(normalized)
    if (youtubeId) return `yt:${youtubeId}`
    return `url:${normalized}`
  }

  return `q:${normalized.toLowerCase()}`
}

function parseJsonDurationMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null
    return Math.round(value * 1_000)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null

    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1_000) : null
    }

    const parts = trimmed.split(':').map((part) => part.trim())
    if (parts.length >= 2 && parts.length <= 3 && parts.every((part) => /^\d+$/.test(part))) {
      const numbers = parts.map(Number)
      const seconds = parts.length === 3 ? numbers[0] * 3_600 + numbers[1] * 60 + numbers[2] : numbers[0] * 60 + numbers[1]
      return seconds > 0 ? seconds * 1_000 : null
    }
  }

  return null
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

function extractThumbnailUrl(payload: JsonRecord, youtubeId: string | null): string | null {
  for (const key of THUMBNAIL_KEYS) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  const thumbnails = payload.thumbnails
  if (Array.isArray(thumbnails)) {
    for (const entry of thumbnails) {
      if (!isRecord(entry)) continue
      const url = pickString(entry.url, entry.src, entry.link)
      if (url) return url
    }
  }

  if (youtubeId) {
    return `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`
  }

  return null
}

function extractIdentifier(sourceUrl: string, statusUrl: string | null, payload: JsonRecord): string {
  const youtubeId = extractYoutubeVideoId(sourceUrl)
  if (youtubeId) return youtubeId

  const payloadId = pickString(payload.id, payload.videoId, payload.identifier)
  if (payloadId) return payloadId

  if (statusUrl) {
    try {
      const url = new URL(statusUrl)
      const candidate = url.pathname.split('/').filter(Boolean).pop() ?? ''
      if (candidate) return candidate
    } catch {
      // ignore
    }
  }

  return normalizeLookupKey(sourceUrl)
}

function extractSearchEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []

  for (const key of SEARCH_RESULT_KEYS) {
    const value = payload[key]
    if (Array.isArray(value)) return value
  }

  return []
}

function isSupportedEntryType(value: unknown): boolean {
  if (typeof value !== 'string') return true
  const normalized = value.trim().toLowerCase()
  if (!normalized) return true
  return ['video', 'stream', 'audio', 'music', 'track'].some((token) => normalized.includes(token))
}

function entryCandidateUrl(entry: JsonRecord): string | null {
  for (const key of CANDIDATE_URL_KEYS) {
    const value = entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  const rawId = pickString(entry.id, entry.videoId, entry.video_id)
  if (!rawId) return null
  if (isUrl(rawId)) return rawId
  if (YOUTUBE_ID_RE.test(rawId)) {
    return `https://www.youtube.com/watch?v=${rawId}`
  }

  return null
}

function extractUploaderName(payload: JsonRecord): string | null {
  return pickString(payload.uploaderName, payload.uploader, payload.author, payload.artist, payload.channel, payload.channelName, payload.creator)
}

function extractSearchCandidates(payload: unknown): SearchCandidate[] {
  const entries = extractSearchEntries(payload)
  const candidates: SearchCandidate[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    if (!isRecord(entry)) continue
    if (!isSupportedEntryType(entry.type) || !isSupportedEntryType(entry.kind)) continue

    const candidateUrl = entryCandidateUrl(entry)
    if (!candidateUrl) continue

    const key = normalizeLookupKey(candidateUrl)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({
      url: candidateUrl,
      title: pickString(entry.title, entry.name),
      uploaderName: extractUploaderName(entry),
      durationMs: parseJsonDurationMs(entry.duration),
      thumbnailUrl: extractThumbnailUrl(entry, extractYoutubeVideoId(candidateUrl)),
    })

    if (candidates.length >= MAX_CANDIDATES) break
  }

  return candidates
}

function extractSearchCandidateUrls(payload: unknown): string[] {
  return extractSearchCandidates(payload).map((candidate) => candidate.url)
}

function buildTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs)
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return null

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`Resposta JSON inválida: ${error instanceof Error ? error.message : 'erro desconhecido'}`)
  }
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: buildTimeoutSignal(timeoutMs) })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao acessar ${url}`)
  }
  return parseJsonResponse(response)
}

function getCachedTrack(lookupKey: string): ResolvedPlayTrack | null {
  const entry = resolvedCache.get(lookupKey)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    resolvedCache.delete(lookupKey)
    return null
  }
  return { ...entry.track }
}

function pruneResolvedCache(now = Date.now()): void {
  for (const [key, entry] of resolvedCache) {
    if (entry.expiresAt <= now) {
      resolvedCache.delete(key)
    }
  }

  while (resolvedCache.size > CACHE_MAX_ENTRIES) {
    const firstKey = resolvedCache.keys().next().value
    if (!firstKey) break
    resolvedCache.delete(firstKey)
  }
}

function buildLookupKey(input: string, mode: ResolveMode): string {
  return `${mode}:${normalizeLookupKey(input)}`
}

function computeCacheExpiration(track: ResolvedPlayTrack, now = Date.now()): number {
  const ttlExpiresAt = now + CACHE_TTL_MS
  if (!track.streamExpiresAt) return ttlExpiresAt
  return Math.min(ttlExpiresAt, Math.max(now + 1_000, track.streamExpiresAt - STREAM_REFRESH_WINDOW_MS))
}

function cacheTrack(track: ResolvedPlayTrack): void {
  pruneResolvedCache(track.resolvedAt)
  resolvedCache.set(track.lookupKey, {
    track: { ...track },
    expiresAt: computeCacheExpiration(track, track.resolvedAt),
  })
}

function isStreamExpiredOrNearExpire(track: Pick<ResolvedPlayTrack, 'streamExpiresAt'>, now = Date.now()): boolean {
  if (!track.streamExpiresAt) return false
  return track.streamExpiresAt - now <= STREAM_REFRESH_WINDOW_MS
}

function parseExpiresAtFromUrl(streamUrl: string): number | null {
  try {
    const url = new URL(streamUrl)
    for (const key of ['exp', 'expires']) {
      const raw = url.searchParams.get(key)?.trim()
      if (!raw) continue
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) continue

      if (parsed > 1_000_000_000_000) return Math.trunc(parsed)
      if (parsed > 1_000_000_000) return Math.trunc(parsed * 1_000)
      if (parsed > 0) return Date.now() + Math.trunc(parsed * 1_000)
    }
  } catch {
    return null
  }

  return null
}

async function searchCandidates(query: string): Promise<SearchCandidate[]> {
  const url = new URL(SEARCH_URL)
  url.searchParams.set('q', query)
  const payload = await fetchJson(url.toString(), { method: 'GET' }, SEARCH_TIMEOUT_MS)
  return extractSearchCandidates(payload)
}

function createResolveErrorMessage(payload: JsonRecord): string {
  return pickString(payload.error, payload.jobError, payload.message) ?? 'falha desconhecida ao resolver mídia'
}

async function pollStatus(statusUrl: string, mode: ResolveMode): Promise<JsonRecord> {
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    const payload = await fetchJson(statusUrl, { method: 'GET' }, STATUS_TIMEOUT_MS)
    if (!isRecord(payload)) {
      throw new Error('Resposta inválida ao consultar status do download')
    }

    const status = pickString(payload.status)?.toLowerCase()
    if (status === 'completed') return payload
    if (status === 'failed' || status === 'error' || status === 'not_found') {
      throw new Error(createResolveErrorMessage(payload))
    }

    if (attempt < MAX_POLLS - 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    }
  }

  throw new Error(mode === 'video' ? 'Tempo esgotado aguardando o download do vídeo' : 'Tempo esgotado aguardando o download do áudio')
}

async function resolveCandidate(candidate: SearchCandidate, lookupKey: string, searchQuery: string | null, originalInput: string, mode: ResolveMode): Promise<ResolvedPlayTrack> {
  const candidateUrl = candidate.url
  const createPayload = await fetchJson(
    DOWNLOAD_API_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        mode === 'video'
          ? {
              url: candidateUrl,
              os: 'linux',
              output: { type: 'video', format: 'mp4' },
            }
          : {
              url: candidateUrl,
              os: 'linux',
              output: { type: 'audio', format: 'mp3' },
              audio: { bitrate: '128k', trackId: 'origin' },
            }
      ),
    },
    CREATE_TIMEOUT_MS
  )

  if (!isRecord(createPayload)) {
    throw new Error(mode === 'video' ? 'Resposta inválida ao criar o download do vídeo' : 'Resposta inválida ao criar o download do áudio')
  }

  const statusUrl = pickString(createPayload.statusUrl)
  if (!statusUrl) {
    throw new Error(mode === 'video' ? 'Serviço não retornou URL de status para o download do vídeo' : 'Serviço não retornou URL de status para o download do áudio')
  }

  const statusPayload = await pollStatus(statusUrl, mode)
  const streamUrl = pickString(statusPayload.downloadUrl)
  if (!streamUrl) {
    throw new Error(mode === 'video' ? 'Serviço não retornou URL final para o vídeo' : 'Serviço não retornou URL final para o áudio')
  }

  const sourceUrl = pickString(statusPayload.webpage_url, statusPayload.original_url, statusPayload.url, createPayload.webpage_url, createPayload.original_url, candidateUrl) ?? candidateUrl
  const youtubeId = extractYoutubeVideoId(sourceUrl)
  const resolvedAt = Date.now()

  return {
    lookupKey,
    originalInput,
    searchQuery,
    identifier: extractIdentifier(sourceUrl, statusUrl, statusPayload),
    title: pickString(statusPayload.title, createPayload.title, candidate.title) ?? (mode === 'video' ? 'Vídeo' : 'Áudio'),
    uploaderName: extractUploaderName(statusPayload) ?? extractUploaderName(createPayload) ?? candidate.uploaderName,
    durationMs: parseJsonDurationMs(statusPayload.duration ?? createPayload.duration) ?? candidate.durationMs,
    webpageUrl: sourceUrl,
    thumbnailUrl: pickString(statusPayload.thumbnailUrl, statusPayload.thumbnail, statusPayload.thumbnail_url) ?? pickString(createPayload.thumbnailUrl, createPayload.thumbnail, createPayload.thumbnail_url) ?? candidate.thumbnailUrl ?? extractThumbnailUrl(statusPayload, youtubeId) ?? extractThumbnailUrl(createPayload, youtubeId),
    streamUrl,
    streamExpiresAt: parseExpiresAtFromUrl(streamUrl),
    resolvedAt,
    playAttempts: 0,
  }
}

async function resolveWithoutCache(input: string, lookupKey: string, mode: ResolveMode, skipLookupKeys: Set<string>): Promise<ResolvedPlayTrack> {
  const normalizedInput = collapseWhitespace(input)
  const candidates = (isUrl(normalizedInput) ? [{ url: normalizedInput, title: null, uploaderName: null, durationMs: null, thumbnailUrl: null } satisfies SearchCandidate] : await searchCandidates(normalizedInput)).filter((candidate) => !skipLookupKeys.has(buildLookupKey(candidate.url, mode)))
  if (candidates.length === 0) {
    throw new Error('Não encontrei resultados para essa busca')
  }

  let lastError: Error | null = null
  for (const candidate of candidates) {
    try {
      return await resolveCandidate(candidate, lookupKey, isUrl(normalizedInput) ? null : normalizedInput, normalizedInput, mode)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('falha desconhecida')
      logger.warn('play resolver falhou para candidato', {
        lookupKey,
        candidate: candidate.url,
        err: lastError,
      })
    }
  }

  throw lastError ?? new Error(mode === 'video' ? 'Não foi possível resolver o vídeo solicitado' : 'Não foi possível resolver o áudio solicitado')
}

/**
 * Resolve uma busca ou URL para uma mídia com stream reproduzível,
 * reaproveitando cache e deduplicando resoluções em andamento.
 */
export async function resolvePlayInput(input: string, options: ResolveOptions = {}): Promise<ResolvedPlayTrack> {
  const normalizedInput = collapseWhitespace(input)
  const mode = options.mode ?? 'audio'
  const skipLookupKeys = new Set(options.skipLookupKeys ?? [])
  if (!normalizedInput) {
    throw new Error(mode === 'video' ? 'Informe o nome ou a URL do vídeo que deseja tocar' : 'Informe o nome ou a URL do áudio que deseja tocar')
  }

  const lookupKey = buildLookupKey(normalizedInput, mode)
  if (!options.forceRefresh) {
    const cached = getCachedTrack(lookupKey)
    if (cached) return cached
  }

  const inFlight = inFlightResolutions.get(lookupKey)
  if (inFlight && !options.forceRefresh) return inFlight

  const promise = resolveWithoutCache(normalizedInput, lookupKey, mode, skipLookupKeys)
    .then((track) => {
      cacheTrack(track)
      return { ...track }
    })
    .finally(() => {
      inFlightResolutions.delete(lookupKey)
    })

  inFlightResolutions.set(lookupKey, promise)
  return promise
}

/**
 * Revalida uma mídia já resolvida quando o stream expirou,
 * está prestes a expirar ou o chamador exige refresh.
 */
export async function refreshTrackIfNeeded(track: ResolvedPlayTrack, options: ResolveOptions = {}): Promise<ResolvedPlayTrack> {
  if (options.forceRefresh || isStreamExpiredOrNearExpire(track)) {
    return resolvePlayInput(track.originalInput, {
      forceRefresh: true,
      mode: options.mode ?? 'audio',
      skipLookupKeys: options.skipLookupKeys,
    })
  }
  return track
}

/**
 * Detecta erros transitórios típicos de stream para permitir nova tentativa.
 */
export function isLikelyTransientPlayStreamError(error: unknown): boolean {
  if (typeof error === 'number') {
    return TRANSIENT_FETCH_STATUSES.has(error)
  }

  if (error instanceof Response) {
    return TRANSIENT_FETCH_STATUSES.has(error.status)
  }

  const message = error instanceof Error ? error.message : String(error ?? '')
  const normalized = message.toLowerCase()
  if ([...TRANSIENT_FETCH_STATUSES].some((status) => normalized.includes(String(status)))) {
    return true
  }

  return ['expired', 'forbidden', 'signature', 'unauthorized', 'bad gateway', 'service unavailable'].some((token) => normalized.includes(token))
}

/**
 * Formata uma duração em milissegundos para exibição humana no chat.
 */
export function formatDurationMs(durationMs: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null
  const totalSeconds = Math.floor(durationMs / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Gera um nome de arquivo estável e seguro para salvar o áudio resolvido.
 */
export function buildPlayFileName(track: Pick<ResolvedPlayTrack, 'title'>): string {
  const base = track.title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._ -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

  return `${base || 'audio'}.mp3`
}

/**
 * Helpers internos expostos para cobertura de testes do resolvedor de mídia.
 */
export const __playResolverInternals = {
  buildLookupKey,
  normalizeLookupKey,
  extractYoutubeVideoId,
  extractSearchCandidateUrls,
  parseExpiresAtFromUrl,
  isStreamExpiredOrNearExpire,
  pruneResolvedCache,
  getCachedTrack,
  clearCaches() {
    resolvedCache.clear()
    inFlightResolutions.clear()
  },
}
