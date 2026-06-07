import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

export type StickerConversionTarget = 'png' | 'gif'

/**
 * Define uma unidade de conversão para o `@caed0/webp-conv`.
 */
type ConvertJob = {
  input: string
  output: string
  settings?: {
    quality?: number
    transparent?: string
  }
}

/**
 * Contrato mínimo da instância retornada pelo construtor do conversor.
 */
type WebpConvInstance = {
  convertJobs: (jobs: ConvertJob | ConvertJob[]) => Promise<string | string[]>
}

/**
 * Contrato do construtor do `@caed0/webp-conv` usado no runtime.
 */
type WebpConvConstructor = new (options?: { quality?: number; transparent?: string }) => WebpConvInstance

const require = createRequire(import.meta.url)
let cachedWebpConv: WebpConvConstructor | null = null

const loadWebpConv = (): WebpConvConstructor => {
  if (cachedWebpConv) return cachedWebpConv

  try {
    cachedWebpConv = require('@caed0/webp-conv') as WebpConvConstructor
    return cachedWebpConv
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('canvas.node') || message.includes("Cannot find module '../build/Release/canvas.node'")) {
      throw new Error('Conversao de sticker indisponivel neste runtime: dependencia nativa canvas ausente')
    }
    throw error
  }
}

/**
 * Converte um sticker WEBP em `png` ou `gif` usando arquivos temporários no sistema.
 *
 * Fluxo:
 * - grava o buffer de entrada em arquivo temporário
 * - executa a conversão via `@caed0/webp-conv`
 * - lê o arquivo convertido em memória
 * - remove sempre o diretório temporário ao final
 *
 * @param buffer Conteúdo WEBP de entrada.
 * @param target Formato de saída (`png` ou `gif`).
 * @returns Buffer da mídia convertida.
 */
export async function convertStickerWebp(buffer: Buffer, target: StickerConversionTarget): Promise<Buffer> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zyra-sticker-convert-'))
  const inputPath = path.join(tempDir, 'input.webp')
  const outputPath = path.join(tempDir, `output.${target}`)

  try {
    await fs.writeFile(inputPath, buffer)
    const WebpConv = loadWebpConv()
    const converter = new WebpConv({ quality: 90, transparent: '0x000000' })
    await converter.convertJobs({
      input: inputPath,
      output: outputPath,
    })
    return await fs.readFile(outputPath)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
