# Eventos Baileys: Exemplo de Resposta no Handler

Este arquivo mostra exemplos de **payload recebido do Baileys** em `register.ts`.

Importante:
- Os exemplos abaixo representam o objeto que chega no callback `sock.ev.on(...)`.
- Dados sensíveis foram anonimizados.
- Onde havia confirmação em logs reais, foi mantido o padrão observado em produção.

## 1) `connection.update`

```json
{
  "connection": "open",
  "lastDisconnect": null,
  "isNewLogin": false,
  "receivedPendingNotifications": true,
  "qr": null
}
```

## 2) `creds.update`

```json
{}
```

## 3) `messaging-history.set`

```json
{
  "chats": [],
  "contacts": [],
  "messages": [],
  "isLatest": true,
  "progress": 100,
  "syncType": "initial"
}
```

## 4) `chats.upsert`

```json
[
  {
    "id": "12***31@g.us",
    "conversationTimestamp": 1778950000,
    "name": "Grupo Exemplo"
  }
]
```

## 5) `chats.update`

```json
[
  {
    "id": "12***43@g.us",
    "unreadCount": 0
  }
]
```

## 6) `lid-mapping.update`

```json
{
  "lid": "89***30@lid",
  "pn": "55***55@s.whatsapp.net"
}
```

## 7) `chats.delete`

```json
[
  "12***59@g.us"
]
```

## 8) `presence.update`

```json
{
  "id": "12***43@g.us",
  "presences": {
    "22***42@lid": {
      "lastKnownPresence": "composing",
      "lastSeen": 1778960233
    }
  }
}
```

## 9) `contacts.upsert`

```json
[
  {
    "id": "55***55@s.whatsapp.net",
    "name": "Contato Exemplo",
    "notify": "Contato Exemplo"
  }
]
```

## 10) `contacts.update`

```json
[
  {
    "id": "12***13@lid",
    "notify": "Nome Atualizado"
  }
]
```

## 11) `messages.delete`

```json
{
  "keys": [
    {
      "remoteJid": "12***43@g.us",
      "id": "AC31***14BC",
      "fromMe": false,
      "participant": "22***42@lid"
    }
  ]
}
```

## 12) `messages.update`

```json
[
  {
    "key": {
      "remoteJid": "21***05@lid",
      "id": "3EB0***52A1",
      "fromMe": false,
      "participant": "21***05@lid"
    },
    "update": {
      "status": 3,
      "messageTimestamp": 1778958913
    }
  }
]
```

## 13) `messages.media-update`

```json
[
  {
    "key": {
      "remoteJid": "12***47@newsletter",
      "id": "3AD5***BC0B",
      "fromMe": false
    },
    "update": {
      "message": {
        "imageMessage": {
          "directPath": "/m1/v/t24/...",
          "mediaKey": null
        }
      }
    }
  }
]
```

## 14) `messages.upsert`

```json
{
  "type": "notify",
  "messages": [
    {
      "key": {
        "remoteJid": "12***47@newsletter",
        "id": "3AD5***BC0B",
        "fromMe": false
      },
      "messageTimestamp": 1778958159,
      "pushName": null,
      "message": {
        "videoMessage": {
          "mimetype": "video/mp4",
          "directPath": "/m1/v/t24/..."
        }
      }
    }
  ]
}
```

## 15) `messages.reaction`

```json
[
  {
    "key": {
      "remoteJid": "12***03@g.us",
      "id": "AC31***14BC",
      "fromMe": false,
      "participant": "22***42@lid"
    },
    "reaction": {
      "text": "🔥",
      "key": {
        "id": "AC31***14BC"
      }
    }
  }
]
```

## 16) `message-receipt.update`

```json
[
  {
    "key": {
      "remoteJid": "12***43@g.us",
      "id": "3EB0***52A1",
      "fromMe": false,
      "participant": "22***42@lid"
    },
    "receipt": {
      "userJid": "22***42@lid",
      "readTimestamp": 1778960233
    }
  }
]
```

## 17) `groups.upsert`

```json
[
  {
    "id": "55***63@g.us",
    "subject": "Grupo Exemplo",
    "size": 128
  }
]
```

## 18) `groups.update`

```json
[
  {
    "id": "12***31@g.us",
    "announce": false,
    "restrict": false,
    "author": "22***42@lid"
  }
]
```

## 19) `group-participants.update`

```json
{
  "id": "12***35@g.us",
  "action": "remove",
  "author": "17***46@lid",
  "participants": [
    {
      "id": "17***46@lid"
    }
  ]
}
```

## 20) `group.join-request`

```json
{
  "id": "55***61@g.us",
  "action": "created",
  "method": "linked_group_join",
  "participant": "36***26@lid",
  "author": "22***42@lid"
}
```

## 21) `group.member-tag.update`

```json
{
  "groupId": "55***61@g.us",
  "participant": "22***42@lid",
  "label": "Vice administrador | Zyra Dev"
}
```

## 22) `blocklist.set`

```json
{
  "blocklist": [
    "55***88@s.whatsapp.net"
  ]
}
```

## 23) `blocklist.update`

```json
{
  "type": "add",
  "blocklist": [
    "55***88@s.whatsapp.net"
  ]
}
```

## 24) `call`

```json
[
  {
    "id": "0025***8ADD",
    "status": "terminate",
    "from": "21***05@lid",
    "chatId": "21***05@lid"
  }
]
```

## 25) `labels.edit`

```json
{
  "id": "2",
  "deleted": false,
  "name": "Importante",
  "color": "#00AEEF"
}
```

## 26) `labels.association`

```json
{
  "type": "add",
  "association": {
    "type": "label_jid",
    "chatId": "16***87@lid",
    "labelId": "4"
  }
}
```

## 27) `newsletter.reaction`

```json
{
  "id": "12***47@newsletter",
  "server_id": "145***902"
}
```

## 28) `newsletter.view`

```json
{
  "id": "12***47@newsletter",
  "server_id": "145***902",
  "count": 1
}
```

## 29) `newsletter-participants.update`

```json
{
  "id": "12***47@newsletter",
  "author": "22***42@lid",
  "user": "36***26@lid",
  "new_role": "SUBSCRIBER",
  "action": "add"
}
```

## 30) `newsletter-settings.update`

```json
{
  "id": "12***47@newsletter",
  "update": {
    "mute": false
  }
}
```

## 31) `chats.lock`

```json
{
  "id": "12***68@g.us",
  "locked": false
}
```

## 32) `settings.update`

```json
{
  "setting": "status_privacy"
}
```