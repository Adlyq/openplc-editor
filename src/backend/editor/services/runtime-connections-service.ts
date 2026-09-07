/**
 * Recent runtime connections store (plaintext, `<userData>/User/History/`).
 * Modeled on the recent-projects history: a small JSON file managed by the
 * main process; passwords are stored as entered (no OS-keychain encryption
 * yet -- an adapter-level concern if we add it later).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RuntimeConnectionRecord } from '@root/middleware/shared/ports/runtime-connections-port'

export const RUNTIME_CONNECTIONS_CAP = 8

export async function readRuntimeConnections(filePath: string): Promise<RuntimeConnectionRecord[]> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (r): r is RuntimeConnectionRecord =>
          !!r &&
          typeof r.ip === 'string' &&
          typeof r.username === 'string' &&
          typeof r.password === 'string' &&
          typeof r.lastConnectedAt === 'string',
      )
      .slice(0, RUNTIME_CONNECTIONS_CAP)
  } catch {
    return []
  }
}

async function writeRuntimeConnections(filePath: string, records: RuntimeConnectionRecord[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(records, null, 2), 'utf-8')
}

/** Upsert one connection: dedupe by ip, bump to front, cap the list. */
export async function addRuntimeConnection(
  filePath: string,
  record: RuntimeConnectionRecord,
): Promise<RuntimeConnectionRecord[]> {
  if (!record || typeof record.ip !== 'string' || record.ip.trim().length === 0) {
    return readRuntimeConnections(filePath)
  }
  const ip = record.ip.trim()
  const existing = await readRuntimeConnections(filePath)
  const next = [
    { ip, username: record.username, password: record.password, lastConnectedAt: record.lastConnectedAt },
    ...existing.filter((r) => r.ip !== ip),
  ].slice(0, RUNTIME_CONNECTIONS_CAP)
  await writeRuntimeConnections(filePath, next)
  return next
}

/** Forget one connection by ip. */
export async function removeRuntimeConnection(filePath: string, ip: string): Promise<RuntimeConnectionRecord[]> {
  const next = (await readRuntimeConnections(filePath)).filter((r) => r.ip !== ip)
  await writeRuntimeConnections(filePath, next)
  return next
}
