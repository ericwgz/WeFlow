import * as fs from 'fs/promises'
import * as path from 'path'

interface DetailedExportSession {
  wxid?: string
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
}

interface NianbanPrivateChatMessageItem {
  kind: 'text'
  role: 'user' | 'actor'
  text: string
  create_time: number
  local_id: number
  local_type: number
  message_type_label: string
  platform_message_id?: string
  sender_username?: string
  sender_display_name?: string
  sender_avatar_key?: string
  meta: Record<string, never>
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
  skippedCount: number
  dyadId: number
  talkerId: string
  jsonPath?: string
  error?: string
}

class NianbanUploadService {
  async uploadExportedChatToNianban(
    payload: NianbanExportUploadPayload
  ): Promise<NianbanExportUploadResult> {
    const sessionId = String(payload.sessionId || '').trim()
    const outputDir = String(payload.outputDir || '').trim()
    const explicitJsonPath = String(payload.jsonPath || '').trim()
    const baseUrl = String(payload.baseUrl || '').trim()
    const deviceId = String(payload.deviceId || '').trim()
    const dyadId = Math.floor(Number(payload.dyadId || 0))

    if (!sessionId) {
      return this.buildFailureResult('会话 ID 不能为空', dyadId, '')
    }
    if (!outputDir && !explicitJsonPath) {
      return this.buildFailureResult('导出 JSON 文件路径或输出目录不能为空', dyadId, sessionId)
    }
    if (!baseUrl) {
      return this.buildFailureResult('念伴后端地址不能为空', dyadId, sessionId)
    }
    if (!deviceId) {
      return this.buildFailureResult('X-Device-Id 不能为空', dyadId, sessionId)
    }
    if (!Number.isSafeInteger(dyadId) || dyadId <= 0) {
      return this.buildFailureResult('目标 Dyad ID 必须是正整数', dyadId, sessionId)
    }

    const jsonPathResult = await this.resolveDetailedJsonPath(sessionId, {
      outputDir,
      jsonPath: explicitJsonPath
    })
    if (!jsonPathResult.ok) {
      return this.buildFailureResult(jsonPathResult.error, dyadId, sessionId)
    }

    const jsonPath = jsonPathResult.path
    const readResult = await this.readDetailedExportJson(jsonPath)
    if (!readResult.ok) {
      return this.buildFailureResult(readResult.error, dyadId, sessionId, jsonPath)
    }

    const talkerId = String(readResult.data.session?.wxid || sessionId).trim() || sessionId
    const messages = Array.isArray(readResult.data.messages) ? readResult.data.messages : []
    const { items, skippedCount } = this.extractUploadableTextMessages(messages)

    if (items.length === 0) {
      return this.buildFailureResult('没有可上传的文本消息', dyadId, talkerId, jsonPath, skippedCount)
    }

    let requestUrl: string
    try {
      requestUrl = this.buildImportUrl(baseUrl, dyadId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.buildFailureResult(`念伴后端地址无效: ${message}`, dyadId, talkerId, jsonPath, skippedCount)
    }

    const requestBody = {
      source: 'weflow-export-v1',
      talker_id: talkerId,
      items
    }

    const uploadResult = await this.postPrivateChatMessages(requestUrl, deviceId, requestBody)
    if (!uploadResult.ok) {
      return this.buildFailureResult(uploadResult.error, dyadId, talkerId, jsonPath, skippedCount)
    }

    return {
      ok: true,
      importedCount: items.length,
      skippedCount,
      dyadId,
      talkerId,
      jsonPath
    }
  }

  private buildFailureResult(
    error: string,
    dyadId: number,
    talkerId: string,
    jsonPath?: string,
    skippedCount = 0
  ): NianbanExportUploadResult {
    return {
      ok: false,
      importedCount: 0,
      skippedCount,
      dyadId: Number.isSafeInteger(dyadId) ? dyadId : 0,
      talkerId: String(talkerId || '').trim(),
      jsonPath,
      error
    }
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
        return { ok: false, error: '指定的导出 JSON 不可用于念伴上传' }
      }
      return { ok: true, path: normalizedJsonPath }
    }

    const normalizedOutputDir = path.resolve(String(input.outputDir || '').trim())
    if (!normalizedOutputDir || !await this.pathExists(normalizedOutputDir)) {
      return { ok: false, error: '导出 JSON 文件不存在' }
    }

    const candidates = await this.collectRecentJsonFiles(normalizedOutputDir)
    for (const candidate of candidates) {
      const parsed = await this.tryReadDetailedExportJson(candidate.filePath)
      if (this.matchesDetailedExportForSession(parsed, sessionId)) {
        return { ok: true, path: candidate.filePath }
      }
    }

    return { ok: false, error: '导出 JSON 文件不存在' }
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
        return { ok: false, error: '导出 JSON 中缺少消息列表' }
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

  private extractUploadableTextMessages(messages: DetailedExportMessage[]): {
    items: NianbanPrivateChatMessageItem[]
    skippedCount: number
  } {
    const items: NianbanPrivateChatMessageItem[] = []
    let skippedCount = 0

    for (const message of messages) {
      if (!this.isUploadableTextMessage(message)) {
        skippedCount += 1
        continue
      }

      items.push({
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
      })
    }

    return { items, skippedCount }
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

  private buildImportUrl(baseUrl: string, dyadId: number): string {
    const withProtocol = /^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`
    const normalizedBase = withProtocol.endsWith('/') ? withProtocol : `${withProtocol}/`
    return new URL(`dyad/${dyadId}/import/private_chat_messages`, normalizedBase).toString()
  }

  private async postPrivateChatMessages(
    url: string,
    deviceId: string,
    body: {
      source: string
      talker_id: string
      items: NianbanPrivateChatMessageItem[]
    }
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const fetchImpl = (globalThis as { fetch?: (input: string, init?: Record<string, unknown>) => Promise<any> }).fetch
    const AbortControllerImpl = (globalThis as { AbortController?: new () => { abort: () => void; signal: unknown } }).AbortController
    if (!fetchImpl || !AbortControllerImpl) {
      return { ok: false, error: '当前 Electron 主进程不支持 fetch 上传' }
    }

    const controller = new AbortControllerImpl()
    const timeoutId = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': deviceId
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })

      if (!response.ok) {
        const responseText = (await response.text()).trim()
        const errorText = responseText
          ? `念伴后端返回 ${response.status} ${response.statusText}: ${this.truncate(responseText, 200)}`
          : `念伴后端返回 ${response.status} ${response.statusText}`
        return { ok: false, error: errorText }
      }

      return { ok: true }
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

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value
    return `${value.slice(0, maxLength)}...`
  }
}

export const nianbanUploadService = new NianbanUploadService()
