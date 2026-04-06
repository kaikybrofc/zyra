import { BufferJSON, proto, type SignalDataTypeMap } from '@whiskeysockets/baileys'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const folderReady = new Map<string, Promise<void>>()

/**
 * Assegura que o diretório base para arquivos de fallback exista.
 * @internal
 */
export const ensureAuthFolder = async (folder: string) => {
  const existing = folderReady.get(folder)
  if (existing) {
    await existing
    return
  }
  const task = mkdir(folder, { recursive: true }).then(() => undefined)
  folderReady.set(folder, task)
  await task
}

/**
 * Formata o nome do arquivo para evitar caracteres inválidos no sistema de arquivos.
 * @internal
 */
export const fixFileName = (file: string) => file.replace(/\//g, '__').replace(/:/g, '-')

/**
 * Converte objetos em string JSON usando o replacer do Baileys (suporte a Buffer).
 * @internal
 */
export const serialize = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)

/**
 * Converte JSON de volta em objetos usando o reviver do Baileys (restaura Buffers).
 * @internal
 */
export const deserialize = <T>(value: unknown): T | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    return JSON.parse(value, BufferJSON.reviver) as T
  }
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T
}

/**
 * Tenta ler um arquivo JSON do disco e desserializá-lo. Retorna null em caso de erro.
 * @internal
 */
export const readData = async <T>(folder: string, file: string): Promise<T | null> => {
  try {
    const filePath = join(folder, fixFileName(file))
    const data = await readFile(filePath, { encoding: 'utf-8' })
    return deserialize<T>(data)
  } catch {
    return null
  }
}

/**
 * Salva dados no disco de forma serializada.
 * @internal
 */
export const writeData = async (folder: string, file: string, data: unknown): Promise<void> => {
  const filePath = join(folder, fixFileName(file))
  await writeFile(filePath, serialize(data))
}

/**
 * Remove arquivos do disco sem lançar erro quando inexistentes.
 * @internal
 */
export const deleteData = async (folder: string, file: string): Promise<void> => {
  try {
    const filePath = join(folder, fixFileName(file))
    await unlink(filePath)
  } catch {
    // ignora ENOENT e demais erros
  }
}

/**
 * Normaliza objetos do Signal para garantir que correspondam aos tipos do ProtoBuf.
 * @internal
 */
export const normalizeKeyValue = <T extends keyof SignalDataTypeMap>(
  type: T,
  value: SignalDataTypeMap[T] | null
): SignalDataTypeMap[T] | null => {
  if (!value) return null
  if (type === 'app-state-sync-key') {
    const normalized = proto.Message.AppStateSyncKeyData.fromObject(
      value as unknown as proto.Message.IAppStateSyncKeyData
    )
    return normalized as unknown as SignalDataTypeMap[T]
  }
  return value
}
