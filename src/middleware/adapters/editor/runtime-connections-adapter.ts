import type {
  RuntimeConnectionRecord,
  RuntimeConnectionsListResult,
  RuntimeConnectionsMutationResult,
  RuntimeConnectionsPort,
} from '@root/middleware/shared/ports/runtime-connections-port'

/**
 * Desktop (Electron) adapter: recent runtime connections are persisted by the
 * main process under `<userData>/User/History/runtime-connections.json` and
 * exposed over the IPC bridge.
 */
export const runtimeConnectionsAdapter: RuntimeConnectionsPort = {
  async list(): Promise<RuntimeConnectionsListResult> {
    const result = await window.bridge.runtimeConnectionsList()
    if (!result.success) return { success: false, error: result.error }
    const records = Array.isArray(result.records) ? (result.records as RuntimeConnectionRecord[]) : []
    return { success: true, records }
  },
  async add(record: RuntimeConnectionRecord): Promise<RuntimeConnectionsMutationResult> {
    return window.bridge.runtimeConnectionsAdd(record)
  },
  async remove(ip: string): Promise<RuntimeConnectionsMutationResult> {
    return window.bridge.runtimeConnectionsRemove(ip)
  },
}
