import process from 'node:process'

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value.toLowerCase() !== 'false'
}

export const config = {
  authDir: process.env.WA_AUTH_DIR ?? 'data/auth',
  printQRInTerminal: readBoolean(process.env.WA_PRINT_QR, true),
  logLevel: process.env.LOG_LEVEL ?? 'info',
}
