/**
 * Recent runtime connections: IPs that connected successfully in the past,
 * together with the credentials that worked, so the Board Settings page can
 * offer one-click reconnect.  Persisted as plaintext JSON on the desktop
 * (`<userData>/User/History/runtime-connections.json`).
 */
export interface RuntimeConnectionRecord {
  ip: string
  username: string
  password: string
  lastConnectedAt: string
}

export type RuntimeConnectionsListResult =
  | { success: true; records: RuntimeConnectionRecord[] }
  | { success: false; error?: string }

export type RuntimeConnectionsMutationResult = { success: boolean; error?: string }

export interface RuntimeConnectionsPort {
  /** Read all saved connections (newest first). */
  list(): Promise<RuntimeConnectionsListResult>
  /** Upsert a connection (dedupe by ip, bump to front, cap the list). */
  add(record: RuntimeConnectionRecord): Promise<RuntimeConnectionsMutationResult>
  /** Forget a connection by ip. */
  remove(ip: string): Promise<RuntimeConnectionsMutationResult>
}
