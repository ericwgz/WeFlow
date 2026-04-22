import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CosSdk = require('cos-nodejs-sdk-v5') as new (options: {
  SecretId: string
  SecretKey: string
  SecurityToken?: string
}) => {
  putObject: (
    options: Record<string, unknown>,
    callback: (error: unknown, data: Record<string, unknown>) => void
  ) => void
}

interface DetailedExportSession {
  wxid?: string
  type?: string
  [key: string]: unknown
}

interface DetailedExportMessage {
  localId?: number
  createTime?: number
  type?: string
  localType?: number
  content?: string | null
  isSend?: number
  platformMessageId?: string
  senderUsername?: string
  senderDisplayName?: string
  senderAvatarKey?: string
  appMsgKind?: string
  quotedContent?: string
  replyToMessageId?: string
  [key: string]: unknown
}

interface DetailedExportFile {
  weflow?: {
    format?: string
    [key: string]: unknown
  }
  session?: DetailedExportSession
  messages?: DetailedExportMessage[]
  senders?: unknown
  [key: string]: unknown
}

type NianbanMessageRole = 'user' | 'actor'
type NianbanAssetId = number | string

interface NianbanBaseMessageItem {
  role: NianbanMessageRole
  create_time: number
  local_id: number
  local_type: number
  message_type_label: string
  platform_message_id?: string
  sender_username?: string
  sender_display_name?: string
  sender_avatar_key?: string
  meta: Record<string, unknown>
}

interface NianbanTextMessageItem extends NianbanBaseMessageItem {
  kind: 'text'
  text: string
}

interface NianbanMediaMessageItem extends NianbanBaseMessageItem {
  kind: 'image' | 'audio'
  asset_id: NianbanAssetId
  text?: string
}

type NianbanPrivateChatMessageItem = NianbanTextMessageItem | NianbanMediaMessageItem

interface UploadableMediaCandidate {
  kind: 'image' | 'voice'
  filePath: string
  role: NianbanMessageRole
  createTime: number
  localId: number
  localType: number
  messageTypeLabel: string
  platformMessageId?: string
  senderUsername?: string
  senderDisplayName?: string
  senderAvatarKey?: string
  text?: string
  meta: Record<string, unknown>
}

interface PairTokenResult {
  pairToken: string
  dyadId: number
}

interface CosUploadSession {
  pairToken: string
  cosKey: string
  bucket: string
  region: string
  credentials: {
    tmpSecretId: string
    tmpSecretKey: string
    token?: string
    expiredTime?: number
  }
}

interface VoiceFileIndex {
  exactKeyToPaths: Map<string, string[]>
  createTimeToPaths: Map<string, string[]>
}

interface UploadStats {
  textImportedCount: number
  imageUploadedCount: number
  voiceUploadedCount: number
  imageImportedCount: number
  voiceImportedCount: number
  skippedCount: number
  failedCount: number
}

export interface NianbanExportUploadPayload {
  sessionId: string
  outputDir?: string
  jsonPath?: string
  baseUrl: string
  deviceId: string
  dyadId: number
}

export interface NianbanExportUploadResult {
  ok: boolean
  importedCount: number
  textImportedCount: number
  imageUploadedCount: number
  voiceUploadedCount: number
  imageImportedCount: number
  voiceImportedCount: number
  skippedCount: number
  failedCount: number
  dyadId: number
  talkerId: string
  jsonPath?: string
  error?: string
}

class NianbanUploadService {
  private readonly SOURCE_TAG = 'weflow-export-v1'
  private readonly PAIR_TOKEN_TTL_SECONDS = 86400
  private readonly JSON_BATCH_SIZE = 200
  private readonly API_TIMEOUT_MS = 30000
  private readonly ASSET_UPLOAD_TIMEOUT_MS = 120000
  private readonly MEDIA_SCAN_MAX_DEPTH = 4
  private readonly SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
  private readonly SUPPORTED_VOICE_EXTENSIONS = new Set(['.wav', '.mp3', '.m4a', '.aac', '.amr', '.silk', '.opus'])

