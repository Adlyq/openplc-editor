/**
 * Modular EtherCAT slave process-image builder.
 *
 * Slot/Module based slaves (IO-Link masters, Beckhoff-style couplers, ...)
 * declare a module catalog with PDO objects whose `<Index>` values are base
 * (DependOnSlot) values.  The effective PDO/object index for a populated slot
 * is `base + slotIndex * increment` (SlotPdoIncrement / SlotIndexIncrement).
 *
 * This module turns a device + per-slot module selections into the flat
 * RxPdo/TxPdo + channel + mapping set the rest of the editor consumes -- the
 * same shape `enrichDeviceData()` produces for a flat device.  Nothing here
 * depends on the XML having been parsed a second time: the caller passes the
 * already-parsed `ESIDevice` (with `slots`/`slotLayout`/`modules`).
 */

import type {
  ESIDevice,
  ESIPdo,
  ESIPdoEntry,
  EtherCATChannelMapping,
  ModuleSelection,
  PersistedChannelInfo,
  PersistedModuleSlot,
  PersistedModuleSlotOption,
  PersistedPdo,
  SDOConfigurationEntry,
} from '@root/middleware/shared/ports/esi-types'

import {
  deriveSlaveType,
  esiTypeToIecType,
  generateDefaultChannelMappings,
  pdoToChannels,
  persistPdos,
} from './esi-parser'

/** ModuleIdent that means "no module / empty slot". */
export const NO_SLAVE_MODULE_IDENT = '0x0000'

const UINT_TYPE_BY_BYTES: Record<number, string> = { 1: 'UINT8', 2: 'UINT16', 4: 'UINT32' }

/**
 * Parse a little-endian hex byte string into a number.
 */
function littleEndianHexToInt(data: string): number {
  let value = 0
  for (let i = data.length - 2; i >= 0; i -= 2) {
    value = value * 256 + Number.parseInt(data.slice(i, i + 2), 16)
  }
  return value
}

/**
 * Convert one module CoE InitCmd into a startup SDO entry for the slot it is
 * placed in.
 *
 * The InitCmd object index is a DependOnSlot base value; the effective index
 * is `base + slotOffset * SlotIndexIncrement`.  Data bytes are little-endian
 * and only scalar widths (1/2/4 bytes) are representable as a startup SDO --
 * wider blobs (e.g. the 8-byte ISDU data buffer, always zeros) are dropped.
 *
 * @returns The SDO entry, or null when the command cannot be represented.
 */
export function moduleInitCmdToSdoEntry(
  cmd: { index: string; subIndex: string; data: string; comment: string },
  slotOffset: number,
  indexIncrement: number,
): SDOConfigurationEntry | null {
  if (cmd.data.length === 0 || cmd.data.length % 2 !== 0) return null
  let byteLen = cmd.data.length / 2
  const sub = hexIndexToInt(cmd.subIndex)

  // The gateway's 0x8000-family port config objects store PD lengths
  // (0x24/0x25) as UINT32 and Master_Control (0x28) as a word, regardless of
  // how many bytes the ESI InitCmd happened to encode.  Emit them as UINT32
  // (little-endian value preserved) to mirror what ec_op/ec_ioport write.
  const isPortConfig =
    hexIndexToInt(cmd.index) >= 0x8000 && hexIndexToInt(cmd.index) < 0x9000 &&
    (sub === 0x24 || sub === 0x25 || sub === 0x28)
  if (isPortConfig) byteLen = 4

  const dataType = UINT_TYPE_BY_BYTES[byteLen]
  if (!dataType) return null

  const comment = cmd.comment || 'Module activation'
  const value = littleEndianHexToInt(cmd.data)
  return {
    index: intToHexIndex(hexIndexToInt(cmd.index) + (indexIncrement > 0 ? slotOffset * indexIncrement : 0)),
    subIndex: sub,
    value: String(value),
    defaultValue: String(value),
    dataType,
    bitLength: byteLen * 8,
    name: comment,
    objectName: comment,
  }
}

