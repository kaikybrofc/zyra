import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RowDataPacket } from 'mysql2/promise'
import { config } from '../../config/index.js'
import type { AppLogger } from '../../observability/logger.js'
import { getMysqlPool } from '../../core/db/mysql.js'
import { getAntiBanStatsByConnection, getOperationalSnapshots } from '../../core/connection/manager.js'
import { validateConnectionId } from '../../core/connection/connection-id.js'
import { matchRoute, parseUrl, sendError, sendJson } from '../http.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_OFFSET = 100_000

type DataResource = 'messages' | 'chats' | 'contacts' | 'groups' | 'events' | 'commands' | 'audit'
type OrderDirection = 'ASC' | 'DESC'
type DateMode = 'timestamp_seconds' | 'datetime'
type ValueParam = string | number | Date | null

type QueryParts = {
  where: string[]
  params: ValueParam[]
}

type DataQueryOptions = {
  limit: number
  offset: number
  orderBy: string
  order: OrderDirection
  includeData: boolean
}

type DataSpec = {
  resource: DataResource
  route: string
  defaultOrderBy: string
  defaultOrder: OrderDirection
  orderColumns: Record<string, string>
  dateColumn?: string
  dateMode?: DateMode
  select: (includeData: boolean) => string
  baseWhere?: string[]
  addFilters: (url: URL, parts: QueryParts) => void
  mapRow: (row: RowDataPacket) => Record<string, unknown>
}

type AntiBanSnapshot = ReturnType<typeof getOperationalSnapshots>[number]

const parseJsonColumn = (value: unknown): unknown => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

const toMillis = (value: unknown): number | null => {
  if (!value) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value)
  }
  const parsed = new Date(String(value)).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

const toBoolean = (value: unknown): boolean | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return String(value) === '1' || String(value).toLowerCase() === 'true'
}

const normalizeString = (value: string | null, maxLength: number): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, maxLength)
}

const parseInteger = (value: string | null, fallback: number, options: { min: number; max: number }): number => {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(options.max, Math.max(options.min, Math.trunc(parsed)))
}

const parseBooleanParam = (value: string | null): boolean => {
  if (!value) return false
  return ['1', 'true', 'yes', 'sim', 'on'].includes(value.trim().toLowerCase())
}