  async uploadExportedChatToNianban(
    payload: NianbanExportUploadPayload
  ): Promise<NianbanExportUploadResult> {
    const sessionId = String(payload.sessionId || '').trim()
    const outputDir = String(payload.outputDir || '').trim()
    const explicitJsonPath = String(payload.jsonPath || '').trim()
    const baseUrl = String(payload.baseUrl || '').trim()
    const deviceId = String(payload.deviceId || '').trim()
    const dyadId = Math.floor(Number(payload.dyadId || 0))
    const stats = this.createEmptyStats()

    if (!sessionId) {
      return this.buildFailureResult('会话 ID 不能为空', dyadId, '', undefined, stats)
    }
    if (!outputDir && !explicitJsonPath) {
      return this.buildFailureResult('导出结果目录或 JSON 路径不能为空', dyadId, sessionId, undefined, stats)
    }
    if (!baseUrl) {
      return this.buildFailureResult('念伴后端地址不能为空', dyadId, sessionId, undefined, stats)
    }
    if (!deviceId) {
      return this.buildFailureResult('X-Device-Id 不能为空', dyadId, sessionId, undefined, stats)
    }
    if (!Number.isSafeInteger(dyadId) || dyadId <= 0) {
      return this.buildFailureResult('目标 Dyad ID 必须是正整数', dyadId, sessionId, undefined, stats)
    }

    const jsonPathResult = await this.resolveDetailedJsonPath(sessionId, {
      outputDir,
      jsonPath: explicitJsonPath
    })
    if (!jsonPathResult.ok) {
      return this.buildFailureResult(jsonPathResult.error, dyadId, sessionId, undefined, stats)
    }

    const jsonPath = jsonPathResult.path
    const readResult = await this.readDetailedExportJson(jsonPath)
    if (!readResult.ok) {
      return this.buildFailureResult(readResult.error, dyadId, sessionId, jsonPath, stats)
    }

    const exportData = readResult.data
    const talkerId = String(exportData.session?.wxid || sessionId).trim() || sessionId
    if (this.isGroupSession(talkerId, exportData.session?.type)) {
      return this.buildFailureResult('当前仅支持单联系人私聊上传', dyadId, talkerId, jsonPath, stats)
    }

    const messages = Array.isArray(exportData.messages) ? exportData.messages : []
    const collectResult = await this.collectUploadableItems(messages, {
      talkerId,
      jsonPath,
      outputDir
    })

    stats.skippedCount = collectResult.skippedCount
    if (collectResult.textItems.length === 0 && collectResult.mediaCandidates.length === 0) {
      return this.buildFailureResult('没有可上传的文本、图片或语音消息', dyadId, talkerId, jsonPath, stats)
    }

    let importUrl: string
    let pairUrl: string
    let uploadSessionUrl: string
    let completeUrl: string
    try {
      importUrl = this.buildImportUrl(baseUrl, dyadId)
      pairUrl = this.buildPairUrl(baseUrl)
      uploadSessionUrl = this.buildAssetsUploadSessionUrl(baseUrl)
      completeUrl = this.buildAssetsCompleteUrl(baseUrl)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.buildFailureResult(`念伴后端地址无效: ${message}`, dyadId, talkerId, jsonPath, stats)
    }

    let pairTokenResult: PairTokenResult | undefined
    if (collectResult.mediaCandidates.length > 0) {
      const nextPairTokenResult = await this.fetchPairToken(pairUrl, deviceId, dyadId)
      if (!nextPairTokenResult.ok) {
        stats.failedCount += collectResult.mediaCandidates.length
        return this.buildFailureResult(nextPairTokenResult.error, dyadId, talkerId, jsonPath, stats)
      }
      pairTokenResult = nextPairTokenResult.data
    }

    if (collectResult.textItems.length > 0) {
      const textImportResult = await this.importPrivateChatMessages(
        importUrl,
        deviceId,
        talkerId,
        collectResult.textItems,
        this.JSON_BATCH_SIZE
      )
      if (!textImportResult.ok) {
        stats.failedCount += collectResult.textItems.length
        return this.buildFailureResult(textImportResult.error, dyadId, talkerId, jsonPath, stats)
      }
      stats.textImportedCount += textImportResult.importedCount
    }

    const mediaImportItems: NianbanMediaMessageItem[] = []
    const uploadedAssetCache = new Map<string, NianbanAssetId>()

    for (const candidate of collectResult.mediaCandidates) {
      const cacheKey = `${candidate.kind}:${candidate.filePath}`
      let assetId = uploadedAssetCache.get(cacheKey)
      if (assetId === undefined) {
        if (!pairTokenResult) {
          stats.failedCount += 1
          console.warn(`[nianban-upload] skip failed media ${candidate.kind}: missing pair token`)
          continue
        }
        const assetUploadResult = await this.uploadAssetForMessage(
          candidate,
          pairTokenResult.pairToken,
          uploadSessionUrl,
          completeUrl,
          deviceId
        )
        if (!assetUploadResult.ok) {
          stats.failedCount += 1
          console.warn(`[nianban-upload] skip failed media ${candidate.kind}: ${assetUploadResult.error}`)
          continue
        }

        assetId = assetUploadResult.assetId
        uploadedAssetCache.set(cacheKey, assetId)
        if (candidate.kind === 'image') {
          stats.imageUploadedCount += 1
        } else {
          stats.voiceUploadedCount += 1
        }
      }

      mediaImportItems.push(this.buildMediaImportItem(candidate, assetId))
    }

    if (mediaImportItems.length > 0) {
      const mediaImportResult = await this.importPrivateChatMessages(
        importUrl,
        deviceId,
        talkerId,
        mediaImportItems,
        this.JSON_BATCH_SIZE
      )
      if (!mediaImportResult.ok) {
        stats.failedCount += mediaImportItems.length
        return this.buildFailureResult(mediaImportResult.error, dyadId, talkerId, jsonPath, stats)
      }

      for (const item of mediaImportItems) {
        if (item.kind === 'image') {
          stats.imageImportedCount += 1
        } else {
          stats.voiceImportedCount += 1
        }
      }
    }

    if (stats.textImportedCount + stats.imageImportedCount + stats.voiceImportedCount <= 0) {
      return this.buildFailureResult('没有成功导入到念伴的消息', dyadId, talkerId, jsonPath, stats)
    }

    if (stats.failedCount > 0) {
      return this.buildFailureResult('部分媒体上传失败，请检查统计和日志', dyadId, talkerId, jsonPath, stats)
    }

    return this.buildSuccessResult(dyadId, talkerId, jsonPath, stats)
  }

  private createEmptyStats(): UploadStats {
    return {
      textImportedCount: 0,
      imageUploadedCount: 0,
      voiceUploadedCount: 0,
      imageImportedCount: 0,
      voiceImportedCount: 0,
      skippedCount: 0,
      failedCount: 0
    }
  }