/**
 * Startup SDOs that activate the selected modules (their CoE InitCmds),
 * ordered by slot then command.  Exported after the device-level startup SDOs
 * so activation values win over the zero defaults.
 */
export function buildModuleSdoConfigurations(
  device: Pick<ESIDevice, 'slots' | 'slotLayout' | 'modules'>,
  selections: ModuleSelection[],
): SDOConfigurationEntry[] {
  if (!isModularDevice(device)) return []

  const slots = device.slots ?? []
  const modules = device.modules ?? []
  const layout = device.slotLayout ?? { pdoIncrement: 0, indexIncrement: 0 }

  const sdos: SDOConfigurationEntry[] = []
  slots.forEach((slot, slotOffset) => {
    const selection = selections.find((s) => s.slotName === slot.name)
    if (!selection || hexIndexToInt(selection.moduleIdent) === 0) return
    const moduleDef = modules.find((m) => m.ident === selection.moduleIdent)
    if (!moduleDef) return
    for (const cmd of moduleDef.initCmds ?? []) {
      const entry = moduleInitCmdToSdoEntry(cmd, slotOffset, layout.indexIncrement)
      if (entry) sdos.push(entry)
    }
    // Class-A power-on for the physical port this slot belongs to
    // (Senmun layout: 8 ports x 4 cascade levels, port = slotIndex >> 2).
    sdos.push({
      index: '0x3000',
      subIndex: (slotOffset >> 2) + 1,
      value: '2',
      defaultValue: '2',
      dataType: 'UINT16',
      bitLength: 16,
      name: 'Class A Power Control',
      objectName: 'Class A Power Control',
    })
  })
  return sdos
}

