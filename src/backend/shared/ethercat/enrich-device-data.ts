/**
 * EtherCAT Device Data Enrichment
 *
 * Pure functions that extract persistable data from a full ESIDevice.
 * Used when adding devices to persist channel/PDO metadata for runtime config generation.
 */

import type {
  ESIDevice,
  EtherCATChannelMapping,
  ModuleSelection,
  PersistedChannelInfo,
  PersistedModuleSlot,
  PersistedPdo,
  SDOConfigurationEntry,
} from '@root/middleware/shared/ports/esi-types'
import {
  type Cia402AxisConfig,
  DEFAULT_CIA402_AXIS_CONFIG,
  isCia402Drive,
} from '@root/middleware/shared/utils/ethercat'

import {
  deriveSlaveType,
  esiTypeToIecType,
  generateDefaultChannelMappings,
  pdoToChannels,
  persistPdos,
} from './esi-parser'
import { buildModuleCatalog, defaultModuleSelections, isModularDevice } from './module-process-image'
import { extractDefaultSdoConfigurations } from './sdo-config-defaults'

// persistPdos / deriveSlaveType now live in ./esi-parser (leaf module) so the
// module process-image builder can depend on them without a circular import.
// Re-exported here to keep existing importers working.
export { deriveSlaveType, persistPdos }

/**
 * Build persisted channel info from ESIDevice using pdoToChannels.
 * Extracts full metadata needed for runtime config generation.
 */
export function buildChannelInfo(device: ESIDevice): PersistedChannelInfo[] {
  const channels = pdoToChannels(device)
  return channels.map(
    (ch): PersistedChannelInfo => ({
      channelId: ch.id,
      name: ch.name,
      direction: ch.direction,
      pdoIndex: ch.pdoIndex,
      entryIndex: ch.entryIndex,
      entrySubIndex: ch.entrySubIndex,
      dataType: ch.dataType,
      bitLen: ch.bitLen,
      iecType: esiTypeToIecType(ch.dataType, ch.bitLen),
    }),
  )
}

/**
 * Enrich device data by extracting all persistable info from a full ESIDevice.
 * Returns fields to spread into ConfiguredEtherCATDevice.
 *
 * `usedAddresses` is the set of IEC addresses already taken by other devices
 * in the project; the generated `channelMappings` will avoid them. Pass an
 * up-to-date set when adding a device so its outputs/inputs receive valid,
 * non-conflicting IEC locations from the start (otherwise the runtime can't
 * bind them and the slave appears inert until the editor page is opened).
 */
export function enrichDeviceData(
  device: ESIDevice,
  usedAddresses?: Set<string>,
): {
  channelInfo: PersistedChannelInfo[]
  rxPdos: PersistedPdo[]
  txPdos: PersistedPdo[]
  slaveType: string
  sdoConfigurations?: SDOConfigurationEntry[]
  channelMappings: EtherCATChannelMapping[]
  cia402?: Cia402AxisConfig
  moduleSlots?: PersistedModuleSlot[]
  moduleSelections?: ModuleSelection[]
  moduleSdoConfigurations?: SDOConfigurationEntry[]
} {
  // Modular (Slot/Module) slaves have no device-level process image: the
  // channel set comes entirely from the per-slot module selection.  Every
  // slot defaults to NO-Slave (empty port); the operator assigns the real
  // modules in the device's Module Selection tab.
  if (isModularDevice(device)) {
    const moduleSlots = buildModuleCatalog(device)
    return {
      channelInfo: [],
      rxPdos: [],
      txPdos: [],
      slaveType: 'coupler',
      sdoConfigurations: device.coeObjects?.length ? extractDefaultSdoConfigurations(device.coeObjects) : undefined,
      channelMappings: [],
      moduleSlots,
      moduleSelections: defaultModuleSelections(moduleSlots),
      moduleSdoConfigurations: [],
      cia402: undefined,
    }
  }

  return {
    channelInfo: buildChannelInfo(device),
    rxPdos: persistPdos(device.rxPdo),
    txPdos: persistPdos(device.txPdo),
    slaveType: deriveSlaveType(device),
    sdoConfigurations: device.coeObjects?.length ? extractDefaultSdoConfigurations(device.coeObjects) : undefined,
    channelMappings: generateDefaultChannelMappings(pdoToChannels(device), usedAddresses),
    // A CiA 402 servo is auto-recognized as a SoftMotion axis; the user can
    // disable/tune it in the device's Axis configuration.
    cia402: isCia402Drive(device) ? { ...DEFAULT_CIA402_AXIS_CONFIG } : undefined,
  }
}