  private buildSuccessResult(
    dyadId: number,
    talkerId: string,
    jsonPath: string | undefined,
    stats: UploadStats
  ): NianbanExportUploadResult {
    return {
      ok: true,
      importedCount: stats.textImportedCount + stats.imageImportedCount + stats.voiceImportedCount,
      textImportedCount: stats.textImportedCount,
      imageUploadedCount: stats.imageUploadedCount,
      voiceUploadedCount: stats.voiceUploadedCount,
      imageImportedCount: stats.imageImportedCount,
      voiceImportedCount: stats.voiceImportedCount,
      skippedCount: stats.skippedCount,
      failedCount: stats.failedCount,
      dyadId: Number.isSafeInteger(dyadId) ? dyadId : 0,
      talkerId: String(talkerId || '').trim(),
      jsonPath
    }
  }

  private buildFailureResult(
    error: string,
    dyadId: number,
    talkerId: string,
    jsonPath: string | undefined,
    stats: UploadStats
  ): NianbanExportUploadResult {
    return {
      ok: false,
      importedCount: stats.textImportedCount + stats.imageImportedCount + stats.voiceImportedCount,
      textImportedCount: stats.textImportedCount,
      imageUploadedCount: stats.imageUploadedCount,
      voiceUploadedCount: stats.voiceUploadedCount,
      imageImportedCount: stats.imageImportedCount,
      voiceImportedCount: stats.voiceImportedCount,
      skippedCount: stats.skippedCount,
      failedCount: stats.failedCount,
      dyadId: Number.isSafeInteger(dyadId) ? dyadId : 0,
      talkerId: String(talkerId || '').trim(),
      jsonPath,
      error
    }
  }

  private async collectUploadableItems(
    messages: DetailedExportMessage[],
    context: {
      talkerId: string
      jsonPath: string
      outputDir?: string
    }
  ): Promise<{
    textItems: NianbanTextMessageItem[]
    mediaCandidates: UploadableMediaCandidate[]
    skippedCount: number
  }> {
    const textItems: NianbanTextMessageItem[] = []
    const mediaCandidates: UploadableMediaCandidate[] = []
    let skippedCount = 0
    let voiceFileIndex: VoiceFileIndex | null = null

    for (const message of messages) {
      if (this.isUploadableTextMessage(message)) {
        textItems.push(this.buildTextImportItem(message))
        continue
      }

      if (this.isImageMessage(message)) {
        const imagePath = await this.resolveExplicitMediaPath(message.content, context.jsonPath)
        if (!imagePath || !this.hasSupportedExtension(imagePath, this.SUPPORTED_IMAGE_EXTENSIONS)) {
          skippedCount += 1
          continue
        }
        mediaCandidates.push(this.buildMediaCandidate('image', imagePath, message))
        continue
      }

      if (this.isVoiceMessage(message)) {
        let voicePath = await this.resolveExplicitMediaPath(message.content, context.jsonPath)
        if (!voicePath) {
          if (!voiceFileIndex) {
            voiceFileIndex = await this.buildVoiceFileIndex(context.talkerId, context.jsonPath, context.outputDir)
          }
          voicePath = this.resolveVoicePathFromIndex(message, voiceFileIndex)
        }

        if (!voicePath || !this.hasSupportedExtension(voicePath, this.SUPPORTED_VOICE_EXTENSIONS)) {
          skippedCount += 1
          continue
        }

        mediaCandidates.push(this.buildMediaCandidate('voice', voicePath, message, this.extractVoiceTranscript(message.content)))
        continue
      }

      skippedCount += 1
    }

    return {
      textItems,
      mediaCandidates,
      skippedCount
    }
  }

  private buildTextImportItem(message: DetailedExportMessage): NianbanTextMessageItem {
    return {
      kind: 'text',
      role: this.toInt(message.isSend) === 1 ? 'user' : 'actor',
      text: String(message.content || ''),
      create_time: this.toInt(message.createTime),
      local_id: this.toInt(message.localId),
      local_type: this.toInt(message.localType),
      message_type_label: this.toOptionalString(message.type) || '文本消息',
      platform_message_id: this.toOptionalString(message.platformMessageId),
      sender_username: this.toOptionalString(message.senderUsername),
      sender_display_name: this.toOptionalString(message.senderDisplayName),
      sender_avatar_key: this.toOptionalString(message.senderAvatarKey),
      meta: {}
    }
  }

  private buildMediaCandidate(
    kind: 'image' | 'voice',
    filePath: string,
    message: DetailedExportMessage,
    text?: string
  ): UploadableMediaCandidate {
    return {
      kind,
      filePath,
      role: this.toInt(message.isSend) === 1 ? 'user' : 'actor',
      createTime: this.toInt(message.createTime),
      localId: this.toInt(message.localId),
      localType: this.toInt(message.localType),
      messageTypeLabel: this.toOptionalString(message.type) || (kind === 'image' ? '图片消息' : '语音消息'),
      platformMessageId: this.toOptionalString(message.platformMessageId),
      senderUsername: this.toOptionalString(message.senderUsername),
      senderDisplayName: this.toOptionalString(message.senderDisplayName),
      senderAvatarKey: this.toOptionalString(message.senderAvatarKey),
      text,
      meta: this.buildMediaMeta(message, kind)
    }
  }

  private buildMediaImportItem(
    candidate: UploadableMediaCandidate,
    assetId: NianbanAssetId
  ): NianbanMediaMessageItem {
    const item: NianbanMediaMessageItem = {
      kind: this.toApiMediaKind(candidate.kind),
      asset_id: assetId,
      role: candidate.role,
      create_time: candidate.createTime,
      local_id: candidate.localId,
      local_type: candidate.localType,
      message_type_label: candidate.messageTypeLabel,
      platform_message_id: candidate.platformMessageId,
      sender_username: candidate.senderUsername,
      sender_display_name: candidate.senderDisplayName,
      sender_avatar_key: candidate.senderAvatarKey,
      meta: candidate.meta
    }

    if (candidate.kind === 'image' && candidate.text) {
      item.text = candidate.text
    }

    return item
  }

