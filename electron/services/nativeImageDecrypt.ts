import { existsSync } from 'fs'
import { join } from 'path'

type NativeDecryptResult = {
  data: Buffer
  ext: string
  isWxgf?: boolean
  is_wxgf?: boolean
}

type NativeAddon = {
  decryptDatNative: (inputPath: string, xorKey: number, aesKey?: string) => NativeDecryptResult
}

let cachedAddon: NativeAddon | null | undefined

function shouldEnableNative(): boolean {
  return process.env.WEFLOW_IMAGE_NATIVE !== '0'
}

function expandAsarCandidates(filePath: string): string[] {
  if (!filePath.includes('app.asar') || filePath.includes('app.asar.unpacked')) {
    return [filePath]
  }
  return [filePath.replace('app.asar', 'app.asar.unpacked'), filePath]
}

function getPlatformDir(): string {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  return process.platform
}

function getArchDir(): string {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

function getAddonCandidates(): string[] {
  const platformDir = getPlatformDir()
  const archDir = getArchDir()
  const cwd = process.cwd()
  const fileNames = [
    `weflow-image-native-${platformDir}-${archDir}.node`
  ]
  const roots = [
    join(cwd, 'resources', 'wedecrypt', platformDir, archDir),
    ...(process.resourcesPath
      ? [
          join(process.resourcesPath, 'resources', 'wedecrypt', platformDir, archDir),
          join(process.resourcesPath, 'wedecrypt', platformDir, archDir)
        ]
      : [])
  ]
  const candidates = roots.flatMap((root) => fileNames.map((name) => join(root, name)))
  return Array.from(new Set(candidates.flatMap(expandAsarCandidates)))
}

function loadAddon(): NativeAddon | null {
  if (!shouldEnableNative()) return null
  if (cachedAddon !== undefined) return cachedAddon

  for (const candidate of getAddonCandidates()) {
    if (!existsSync(candidate)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const addon = require(candidate) as NativeAddon
      if (addon && typeof addon.decryptDatNative === 'function') {
        cachedAddon = addon
        return addon
      }
    } catch {
      // try next candidate
    }
  }

  cachedAddon = null
  return null
}

export function nativeAddonLocation(): string | null {
  for (const candidate of getAddonCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function decryptDatViaNative(
  inputPath: string,
  xorKey: number,
  aesKey?: string
): { data: Buffer; ext: string; isWxgf: boolean } | null {
  const addon = loadAddon()
  if (!addon) return null

  try {
    const result = addon.decryptDatNative(inputPath, xorKey, aesKey)
    const isWxgf = Boolean(result?.isWxgf ?? result?.is_wxgf)
    if (!result || !Buffer.isBuffer(result.data)) return null
    const rawExt = typeof result.ext === 'string' && result.ext.trim()
      ? result.ext.trim().toLowerCase()
      : ''
    const ext = rawExt ? (rawExt.startsWith('.') ? rawExt : `.${rawExt}`) : ''
    return { data: result.data, ext, isWxgf }
  } catch {
    return null
  }
}
