import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export type StickerConversionTarget = 'png' | 'gif'

type ProcessResult = {
  stdout: string
  stderr: string
}

function safeKill(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // ignore
  }
}

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

async function convertWebpFile(inputPath: string, outputPath: string, target: StickerConversionTarget): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath]

  if (target === 'gif') {
    args.push('-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease', '-loop', '0')
  } else {
    args.push('-frames:v', '1')
  }

  args.push(outputPath)

  try {
    await runProcess('ffmpeg', args, target === 'gif' ? 30_000 : 15_000)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Dependência externa ausente: instale ffmpeg no servidor.')
    }
    throw error
  }
}

/**
 * Converte um sticker WEBP em `png` ou `gif` usando arquivos temporários no sistema.
 *
 * Fluxo:
 * - grava o buffer de entrada em arquivo temporário
 * - executa a conversão via `ffmpeg`
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
    await convertWebpFile(inputPath, outputPath, target)
    return await fs.readFile(outputPath)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
