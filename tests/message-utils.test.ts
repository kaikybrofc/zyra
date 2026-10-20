import { describe, expect, it } from 'vitest'
import { isViewOnceMessage, getMessageText, getNormalizedMessage } from '../src/utils/message.js'

describe('message utils', () => {
  it('isViewOnceMessage detecta envelopes de viewOnce corretamente', () => {
    expect(isViewOnceMessage(null)).toBe(false)
    expect(isViewOnceMessage({})).toBe(false)
    expect(isViewOnceMessage({ message: { conversation: 'olá' } })).toBe(false)

    expect(
      isViewOnceMessage({
        message: {
          viewOnceMessage: {
            message: {
              imageMessage: { url: 'https://example.com/img.jpg' },
            },
          },
        },
      })
    ).toBe(true)

    expect(
      isViewOnceMessage({
        message: {
          viewOnceMessageV2: {
            message: {
              videoMessage: { url: 'https://example.com/vid.mp4' },
            },
          },
        },
      })
    ).toBe(true)

    expect(
      isViewOnceMessage({
        message: {
          viewOnceMessageV2Extension: {
            message: {
              audioMessage: { url: 'https://example.com/aud.mp3' },
            },
          },
        },
      })
    ).toBe(true)
  })

  it('getMessageText e getNormalizedMessage extraem o conteúdo interno de viewOnce', () => {
    const msg = {
      key: { id: 'msg-1' },
      message: {
        viewOnceMessage: {
          message: {
            imageMessage: { caption: 'foto única!' },
          },
        },
      },
    }

    const normalized = getNormalizedMessage(msg)
    expect(normalized.type).toBe('imageMessage')
    expect(getMessageText(msg)).toBe('foto única!')
  })
})