const parseDateParam = (value: string | null): Date | null => {
  const normalized = normalizeString(value, 64)
  if (!normalized) return null
  const numeric = Number(normalized)
  if (Number.isFinite(numeric)) {
    const millis = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
    const date = new Date(millis)
    return Number.isNaN(date.getTime()) ? null : date
  }
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

const toUnixSeconds = (date: Date): number => Math.floor(date.getTime() / 1000)

const uuidExpr = (column: string): string =>
  `CASE WHEN ${column} IS NULL THEN NULL ELSE LOWER(CONCAT(HEX(SUBSTR(${column}, 1, 4)),'-',HEX(SUBSTR(${column}, 5, 2)),'-',HEX(SUBSTR(${column}, 7, 2)),'-',HEX(SUBSTR(${column}, 9, 2)),'-',HEX(SUBSTR(${column}, 11, 6)))) END`

const addEq = (parts: QueryParts, column: string, value: string | null, maxLength: number): void => {
  const normalized = normalizeString(value, maxLength)
  if (!normalized) return
  parts.where.push(`${column} = ?`)
  parts.params.push(normalized)
}

const addLike = (parts: QueryParts, columns: string[], value: string | null, maxLength: number): void => {
  const normalized = normalizeString(value, maxLength)
  if (!normalized) return
  parts.where.push(`(${columns.map((column) => `${column} LIKE ?`).join(' OR ')})`)
  for (const _column of columns) parts.params.push(`%${normalized}%`)
}

const addConnectionFilter = (url: URL, parts: QueryParts, column = 'connection_id'): void => {
  addEq(parts, column, url.searchParams.get('connectionId'), 64)
}

const addDateFilters = (url: URL, parts: QueryParts, column: string, mode: DateMode): void => {
  const from = parseDateParam(url.searchParams.get('dateFrom'))
  const to = parseDateParam(url.searchParams.get('dateTo'))
  if (from) {
    parts.where.push(`${column} >= ?`)
    parts.params.push(mode === 'timestamp_seconds' ? toUnixSeconds(from) : from)
  }
  if (to) {
    parts.where.push(`${column} <= ?`)
    parts.params.push(mode === 'timestamp_seconds' ? toUnixSeconds(to) : to)
  }
}

const withData = (includeData: boolean, alias: string, column = 'data_json', output = 'data_json'): string => (includeData ? `, ${alias}.${column} AS ${output}` : '')

const mapData = (row: RowDataPacket, key = 'data_json'): unknown => (Object.prototype.hasOwnProperty.call(row, key) ? parseJsonColumn(row[key]) : undefined)

const buildOptions = (url: URL, spec: DataSpec): DataQueryOptions => {
  const requestedOrderBy = normalizeString(url.searchParams.get('orderBy'), 64) ?? spec.defaultOrderBy
  const orderBy = Object.prototype.hasOwnProperty.call(spec.orderColumns, requestedOrderBy) ? requestedOrderBy : spec.defaultOrderBy
  const requestedOrder = normalizeString(url.searchParams.get('order'), 8)?.toLowerCase()
  const order: OrderDirection = requestedOrder === 'asc' ? 'ASC' : requestedOrder === 'desc' ? 'DESC' : spec.defaultOrder
  return {
    limit: parseInteger(url.searchParams.get('limit'), DEFAULT_LIMIT, { min: 1, max: MAX_LIMIT }),
    offset: parseInteger(url.searchParams.get('offset'), 0, { min: 0, max: MAX_OFFSET }),
    orderBy,
    order,
    includeData: parseBooleanParam(url.searchParams.get('includeData')),
  }
}

const specs: DataSpec[] = [
  {
    resource: 'messages',
    route: '/data/messages',
    defaultOrderBy: 'id',
    defaultOrder: 'DESC',
    dateColumn: 'm.timestamp',
    dateMode: 'timestamp_seconds',
    orderColumns: {
      id: 'm.id',
      timestamp: 'm.timestamp',
      updatedAt: 'm.updated_at',
    },
    select: (includeData) => `
      SELECT
        m.id,
        m.connection_id,
        m.chat_jid,
        m.message_id,
        m.from_me,
        ${uuidExpr('m.sender_user_id')} AS sender_user_id,
        m.timestamp,
        m.content_type,
        m.message_type,
        m.status,
        m.is_forwarded,
        m.is_ephemeral,
        m.text_preview,
        m.deleted_at,
        m.updated_at
        ${withData(includeData, 'm')}
      FROM messages m`,
    baseWhere: ['m.deleted_at IS NULL'],
    addFilters: (url, parts) => {
      addConnectionFilter(url, parts, 'm.connection_id')
      addEq(parts, 'm.chat_jid', url.searchParams.get('jid'), 128)
      addEq(parts, 'm.status', url.searchParams.get('status'), 32)
      const type = normalizeString(url.searchParams.get('type'), 64)
      if (type) {
        parts.where.push('(m.content_type = ? OR m.message_type = ?)')
        parts.params.push(type, type)
      }
      addLike(parts, ['m.text_preview', 'm.message_id'], url.searchParams.get('q'), 128)
      const fromMe = normalizeString(url.searchParams.get('fromMe'), 8)
      if (fromMe) {
        parts.where.push('m.from_me = ?')
        parts.params.push(['1', 'true', 'sim', 'yes'].includes(fromMe.toLowerCase()) ? 1 : 0)
      }
    },
    mapRow: (row) => ({
      id: row.id,
      connectionId: row.connection_id,
      chatJid: row.chat_jid,
      jid: row.chat_jid,
      messageId: row.message_id,
      fromMe: toBoolean(row.from_me),
      senderUserId: row.sender_user_id,
      timestamp: row.timestamp === null ? null : Number(row.timestamp),
      timestampMs: toMillis(row.timestamp),
      contentType: row.content_type,
      type: row.content_type,
      messageType: row.message_type,
      status: row.status,
      isForwarded: toBoolean(row.is_forwarded),
      isEphemeral: toBoolean(row.is_ephemeral),
      textPreview: row.text_preview,
      deletedAt: toMillis(row.deleted_at),
      updatedAt: toMillis(row.updated_at),
      ...(mapData(row) !== undefined ? { data: mapData(row) } : {}),
    }),
  },
  {
    resource: 'chats',
    route: '/data/chats',
    defaultOrderBy: 'updatedAt',
    defaultOrder: 'DESC',
    dateColumn: 'c.updated_at',
    dateMode: 'datetime',
    orderColumns: {
      jid: 'c.jid',
      updatedAt: 'c.updated_at',
      lastMessageAt: 'c.last_message_ts',
      unreadCount: 'c.unread_count',
    },
    select: (includeData) => `
      SELECT
        c.connection_id,
        c.jid,
        c.display_name,
        c.last_message_ts,
        c.unread_count,
        c.deleted_at,
        c.updated_at
        ${withData(includeData, 'c')}
      FROM chats c`,
    addFilters: (url, parts) => {
      addConnectionFilter(url, parts, 'c.connection_id')
      addEq(parts, 'c.jid', url.searchParams.get('jid'), 128)
      addLike(parts, ['c.display_name', 'c.jid'], url.searchParams.get('q'), 128)
      const status = normalizeString(url.searchParams.get('status'), 16)
      if (status === 'active') parts.where.push('c.deleted_at IS NULL')
      if (status === 'deleted') parts.where.push('c.deleted_at IS NOT NULL')
      const type = normalizeString(url.searchParams.get('type'), 24)
      if (type === 'group') parts.where.push("c.jid LIKE '%@g.us'")
      if (type === 'newsletter') parts.where.push("c.jid LIKE '%@newsletter'")
      if (type === 'contact' || type === 'private') parts.where.push("c.jid NOT LIKE '%@g.us' AND c.jid NOT LIKE '%@newsletter' AND c.jid <> 'status@broadcast'")
    },
    mapRow: (row) => ({
      connectionId: row.connection_id,
      jid: row.jid,
      displayName: row.display_name,
      lastMessageAt: row.last_message_ts === null ? null : Number(row.last_message_ts),
      lastMessageAtMs: toMillis(row.last_message_ts),
      unreadCount: row.unread_count === null ? null : Number(row.unread_count),
      deletedAt: toMillis(row.deleted_at),
      updatedAt: toMillis(row.updated_at),
      ...(mapData(row) !== undefined ? { data: mapData(row) } : {}),
    }),
  },
  {
    resource: 'contacts',
    route: '/data/contacts',
    defaultOrderBy: 'updatedAt',
    defaultOrder: 'DESC',
    dateColumn: 'wc.updated_at',
    dateMode: 'datetime',
    orderColumns: {
      jid: 'wc.jid',
      displayName: 'wc.display_name',
      updatedAt: 'wc.updated_at',
    },
    select: (includeData) => `
      SELECT
        wc.connection_id,
        wc.jid,
        ${uuidExpr('wc.user_id')} AS user_id,
        wc.display_name,
        wc.updated_at
        ${withData(includeData, 'wc')}
      FROM wa_contacts_cache wc`,
    addFilters: (url, parts) => {
      addConnectionFilter(url, parts, 'wc.connection_id')
      addEq(parts, 'wc.jid', url.searchParams.get('jid'), 128)
      addLike(parts, ['wc.display_name', 'wc.jid'], url.searchParams.get('q'), 128)
      const type = normalizeString(url.searchParams.get('type'), 24)
      if (type === 'lid') parts.where.push("wc.jid LIKE '%@lid'")
      if (type === 'pn' || type === 'phone') parts.where.push("wc.jid LIKE '%@s.whatsapp.net'")
    },
    mapRow: (row) => ({
      connectionId: row.connection_id,
      jid: row.jid,
      userId: row.user_id,
      displayName: row.display_name,
      updatedAt: toMillis(row.updated_at),
      ...(mapData(row) !== undefined ? { data: mapData(row) } : {}),
    }),
  },
  {
    resource: 'groups',
    route: '/data/groups',
    defaultOrderBy: 'updatedAt',
    defaultOrder: 'DESC',
    dateColumn: 'g.updated_at',
    dateMode: 'datetime',
    orderColumns: {
      jid: 'g.jid',
      subject: 'g.subject',
      size: 'g.size',
      updatedAt: 'g.updated_at',
    },
    select: (includeData) => `
      SELECT
        g.connection_id,
        g.jid,
        g.subject,
        ${uuidExpr('g.owner_user_id')} AS owner_user_id,
        g.announce,
        g.\`restrict\`,
        g.size,
        g.updated_at
        ${withData(includeData, 'g')}
      FROM \`groups\` g`,
    addFilters: (url, parts) => {
      addConnectionFilter(url, parts, 'g.connection_id')
      addEq(parts, 'g.jid', url.searchParams.get('jid'), 128)
      addLike(parts, ['g.subject', 'g.jid'], url.searchParams.get('q'), 128)
      const status = normalizeString(url.searchParams.get('status'), 24)
      if (status === 'announce' || status === 'announcement') parts.where.push('g.announce = 1')
      if (status === 'locked' || status === 'restricted') parts.where.push('g.`restrict` = 1')
    },
    mapRow: (row) => ({
      connectionId: row.connection_id,
      jid: row.jid,
      subject: row.subject,
      ownerUserId: row.owner_user_id,
      announce: toBoolean(row.announce),
      restrict: toBoolean(row.restrict),
      size: row.size === null ? null : Number(row.size),
      updatedAt: toMillis(row.updated_at),
      ...(mapData(row) !== undefined ? { data: mapData(row) } : {}),
    }),
  },
  {
    resource: 'events',
    route: '/data/events',
    defaultOrderBy: 'createdAt',
    defaultOrder: 'DESC',
    dateColumn: 'e.created_at',
    dateMode: 'datetime',
    orderColumns: {
      id: 'e.id',
      type: 'e.event_type',
      createdAt: 'e.created_at',
    },
    select: (includeData) => `
      SELECT
        e.id,
        e.connection_id,
        e.event_type,
        ${uuidExpr('e.actor_user_id')} AS actor_user_id,
        ${uuidExpr('e.target_user_id')} AS target_user_id,
        e.chat_jid,
        e.group_jid,
        e.message_db_id,
        e.created_at
        ${withData(includeData, 'e')}
      FROM events_log e`,
    addFilters: (url, parts) => {
      addConnectionFilter(url, parts, 'e.connection_id')
      const jid = normalizeString(url.searchParams.get('jid'), 128)
      if (jid) {
        parts.where.push('(e.chat_jid = ? OR e.group_jid = ?)')
        parts.params.push(jid, jid)
      }
      addEq(parts, 'e.event_type', url.searchParams.get('type'), 128)
      addLike(parts, ['e.event_type', 'e.chat_jid', 'e.group_jid'], url.searchParams.get('q'), 128)
    },
    mapRow: (row) => ({
      id: row.id,
      source: 'events_log',
      connectionId: row.connection_id,
      eventType: row.event_type,
      type: row.event_type,
      actorUserId: row.actor_user_id,
      targetUserId: row.target_user_id,
      chatJid: row.chat_jid,
      groupJid: row.group_jid,
      jid: row.chat_jid ?? row.group_jid,
      messageDbId: row.message_db_id,
      createdAt: toMillis(row.created_at),
      ...(mapData(row) !== undefined ? { data: mapData(row) } : {}),
    }),
  },
  {
    resource: 'commands',
    route: '/data/commands',
    defaultOrderBy: 'createdAt',
    defaultOrder: 'DESC',
    dateColumn: 'cl.created_at',
    dateMode: 'datetime',
    orderColumns: {
      id: 'cl.id',
      command: 'cl.command_name',
      durationMs: 'cl.duration_ms',
      createdAt: 'cl.created_at',
    },
    select: (includeData) => `
      SELECT
        cl.id,
        cl.connection_id,
        ${uuidExpr('cl.actor_user_id')} AS actor_user_id,
        cl.chat_jid,
        cl.command_name,
        cl.args_text,
        cl.success,
        cl.duration_ms,
        cl.created_at
        ${withData(includeData, 'cl')}
      FROM commands_log cl`,
    addFilters: (url, parts) => {
      addConnectionFilter(url, parts, 'cl.connection_id')
      addEq(parts, 'cl.chat_jid', url.searchParams.get('jid'), 128)
      addEq(parts, 'cl.command_name', url.searchParams.get('type'), 64)
      const status = normalizeString(url.searchParams.get('status'), 16)
      if (status === 'success' || status === 'ok') parts.where.push('cl.success = 1')
      if (status === 'failed' || status === 'error') parts.where.push('cl.success = 0')
      addLike(parts, ['cl.command_name', 'cl.args_text', 'cl.chat_jid'], url.searchParams.get('q'), 128)
    },
    mapRow: (row) => ({
      id: row.id,
      source: 'commands_log',
      connectionId: row.connection_id,
      actorUserId: row.actor_user_id,
      chatJid: row.chat_jid,
      jid: row.chat_jid,
      commandName: row.command_name,
      type: row.command_name,
      argsText: row.args_text,
      success: toBoolean(row.success),
      status: toBoolean(row.success) ? 'success' : 'failed',
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      createdAt: toMillis(row.created_at),
      ...(mapData(row) !== undefined ? { data: mapData(row) } : {}),
    }),
  },
  {
    resource: 'audit',
    route: '/data/audit',
    defaultOrderBy: 'createdAt',
    defaultOrder: 'DESC',
    dateColumn: 'cae.created_at',
    dateMode: 'datetime',
    orderColumns: {
      id: 'cae.id',
      type: 'cae.event_type',
      createdAt: 'cae.created_at',
    },
    select: (includeData) => `
      SELECT
        cae.id,
        cae.connection_id,
        cae.event_type,
        cae.actor,
        cae.source,
        cae.old_state,
        cae.new_state,
        cae.created_at
        ${withData(includeData, 'cae', 'payload_json')}
      FROM connection_admin_events cae`,
    addFilters: (url, parts) => {
      addConnectionFilter(url, parts, 'cae.connection_id')
      addEq(parts, 'cae.event_type', url.searchParams.get('type'), 128)
      const status = normalizeString(url.searchParams.get('status'), 64)
      if (status) {
        parts.where.push('(cae.old_state = ? OR cae.new_state = ?)')
        parts.params.push(status, status)
      }
      addLike(parts, ['cae.event_type', 'cae.actor', 'cae.source', 'cae.old_state', 'cae.new_state'], url.searchParams.get('q'), 128)
    },
    mapRow: (row) => ({
      id: row.id,
      source: row.source,
      connectionId: row.connection_id,
      eventType: row.event_type,
      type: row.event_type,
      actor: row.actor,
      oldState: row.old_state,
      newState: row.new_state,
      createdAt: toMillis(row.created_at),
      ...(mapData(row) !== undefined ? { payload: mapData(row) } : {}),
    }),
  },
]

const specByRoute = new Map(specs.map((spec) => [spec.route, spec]))

const buildAntiBanItems = (connectionId?: string) => {
  const snapshots = getOperationalSnapshots()
  const snapshotByConnection = new Map<string, AntiBanSnapshot>()
  for (const snapshot of snapshots) {
    snapshotByConnection.set(snapshot.connectionId, snapshot)
  }

  const statsByConnection = getAntiBanStatsByConnection()
  const ids = new Set([...snapshotByConnection.keys(), ...Object.keys(statsByConnection)])
  const selectedIds = connectionId ? [connectionId] : Array.from(ids).sort((a, b) => a.localeCompare(b))

  return selectedIds
    .map((id) => {
      const snapshot = snapshotByConnection.get(id)
      const stats = statsByConnection[id] ?? null
      if (!snapshot && !stats) return null
      return {
        connectionId: id,
        enabled: config.antibanEnabled,
        socketActive: snapshot?.socketActive ?? false,
        reconnectInFlight: snapshot?.reconnectInFlight ?? false,
        socketGeneration: snapshot?.socketGeneration ?? null,
        lastReconnectAtMs: snapshot?.lastReconnectAtMs ?? null,
        stats,
      }
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
}

const handleAntiBanDataRoute = (req: IncomingMessage, res: ServerResponse, pathname: string): boolean => {
  const method = req.method ?? 'GET'
  const single = matchRoute('/data/antiban/:connectionId', pathname)
  if (pathname !== '/data/antiban' && !single) return false
  if (method !== 'GET') {
    sendError(res, 405, 'método não permitido')
    return true
  }

  const url = parseUrl(req)
  if (single) {
    const parsed = validateConnectionId(single.params['connectionId'])
    if (!parsed.ok) {
      sendError(res, 400, parsed.reason)
      return true
    }
    const items = buildAntiBanItems(parsed.value)
    if (!items.length) {
      sendError(res, 404, 'estatísticas antiban não encontradas para a conexão no runtime atual')
      return true
    }
    sendJson(res, 200, {
      ok: true,
      resource: 'antiban',
      count: items.length,
      filters: Object.fromEntries(url.searchParams.entries()),
      item: items[0],
    })
    return true
  }

  const queryConnectionId = normalizeString(url.searchParams.get('connectionId'), 80)
  let items = buildAntiBanItems()
  if (queryConnectionId) {
    const parsed = validateConnectionId(queryConnectionId)
    if (!parsed.ok) {
      sendError(res, 400, parsed.reason)
      return true
    }
    items = buildAntiBanItems(parsed.value)
  }

  sendJson(res, 200, {
    ok: true,
    resource: 'antiban',
    count: items.length,
    filters: Object.fromEntries(url.searchParams.entries()),
    items,
  })
  return true
}

const buildQuery = (spec: DataSpec, url: URL, options: DataQueryOptions): { sql: string; params: ValueParam[] } => {
  const parts: QueryParts = {
    where: [...(spec.baseWhere ?? [])],
    params: [],
  }
  spec.addFilters(url, parts)
  if (spec.dateColumn && spec.dateMode) {
    addDateFilters(url, parts, spec.dateColumn, spec.dateMode)
  }
  const where = parts.where.length ? `WHERE ${parts.where.join(' AND ')}` : ''
  const orderColumn = spec.orderColumns[options.orderBy] ?? spec.orderColumns[spec.defaultOrderBy] ?? Object.values(spec.orderColumns)[0]
  const limitPlusOne = options.limit + 1
  return {
    sql: `${spec.select(options.includeData)} ${where} ORDER BY ${orderColumn} ${options.order} LIMIT ${limitPlusOne} OFFSET ${options.offset}`,
    params: parts.params,
  }
}

export async function handleDataRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, logger: AppLogger): Promise<boolean> {
  const method = req.method ?? 'GET'
  if (handleAntiBanDataRoute(req, res, pathname)) return true
  const spec = specByRoute.get(pathname)
  if (!spec) return false
  if (method !== 'GET') {
    sendError(res, 405, 'método não permitido')
    return true
  }

  const pool = getMysqlPool()
  if (!pool) {
    sendError(res, 503, 'MYSQL_URL não configurado; API de dados internos indisponível')
    return true
  }

  const url = parseUrl(req)
  const options = buildOptions(url, spec)
  const { sql, params } = buildQuery(spec, url, options)

  try {
    const [rows] = await pool.execute<RowDataPacket[]>(sql, params)
    const hasMore = rows.length > options.limit
    const pageRows = hasMore ? rows.slice(0, options.limit) : rows
    sendJson(res, 200, {
      ok: true,
      resource: spec.resource,
      count: pageRows.length,
      limit: options.limit,
      offset: options.offset,
      nextOffset: hasMore ? options.offset + options.limit : null,
      hasMore,
      orderBy: options.orderBy,
      order: options.order.toLowerCase(),
      filters: Object.fromEntries(url.searchParams.entries()),
      items: pageRows.map(spec.mapRow),
    })
  } catch (error) {
    logger.error('falha ao consultar API de dados internos', { err: error, resource: spec.resource })
    sendError(res, 500, 'falha ao consultar dados internos')
  }
  return true
}