  private buildMediaMeta(
    message: DetailedExportMessage,
    kind: UploadableMediaCandidate['kind']
  ): Record<string, unknown> {
    if (kind !== 'voice') return {}

    const durationMs = this.extractDurationMs(message)
    if (durationMs > 0) {
      return { duration_ms: durationMs }
    }
    return {}
  }

  private extractDurationMs(message: DetailedExportMessage): number {
    const candidates = [
      message.durationMs,
      message.duration_ms,
      message.voiceDurationMs,
      message.voice_duration_ms,
      message.duration,
      message.voiceDuration,
      message.voice_duration,
      message.length,
      message.voicelength
    ]

    for (const candidate of candidates) {
      const numeric = Number(candidate)
      if (!Number.isFinite(numeric) || numeric <= 0) continue
      if (numeric >= 1000) {
        return Math.floor(numeric)
      }
      return Math.floor(numeric * 1000)
    }

    return 0
  }

  private isUploadableTextMessage(message: DetailedExportMessage): boolean {
    const localType = this.toInt(message.localType)
    const typeLabel = this.toOptionalString(message.type) || ''
    const appMsgKind = this.toOptionalString(message.appMsgKind) || ''
    const text = this.toOptionalString(message.content) || ''

    if (localType !== 1 && typeLabel !== '文本消息') return false
    if (localType === 10000 || typeLabel === '系统消息') return false
    if (typeLabel === '引用消息') return false
    if (appMsgKind === 'quote' || appMsgKind === 'link') return false
    if (this.toOptionalString(message.quotedContent)) return false
    if (this.toOptionalString(message.replyToMessageId)) return false
    if (!text.trim()) return false

    return true
  }

  private isImageMessage(message: DetailedExportMessage): boolean {
    const localType = this.toInt(message.localType)
    const typeLabel = this.toOptionalString(message.type) || ''
    return localType === 3 || typeLabel === '图片消息'
  }

  private isVoiceMessage(message: DetailedExportMessage): boolean {
    const localType = this.toInt(message.localType)
    const typeLabel = this.toOptionalString(message.type) || ''
    return localType === 34 || typeLabel === '语音消息'
  }

  private extractVoiceTranscript(rawContent: unknown): string | undefined {
    const content = this.toOptionalString(rawContent)
    if (!content) return undefined
    if (this.looksLikeRelativeExportPath(content)) return undefined

    const successPrefix = '[语音转文字]'
    if (content.startsWith(successPrefix)) {
      const transcript = content.slice(successPrefix.length).trim()
      return transcript || undefined
    }
    return undefined
  }

  private async resolveExplicitMediaPath(rawContent: unknown, jsonPath: string): Promise<string | undefined> {
    const content = this.toOptionalString(rawContent)
    if (!content || !this.looksLikeRelativeExportPath(content)) {
      return undefined
    }

    const resolved = path.resolve(path.dirname(jsonPath), content.replace(/[\\/]+/g, path.sep))
    if (!await this.pathExists(resolved)) {
      return undefined
    }
    return resolved
  }

