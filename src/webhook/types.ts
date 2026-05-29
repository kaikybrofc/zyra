export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead_letter'

export type WebhookRecord = {
  id: string
  connectionId: string
  url: string
  eventsFilter: string[]
  active: boolean
  secret: string | null
  createdAt: number
  updatedAt: number
}

export type DeliveryRecord = {
  id: string
  webhookId: string
  connectionId: string
  eventType: string
  payload: unknown
  status: DeliveryStatus
  attempts: number
  lastAttemptAt: number | null
  nextRetryAt: number | null
  responseStatus: number | null
  responseBody: string | null
  createdAt: number
}

export type WebhookPayload = {
  event: string
  connectionId: string
  timestamp: number
  data: unknown
}
