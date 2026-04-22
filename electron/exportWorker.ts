import { parentPort, workerData } from 'worker_threads'
import { join } from 'path'
import type { ExportOptions } from './services/exportService'

interface ExportWorkerConfig {
  sessionIds: string[]
  outputDir: string
  options: ExportOptions
  dbPath?: string
  decryptKey?: string
  myWxid?: string
  resourcesPath?: string
  userDataPath?: string
  logEnabled?: boolean
}

const config = workerData as ExportWorkerConfig
process.env.WEFLOW_WORKER = '1'
if (config.resourcesPath) {
  process.env.WCDB_RESOURCES_PATH = config.resourcesPath
}
if (config.userDataPath) {
  process.env.WEFLOW_USER_DATA_PATH = config.userDataPath
  process.env.WEFLOW_CONFIG_CWD = config.userDataPath
}
process.env.WEFLOW_PROJECT_NAME = process.env.WEFLOW_PROJECT_NAME || 'WeFlow'

function sanitizeTraceId(raw: string): string {
  const normalized = String(raw || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_')
  return normalized || `export-${Date.now()}`
}

function resolveExportDebugLogPath(traceId: string, userDataPath?: string): { traceFilePath: string; latestFilePath: string } {
  const baseDir = join(String(userDataPath || process.cwd()), 'logs', 'export-media-debug')
  return {
    traceFilePath: join(baseDir, `${sanitizeTraceId(traceId)}.jsonl`),
    latestFilePath: join(baseDir, 'latest.jsonl')
  }
}

async function run() {
  const [{ wcdbService }, { exportService }, { exportCardDiagnosticsService }] = await Promise.all([
    import('./services/wcdbService'),
    import('./services/exportService'),
    import('./services/exportCardDiagnosticsService')
  ])

  const diagnosticTraceId = sanitizeTraceId(String(config.options?.diagnosticTraceId || `export-${Date.now()}`))
  const persistDiagnostics = async () => {
    const { traceFilePath, latestFilePath } = resolveExportDebugLogPath(diagnosticTraceId, config.userDataPath)
    const traceResult = await exportCardDiagnosticsService.exportCombinedLogs(traceFilePath, [])
    const latestResult = await exportCardDiagnosticsService.exportCombinedLogs(latestFilePath, [])
    return {
      diagnosticTraceId,
      diagnosticLogPath: traceResult.filePath || traceFilePath,
      diagnosticSummaryPath: traceResult.summaryPath || traceFilePath.replace(/\.jsonl$/i, '.txt'),
      latestDiagnosticLogPath: latestResult.filePath || latestFilePath,
      latestDiagnosticSummaryPath: latestResult.summaryPath || latestFilePath.replace(/\.jsonl$/i, '.txt')
    }
  }

  exportCardDiagnosticsService.clear()

  wcdbService.setPaths(config.resourcesPath || '', config.userDataPath || '')
  wcdbService.setLogEnabled(config.logEnabled === true)
  exportService.setRuntimeConfig({
    dbPath: config.dbPath,
    decryptKey: config.decryptKey,
    myWxid: config.myWxid
  })

  const result = await exportService.exportSessions(
    Array.isArray(config.sessionIds) ? config.sessionIds : [],
    String(config.outputDir || ''),
    {
      ...(config.options || { format: 'json' }),
      diagnosticTraceId
    },
    (progress) => {
      parentPort?.postMessage({
        type: 'export:progress',
        data: progress
      })
    }
  )

  const diagnostics = await persistDiagnostics()

  parentPort?.postMessage({
    type: 'export:result',
    data: {
      ...result,
      ...diagnostics
    }
  })
}

run().catch((error) => {
  Promise.resolve().then(async () => {
    try {
      const { exportCardDiagnosticsService } = await import('./services/exportCardDiagnosticsService')
      const diagnosticTraceId = sanitizeTraceId(String(config.options?.diagnosticTraceId || `export-${Date.now()}`))
      const { traceFilePath, latestFilePath } = resolveExportDebugLogPath(diagnosticTraceId, config.userDataPath)
      const traceResult = await exportCardDiagnosticsService.exportCombinedLogs(traceFilePath, [])
      const latestResult = await exportCardDiagnosticsService.exportCombinedLogs(latestFilePath, [])
      parentPort?.postMessage({
        type: 'export:result',
        data: {
          success: false,
          successCount: 0,
          failCount: 0,
          error: String(error),
          diagnosticTraceId,
          diagnosticLogPath: traceResult.filePath || traceFilePath,
          diagnosticSummaryPath: traceResult.summaryPath || traceFilePath.replace(/\.jsonl$/i, '.txt'),
          latestDiagnosticLogPath: latestResult.filePath || latestFilePath,
          latestDiagnosticSummaryPath: latestResult.summaryPath || latestFilePath.replace(/\.jsonl$/i, '.txt')
        }
      })
    } catch {
      parentPort?.postMessage({
        type: 'export:result',
        data: {
          success: false,
          successCount: 0,
          failCount: 0,
          error: String(error)
        }
      })
    }
  })
})