/** Parse a hex object index ("0x1690" / "#x1690") to an integer. */
function hexIndexToInt(index: string): number {
  const cleaned = index.replace(/^#x/i, '0x').replace(/^0x/i, '')
  const parsed = Number.parseInt(cleaned, 16)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Format an integer back into the "0x..." index convention used elsewhere. */
function intToHexIndex(value: number): string {
  return `0x${value.toString(16)}`
}

function offsetIndex(index: string, slotOffset: number, increment: number): string {
  // Always emit the canonical lower-case form so every slot's indexes compare
  // equal regardless of how the ESI author wrote them ("#x1A90" vs "0x1a90").
  const base = hexIndexToInt(index)
  return intToHexIndex(base + (increment > 0 ? slotOffset * increment : 0))
}

/** True when the ESI device is a Slot/Module based (modular) slave. */
export function isModularDevice(device: Pick<ESIDevice, 'slots'>): boolean {
  return device.slots !== undefined && device.slots.length > 0
}

/**
 * Build the aggregated process image for the given module selections.
 *
 * Slots are processed in ESI order (slot offset = index in `device.slots`).
 * Slots with no selection or a NO-Slave module contribute no PDO.  PDO object
 * indexes and entry object indexes are shifted by the slot offset using the
 * device's SlotPdoIncrement / SlotIndexIncrement.
 *
 * @returns The flat `{ rxPdo, txPdo }` lists ready for `persistPdos`/channel
 *          generation.  Returns the device-level PDOs unchanged when the
 *          device is not modular.
 */
export function buildModuleProcessImage(
  device: Pick<ESIDevice, 'slots' | 'slotLayout' | 'modules' | 'rxPdo' | 'txPdo'>,
  selections: ModuleSelection[],
): { rxPdo: ESIPdo[]; txPdo: ESIPdo[] } {
  if (!isModularDevice(device)) {
    return { rxPdo: device.rxPdo, txPdo: device.txPdo }
  }

  const slots = device.slots ?? []
  const modules = device.modules ?? []
  const layout = device.slotLayout ?? { pdoIncrement: 0, indexIncrement: 0 }

  const rxPdo: ESIPdo[] = []
  const txPdo: ESIPdo[] = []

  // The coupler's own fixed PDO objects (PDI/CQ pins, per-port status) are
  // always present and drive the base process image -- the same objects a
  // flat export assigns.  Module PD PDOs (0x1690/0x1A90 family) stack on top
  // once the module is actually started by the vendor master.  Keep both in
  // the assignment so the master can reach OPERATIONAL on the fixed image
  // even while the module objects are still unpopulated placeholders.
  const seenRx = new Set<string>()
  const seenTx = new Set<string>()
  for (const pdo of device.rxPdo) {
    if (!seenRx.has(pdo.index)) {
      seenRx.add(pdo.index)
      rxPdo.push(pdo)
    }
  }
  for (const pdo of device.txPdo) {
    if (!seenTx.has(pdo.index)) {
      seenTx.add(pdo.index)
      txPdo.push(pdo)
    }
  }

  const shiftPdo = (pdo: ESIPdo, slotOffset: number): ESIPdo => {
    const entries: ESIPdoEntry[] = pdo.entries.map((entry) => ({
      ...entry,
      index: offsetIndex(entry.index, slotOffset, layout.indexIncrement),
    }))
    return {
      ...pdo,
      index: offsetIndex(pdo.index, slotOffset, layout.pdoIncrement),
      entries,
    }
  }

  slots.forEach((slot, slotOffset) => {
    const selection = selections.find((s) => s.slotName === slot.name)
    if (!selection || hexIndexToInt(selection.moduleIdent) === 0) return

    const moduleDef = modules.find((m) => m.ident === selection.moduleIdent)
    if (!moduleDef) return

    for (const pdo of moduleDef.rxPdos) rxPdo.push(shiftPdo(pdo, slotOffset))
    for (const pdo of moduleDef.txPdos) txPdo.push(shiftPdo(pdo, slotOffset))
  })

  return { rxPdo, txPdo }
}

function moduleByteSize(pdos: ESIPdo[]): number {
  let totalBits = 0
  for (const pdo of pdos) {
    for (const entry of pdo.entries) {
      totalBits += entry.bitLen
    }
  }
  return Math.ceil(totalBits / 8)
}

/**
 * Build the persisted compact slot catalog for a modular device.
 *
 * The catalog (slot name + selectable modules with their byte sizes) is what
 * gets stored on `ConfiguredEtherCATDevice.moduleSlots`, so the module picker
 * and the "must be configured" gate work without the ESI file.
 */
export function buildModuleCatalog(device: Pick<ESIDevice, 'slots' | 'modules'>): PersistedModuleSlot[] {
  const slots = device.slots ?? []
  const modules = device.modules ?? []

  return slots.map((slot): PersistedModuleSlot => {
    const options: PersistedModuleSlotOption[] = []

    // An explicit "nothing here" choice, present even when the ESI catalog
    // omits the NO-Slave module (it usually ships one).
    options.push({
      ident: NO_SLAVE_MODULE_IDENT,
      name: 'NO-Slave',
      inputBytes: 0,
      outputBytes: 0,
    })

    for (const ident of slot.moduleIdents) {
      // The NO-Slave option was already added above.
      if (hexIndexToInt(ident) === 0) continue
      const moduleDef = modules.find((m) => m.ident === ident)
      if (!moduleDef) continue
      options.push({
        ident: moduleDef.ident,
        name: moduleDef.name,
        inputBytes: moduleByteSize(moduleDef.txPdos),
        outputBytes: moduleByteSize(moduleDef.rxPdos),
      })
    }

    return { name: slot.name, options }
  })
}

/**
 * Build the default module selections for a slot catalog: every slot set to
 * NO-Slave.  Newly added (or newly migrated) modular slaves start with all
 * ports empty -- the operator then assigns the modules actually fitted.  This
 * keeps the device "complete" (compilable with an intentionally empty process
 * image) instead of trapping it in an unconfigured state.
 */
export function defaultModuleSelections(moduleSlots: PersistedModuleSlot[] | undefined): ModuleSelection[] {
  if (!moduleSlots) return []
  return moduleSlots.map((slot) => ({ slotName: slot.name, moduleIdent: NO_SLAVE_MODULE_IDENT }))
}

/**
 * A modular device is configured when every slot has an explicit selection
 * (an assigned module, or a deliberate NO-Slave).  An empty selection list is
 * the "just added, choose your modules" state.
 */
export function isModuleSelectionComplete(
  moduleSlots: PersistedModuleSlot[] | undefined,
  selections: ModuleSelection[] | undefined,
): boolean {
  if (!moduleSlots || moduleSlots.length === 0) return true
  return moduleSlots.every((slot) => selections?.some((s) => s.slotName === slot.name) ?? false)
}

/**
 * Names of modular slaves that are not yet fully configured.
 *
 * Compile-time gate input: a modular device with an empty or partial module
 * selection has an intentionally empty process image and must not be sent to
 * the runtime silently.  Returns human-readable errors listing every slave
 * the operator still has to configure.
 */
export function listUnconfiguredModuleDevices(
  devices: ReadonlyArray<{
    name: string
    moduleSlots?: PersistedModuleSlot[]
    moduleSelections?: ModuleSelection[]
  }>,
): string[] {
  const errors: string[] = []
  for (const device of devices) {
    const slots = device.moduleSlots
    if (!slots || slots.length === 0) continue
    if (!isModuleSelectionComplete(slots, device.moduleSelections)) {
      errors.push(
        `EtherCAT slave '${device.name}' requires a module selection (assign a module or 'NO-Slave' to every port)`,
      )
    }
  }
  return errors
}

/**
 * Build all persistable fields for a modular device given its module
 * selections: flattened channelInfo/rxPdos/txPdos/channelMappings plus the
 * updated slot catalog and selections.
 *
 * Mirrors `enrichDeviceData()` (flat devices) and is what the module picker
 * calls when the user changes a slot assignment.
 */
export function buildModuleEnrich(
  device: Pick<ESIDevice, 'slots' | 'slotLayout' | 'modules' | 'rxPdo' | 'txPdo'>,
  selections: ModuleSelection[],
  usedAddresses?: Set<string>,
): {
  channelInfo: PersistedChannelInfo[]
  rxPdos: PersistedPdo[]
  txPdos: PersistedPdo[]
  slaveType: string
  channelMappings: EtherCATChannelMapping[]
  moduleSlots?: PersistedModuleSlot[]
  moduleSelections?: ModuleSelection[]
  moduleSdoConfigurations?: SDOConfigurationEntry[]
} {
  const image = buildModuleProcessImage(device, selections)
  const channels = pdoToChannels({ rxPdo: image.rxPdo, txPdo: image.txPdo })

  const channelInfo: PersistedChannelInfo[] = channels.map((ch) => ({
    channelId: ch.id,
    name: ch.name,
    direction: ch.direction,
    pdoIndex: ch.pdoIndex,
    entryIndex: ch.entryIndex,
    entrySubIndex: ch.entrySubIndex,
    dataType: ch.dataType,
    bitLen: ch.bitLen,
    iecType: esiTypeToIecType(ch.dataType, ch.bitLen),
  }))

  return {
    channelInfo,
    rxPdos: persistPdos(image.rxPdo),
    txPdos: persistPdos(image.txPdo),
    slaveType: deriveSlaveType({ rxPdo: image.rxPdo, txPdo: image.txPdo }),
    channelMappings: generateDefaultChannelMappings(channels, usedAddresses),
    moduleSlots: isModularDevice(device) ? buildModuleCatalog(device) : undefined,
    moduleSelections: isModularDevice(device) ? selections : undefined,
    moduleSdoConfigurations: buildModuleSdoConfigurations(device, selections),
  }
}