  private looksLikeRelativeExportPath(value: string): boolean {
    const normalized = String(value || '').trim()
    if (!normalized) return false
    if (/^[a-zA-Z]:[\\/]/.test(normalized)) return false
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalized)) return false
    if (normalized.startsWith('[')) return false
    if (normalized.includes('\n') || normalized.includes('\r')) return false
    return normalized.includes('/') || normalized.includes('\\')
  }

  private async buildVoiceFileIndex(
    talkerId: string,
    jsonPath: string,
    outputDir?: string
  ): Promise<VoiceFileIndex> {
    const exactKeyToPaths = new Map<string, string[]>()
    const createTimeToPaths = new Map<string, string[]>()
    const safeSessionToken = this.buildVoiceSessionToken(talkerId)
    const voiceFiles = await this.collectVoiceFiles(jsonPath, outputDir)

    for (const filePath of voiceFiles) {
      const parsed = this.parseVoiceFileInfo(filePath, safeSessionToken)
      if (!parsed) continue
      this.pushMapArray(exactKeyToPaths, `${parsed.createTime}:${parsed.serverId}`, filePath)
      this.pushMapArray(createTimeToPaths, parsed.createTime, filePath)
    }

    return {
      exactKeyToPaths,
      createTimeToPaths
    }
  }

  private resolveVoicePathFromIndex(
    message: DetailedExportMessage,
    index: VoiceFileIndex
  ): string | undefined {
    const createTime = this.normalizeUnsignedIntToken(message.createTime)
    if (createTime === '0') {
      return undefined
    }

    const platformMessageId = this.normalizeUnsignedIntToken(message.platformMessageId)
    const exactCandidates = index.exactKeyToPaths.get(`${createTime}:${platformMessageId}`)
    if (exactCandidates?.length === 1) {
      return exactCandidates[0]
    }

    const timeCandidates = index.createTimeToPaths.get(createTime)
    if (timeCandidates?.length === 1) {
      return timeCandidates[0]
    }

    return undefined
  }

  private async collectVoiceFiles(jsonPath: string, outputDir?: string): Promise<string[]> {
    const jsonDir = path.dirname(jsonPath)
    const jsonParent = path.dirname(jsonDir)
    const candidateRoots = new Set<string>()
    const addRoot = (value: string | undefined) => {
      const normalized = String(value || '').trim()
      if (normalized) {
        candidateRoots.add(path.resolve(normalized))
      }
    }

    addRoot(path.join(jsonDir, 'voices'))
    addRoot(path.join(jsonDir, 'media'))
    if (path.basename(jsonDir).toLowerCase() === 'texts') {
      addRoot(path.join(jsonParent, 'voices'))
      addRoot(path.join(jsonParent, 'media'))
    }
    if (outputDir) {
      const resolvedOutputDir = path.resolve(outputDir)
      addRoot(path.join(resolvedOutputDir, 'voices'))
      addRoot(path.join(resolvedOutputDir, 'media'))
    }

    const files: string[] = []
    for (const root of candidateRoots) {
      if (!await this.pathExists(root)) continue
      const nextFiles = await this.collectFiles(root, this.MEDIA_SCAN_MAX_DEPTH, (filePath) => {
        return this.hasSupportedExtension(filePath, this.SUPPORTED_VOICE_EXTENSIONS)
      })
      files.push(...nextFiles)
    }
    return Array.from(new Set(files))
  }

  private async collectFiles(
    rootDir: string,
    maxDepth: number,
    predicate: (filePath: string) => boolean
  ): Promise<string[]> {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }]
    const files: string[] = []

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue

      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(current.dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryPath = path.join(current.dir, entry.name)
        if (entry.isDirectory()) {
          if (current.depth < maxDepth) {
            queue.push({ dir: entryPath, depth: current.depth + 1 })
          }
          continue
        }
        if (!entry.isFile()) continue
        if (predicate(entryPath)) {
          files.push(entryPath)
        }
      }
    }

    return files
  }

  private parseVoiceFileInfo(
    filePath: string,
    safeSessionToken: string
  ): { createTime: string; serverId: string } | null {
    const ext = path.extname(filePath).toLowerCase()
    if (!this.SUPPORTED_VOICE_EXTENSIONS.has(ext)) {
      return null
    }

    const stem = path.basename(filePath, ext)
    const prefix = `voice_${safeSessionToken}_`
    if (!stem.startsWith(prefix)) {
      return null
    }

    const suffix = stem.slice(prefix.length)
    const parts = suffix.split('_')
    if (parts.length < 3) {
      return null
    }

    const serverId = this.normalizeUnsignedIntToken(parts[parts.length - 1])
    const createTime = this.normalizeUnsignedIntToken(parts[parts.length - 2])
    if (createTime === '0') {
      return null
    }

    return {
      createTime,
      serverId
    }
  }

  private buildVoiceSessionToken(talkerId: string): string {
    return this.cleanAccountDirName(talkerId)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 48) || 'session'
  }

  private cleanAccountDirName(dirName: string): string {
    const trimmed = String(dirName || '').trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      return match?.[1] || trimmed
    }
    const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
    return suffixMatch?.[1] || trimmed
  }

  private async uploadAssetForMessage(
    candidate: UploadableMediaCandidate,
    pairToken: string,
    uploadSessionUrl: string,
    completeUrl: string,
    deviceId: string
  ): Promise<{ ok: true; assetId: NianbanAssetId } | { ok: false; error: string }> {
    const mimeType = this.getMimeType(candidate.filePath, candidate.kind)
    const ext = this.normalizeUploadExtension(candidate.filePath, candidate.kind)

    let stat: Awaited<ReturnType<typeof fs.stat>>
    let buffer: Buffer
    try {
      stat = await fs.stat(candidate.filePath)
      buffer = await fs.readFile(candidate.filePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `读取${candidate.kind === 'image' ? '图片' : '语音'}文件失败: ${message}` }
    }

    const sha256Hex = createHash('sha256').update(buffer).digest('hex')

    const sessionResponse = await this.postJson(
      uploadSessionUrl,
      deviceId,
      {
        pair_token: pairToken,
        kind: this.toApiMediaKind(candidate.kind),
        ext,
        meta: candidate.meta
      },
      this.API_TIMEOUT_MS
    )
    if (!sessionResponse.ok) {
      return { ok: false, error: sessionResponse.error }
    }

    const uploadSession = this.extractCosUploadSession(sessionResponse.data)
    if (!uploadSession) {
      return { ok: false, error: '上传会话未返回可用的 COS STS 上传信息' }
    }

    const uploadResult = await this.uploadBinaryToCos(uploadSession, buffer, mimeType)
    if (!uploadResult.ok) {
      return uploadResult
    }

    const completeResponse = await this.postJson(
      completeUrl,
      deviceId,
      {
        pair_token: pairToken,
        cos_key: uploadSession.cosKey,
        kind: this.toApiMediaKind(candidate.kind),
        mime_type: mimeType,
        bytes: stat.size,
        sha256_hex: sha256Hex,
        meta: candidate.meta
      },
      this.API_TIMEOUT_MS
    )
    if (!completeResponse.ok) {
      return { ok: false, error: completeResponse.error }
    }

    const assetId = this.extractAssetId(completeResponse.data)
    if (assetId === undefined) {
      return { ok: false, error: '资产完成接口未返回 asset_id' }
    }

    return { ok: true, assetId }
  }

  private async fetchPairToken(
    pairUrl: string,
    deviceId: string,
    expectedDyadId: number
  ): Promise<{ ok: true; data: PairTokenResult } | { ok: false; error: string }> {
    const response = await this.postJson(
      pairUrl,
      deviceId,
      {
        ttl_seconds: this.PAIR_TOKEN_TTL_SECONDS
      },
      this.API_TIMEOUT_MS
    )
    if (!response.ok) {
      return response
    }

    const root = this.unwrapApiPayload(response.data)
    const pairToken = this.pickString(root, ['pair_token', 'pairToken'])
    const dyadId = this.toPositiveInteger(this.pickPrimitive(root, ['dyad_id', 'dyadId']))

    if (!pairToken) {
      return { ok: false, error: 'pair 接口未返回 pair_token' }
    }
    if (dyadId <= 0) {
      return { ok: false, error: 'pair 接口未返回有效 dyad_id' }
    }
    if (expectedDyadId > 0 && dyadId !== expectedDyadId) {
      return {
        ok: false,
        error: `pair_token 绑定的 dyad_id=${dyadId}，与目标 Dyad ID=${expectedDyadId} 不一致`
      }
    }

    return {
      ok: true,
      data: {
        pairToken,
        dyadId
      }
    }
  }

  private async importPrivateChatMessages(
    url: string,
    deviceId: string,
    talkerId: string,
    items: NianbanPrivateChatMessageItem[],
    batchSize: number
  ): Promise<{ ok: true; importedCount: number } | { ok: false; error: string }> {
    let importedCount = 0
    for (let index = 0; index < items.length; index += batchSize) {
      const batch = items.slice(index, index + batchSize)
      const response = await this.postJson(
        url,
        deviceId,
        {
          source: this.SOURCE_TAG,
          talker_id: talkerId,
          items: batch
        },
        this.API_TIMEOUT_MS
      )
      if (!response.ok) {
        return { ok: false, error: response.error }
      }
      importedCount += batch.length
    }
    return { ok: true, importedCount }
  }

  private async uploadBinaryToCos(
    uploadSession: CosUploadSession,
    buffer: Buffer,
    mimeType: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return await new Promise((resolve) => {
      const client = new CosSdk({
        SecretId: uploadSession.credentials.tmpSecretId,
        SecretKey: uploadSession.credentials.tmpSecretKey,
        SecurityToken: uploadSession.credentials.token
      })

      let settled = false
      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ ok: false, error: '上传媒体文件到 COS 超时，请稍后重试' })
      }, this.ASSET_UPLOAD_TIMEOUT_MS)

      client.putObject(
        {
          Bucket: uploadSession.bucket,
          Region: uploadSession.region,
          Key: uploadSession.cosKey,
          Body: buffer,
          ContentType: mimeType
        },
        (error, data) => {
          if (settled) return
          settled = true
          clearTimeout(timeoutId)

          if (error) {
            const message = error instanceof Error ? error.message : String(error)
            resolve({ ok: false, error: `上传媒体文件到 COS 失败: ${message}` })
            return
          }

          const statusCode = Number((data as { statusCode?: number } | undefined)?.statusCode || 200)
          if (statusCode >= 200 && statusCode < 300) {
            resolve({ ok: true })
            return
          }

          resolve({ ok: false, error: `COS 返回异常状态码: ${statusCode}` })
        }
      )
    })
  }

  private extractCosUploadSession(data: unknown): CosUploadSession | null {
    const root = this.unwrapApiPayload(data)
    const uploadNode = this.pickObject(root, ['upload'])
    if (!uploadNode) return null

    const credentialsNode = this.pickObject(uploadNode, ['credentials'])
    const pairToken = this.pickString(uploadNode, ['pair_token', 'pairToken'])
    const cosKey = this.pickString(uploadNode, ['cos_key', 'cosKey'])
    const bucket = this.pickString(uploadNode, ['bucket'])
    const region = this.pickString(uploadNode, ['region'])
    const tmpSecretId = this.pickString(credentialsNode, ['TmpSecretId', 'tmpSecretId'])
    const tmpSecretKey = this.pickString(credentialsNode, ['TmpSecretKey', 'tmpSecretKey'])
    const token = this.pickString(credentialsNode, ['Token', 'token', 'SecurityToken', 'securityToken'])
    const expiredTime = this.toPositiveInteger(this.pickPrimitive(credentialsNode, ['ExpiredTime', 'expiredTime']))

    if (!pairToken || !cosKey || !bucket || !region || !tmpSecretId || !tmpSecretKey) {
      return null
    }

    return {
      pairToken,
      cosKey,
      bucket,
      region,
      credentials: {
        tmpSecretId,
        tmpSecretKey,
        token,
        expiredTime: expiredTime > 0 ? expiredTime : undefined
      }
    }
  }

  private extractAssetId(data: unknown): NianbanAssetId | undefined {
    const root = this.unwrapApiPayload(data)
    const direct = this.pickPrimitive(root, ['asset_id', 'assetId'])
    if (direct !== undefined) return direct

    const assetNode = this.pickObject(root, ['asset'])
    const nested = this.pickPrimitive(assetNode, ['id', 'asset_id', 'assetId'])
    if (nested !== undefined) return nested

    return undefined
  }

  private unwrapApiPayload(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object') return {}
    const root = data as Record<string, unknown>
    if (root.data && typeof root.data === 'object') {
      return root.data as Record<string, unknown>
    }
    return root
  }

  private pickPrimitive(
    value: unknown,
    keys: string[]
  ): NianbanAssetId | undefined {
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    for (const key of keys) {
      const candidate = record[key]
      if (typeof candidate === 'number' || typeof candidate === 'string') {
        const normalized = typeof candidate === 'string' ? candidate.trim() : candidate
        if (normalized !== '' && normalized !== 0) {
          return normalized
        }
      }
    }
    return undefined
  }

  private pickString(value: unknown, keys: string[]): string | undefined {
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    for (const key of keys) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
    return undefined
  }

  private pickObject(value: unknown, keys: string[]): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    for (const key of keys) {
      const candidate = record[key]
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        return candidate as Record<string, unknown>
      }
    }
    return null
  }

  private pickStringRecord(
    value: unknown,
    keys: string[]
  ): Record<string, string> | null {
    const obj = this.pickObject(value, keys)
    if (!obj) return null

    const result: Record<string, string> = {}
    for (const [key, candidate] of Object.entries(obj)) {
      if (typeof candidate === 'string') {
        result[key] = candidate
      }
    }
    return Object.keys(result).length > 0 ? result : null
  }

  private getMimeType(filePath: string, kind: 'image' | 'voice'): string {
    const ext = path.extname(filePath).toLowerCase()
    if (kind === 'image') {
      switch (ext) {
        case '.png': return 'image/png'
        case '.gif': return 'image/gif'
        case '.webp': return 'image/webp'
        case '.bmp': return 'image/bmp'
        case '.jpeg':
        case '.jpg':
        default:
          return 'image/jpeg'
      }
    }

    switch (ext) {
      case '.mp3': return 'audio/mpeg'
      case '.m4a': return 'audio/mp4'
      case '.aac': return 'audio/aac'
      case '.amr': return 'audio/amr'
      case '.opus': return 'audio/ogg'
      case '.silk': return 'audio/silk'
      case '.wav':
      default:
        return 'audio/wav'
    }
  }

  private hasSupportedExtension(filePath: string, extensions: Set<string>): boolean {
    return extensions.has(path.extname(filePath).toLowerCase())
  }

  private toApiMediaKind(kind: UploadableMediaCandidate['kind']): 'image' | 'audio' {
    return kind === 'voice' ? 'audio' : 'image'
  }

  private pushMapArray(map: Map<string, string[]>, key: string, value: string): void {
    const existing = map.get(key)
    if (existing) {
      existing.push(value)
      return
    }
    map.set(key, [value])
  }

  private buildImportUrl(baseUrl: string, dyadId: number): string {
    const normalizedBase = this.normalizeBaseUrl(baseUrl)
    return new URL(`dyad/${dyadId}/import/private_chat_messages`, normalizedBase).toString()
  }

  private buildPairUrl(baseUrl: string): string {
    const normalizedBase = this.normalizeBaseUrl(baseUrl)
    return new URL('pair', normalizedBase).toString()
  }

  private buildAssetsUploadSessionUrl(baseUrl: string): string {
    const normalizedBase = this.normalizeBaseUrl(baseUrl)
    return new URL('assets/upload-session', normalizedBase).toString()
  }

  private buildAssetsCompleteUrl(baseUrl: string): string {
    const normalizedBase = this.normalizeBaseUrl(baseUrl)
    return new URL('assets/complete', normalizedBase).toString()
  }

  private normalizeBaseUrl(baseUrl: string): string {
    const withProtocol = /^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`
    return withProtocol.endsWith('/') ? withProtocol : `${withProtocol}/`
  }

  private async postJson(
    url: string,
    deviceId: string,
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const requestResult = await this.requestJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': deviceId
      },
      body: JSON.stringify(body)
    }, timeoutMs)

    if (!requestResult.ok) {
      return { ok: false, error: requestResult.error }
    }

    const apiError = this.extractApiError(requestResult.data)
    if (apiError) {
      return { ok: false, error: apiError }
    }

    return { ok: true, data: requestResult.data }
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const fetchImpl = this.getFetchImplementation()
    const AbortControllerImpl = this.getAbortControllerImplementation()
    if (!fetchImpl || !AbortControllerImpl) {
      return { ok: false, error: '当前 Electron 主进程不支持 fetch 请求' }
    }

    const controller = new AbortControllerImpl()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal
      })
      const responseText = (await response.text()).trim()
      let data: unknown = undefined
      if (responseText) {
        try {
          data = JSON.parse(responseText)
        } catch {
          data = responseText
        }
      }

      if (!response.ok) {
        const errorText = responseText
          ? `念伴后端返回 ${response.status} ${response.statusText}: ${this.truncate(responseText, 200)}`
          : `念伴后端返回 ${response.status} ${response.statusText}`
        return { ok: false, error: errorText }
      }

      return { ok: true, data }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: '请求念伴后端超时，请稍后重试' }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `请求念伴后端失败: ${message}` }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private extractApiError(data: unknown): string | undefined {
    if (typeof data === 'string') {
      const message = data.trim()
      return message || undefined
    }
    if (!data || typeof data !== 'object') {
      return undefined
    }

    const root = data as Record<string, unknown>
    const payload = this.unwrapApiPayload(data)
    const candidates = [root, payload]

    for (const candidate of candidates) {
      const okValue = candidate.ok
      if (okValue !== false) continue

      const errorMessage = this.pickString(candidate, ['error', 'message'])
      const requestId = this.pickString(candidate, ['request_id', 'requestId'])
      if (errorMessage && requestId) {
        return `${errorMessage} (request_id: ${requestId})`
      }
      if (errorMessage) {
        return errorMessage
      }
      if (requestId) {
        return `念伴后端返回错误 (request_id: ${requestId})`
      }
      return '念伴后端返回未知错误'
    }

    return undefined
  }

  private normalizeUploadExtension(filePath: string, kind: UploadableMediaCandidate['kind']): string {
    const rawExt = path.extname(filePath).toLowerCase().replace(/^\./, '')
    if (kind === 'voice') {
      switch (rawExt) {
        case 'mp3':
        case 'm4a':
        case 'wav':
        case 'aac':
          return rawExt
        case 'opus':
          return 'aac'
        case 'amr':
        case 'silk':
        default:
          return 'wav'
      }
    }

    switch (rawExt) {
      case 'png':
      case 'gif':
      case 'webp':
      case 'bmp':
      case 'jpg':
      case 'jpeg':
        return rawExt === 'jpeg' ? 'jpg' : rawExt
      default:
        return 'jpg'
    }
  }

  private toPositiveInteger(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.floor(value)
    }
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value)
      if (Number.isFinite(numeric) && numeric > 0) {
        return Math.floor(numeric)
      }
    }
    return 0
  }

  private getFetchImplementation(): typeof fetch | undefined {
    return (globalThis as typeof globalThis & { fetch?: typeof fetch }).fetch
  }

  private getAbortControllerImplementation():
  | (new () => AbortController)
  | undefined {
    return (globalThis as typeof globalThis & { AbortController?: new () => AbortController }).AbortController
  }

  private async resolveDetailedJsonPath(
    sessionId: string,
    input: {
      outputDir?: string
      jsonPath?: string
    }
  ): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
    const explicitJsonPath = String(input.jsonPath || '').trim()
    if (explicitJsonPath) {
      const normalizedJsonPath = path.resolve(explicitJsonPath)
      if (!await this.pathExists(normalizedJsonPath)) {
        return { ok: false, error: '导出 JSON 文件不存在' }
      }
      const parsed = await this.tryReadDetailedExportJson(normalizedJsonPath)
      if (!this.matchesDetailedExportForSession(parsed, sessionId)) {
        return { ok: false, error: '指定 JSON 不是当前会话的 WeFlow 导出结果' }
      }
      return { ok: true, path: normalizedJsonPath }
    }

    const normalizedOutputDir = path.resolve(String(input.outputDir || '').trim())
    if (!normalizedOutputDir || !await this.pathExists(normalizedOutputDir)) {
      return { ok: false, error: '导出结果目录不存在' }
    }

    const candidates = await this.collectRecentJsonFiles(normalizedOutputDir)
    for (const candidate of candidates) {
      const parsed = await this.tryReadDetailedExportJson(candidate.filePath)
      if (this.matchesDetailedExportForSession(parsed, sessionId)) {
        return { ok: true, path: candidate.filePath }
      }
    }

    return { ok: false, error: '未找到当前会话的详细 JSON 导出文件' }
  }

  private async readDetailedExportJson(
    filePath: string
  ): Promise<{ ok: true; data: DetailedExportFile } | { ok: false; error: string }> {
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as DetailedExportFile
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, error: '导出 JSON 结构无效' }
      }
      if (!Array.isArray(parsed.messages)) {
        return { ok: false, error: '导出 JSON 缺少 messages 列表' }
      }
      return { ok: true, data: parsed }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `JSON 解析失败: ${message}` }
    }
  }

  private async tryReadDetailedExportJson(filePath: string): Promise<DetailedExportFile | null> {
    const result = await this.readDetailedExportJson(filePath)
    return result.ok ? result.data : null
  }

  private matchesDetailedExportForSession(data: DetailedExportFile | null, sessionId: string): boolean {
    if (!data || typeof data !== 'object') return false
    if (!data.session?.wxid || !Array.isArray(data.messages)) return false
    if (Array.isArray(data.senders)) return false

    const format = this.toOptionalString(data.weflow?.format)
    if (format === 'arkme-json') return false

    return String(data.session.wxid).trim() === sessionId
  }

  private async collectRecentJsonFiles(
    rootDir: string,
    limit = 80
  ): Promise<Array<{ filePath: string; mtimeMs: number }>> {
    const queue = [rootDir]
    const files: Array<{ filePath: string; mtimeMs: number }> = []

    while (queue.length > 0) {
      const currentDir = queue.pop()
      if (!currentDir) continue

      let entries: Awaited<ReturnType<typeof fs.readdir>>
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          queue.push(entryPath)
          continue
        }
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
          continue
        }

        try {
          const stat = await fs.stat(entryPath)
          files.push({ filePath: entryPath, mtimeMs: stat.mtimeMs })
        } catch {
          continue
        }
      }
    }

    files.sort((left, right) => right.mtimeMs - left.mtimeMs)
    return files.slice(0, limit)
  }

  private isGroupSession(sessionId: string, sessionType?: string): boolean {
    if (String(sessionId || '').trim().endsWith('@chatroom')) return true
    const normalizedType = String(sessionType || '').trim().toLowerCase()
    return normalizedType === 'group' || normalizedType.includes('群')
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath)
      return true
    } catch {
      return false
    }
  }

  private toInt(value: unknown): number {
    const numeric = Math.floor(Number(value))
    return Number.isFinite(numeric) ? numeric : 0
  }

  private toOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized ? normalized : undefined
  }

  private normalizeUnsignedIntToken(raw: unknown): string {
    const text = String(raw ?? '').trim()
    if (!text) return '0'
    if (/^\d+$/.test(text)) {
      const normalized = text.replace(/^0+(?=\d)/, '')
      return normalized || '0'
    }
    const numeric = Number(text)
    if (!Number.isFinite(numeric) || numeric <= 0) return '0'
    return String(Math.floor(numeric))
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value
    return `${value.slice(0, maxLength)}...`
  }
}

export const nianbanUploadService = new NianbanUploadService()
