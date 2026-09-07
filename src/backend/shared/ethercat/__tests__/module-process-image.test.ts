// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { SDOConfigurationEntry } from '@root/middleware/shared/ports/esi-types'
import { parseESIDeviceFull } from '../esi-parser-main'
import { enrichDeviceData } from '../enrich-device-data'
import { persistedPdosToChannels } from '../esi-parser'
import {
  buildModuleCatalog,
  buildModuleEnrich,
  buildModuleProcessImage,
  buildModuleSdoConfigurations,
  defaultModuleSelections,
  isModularDevice,
  isModuleSelectionComplete,
  listUnconfiguredModuleDevices,
  mergeModuleSdoRows,
  moduleInitCmdToSdoEntry,
  NO_SLAVE_MODULE_IDENT,
} from '../module-process-image'

const ESI_XML = readFileSync(resolve(__dirname, 'fixtures/modular-iologlink-esi.xml'), 'utf-8')

function parseDevice() {
  const result = parseESIDeviceFull(ESI_XML, 0)
  if (!result.success || !result.device) {
    throw new Error(`fixture failed to parse: ${result.error}`)
  }
  return result.device
}

describe('parseESIDeviceFull (modular slave)', () => {
  const device = parseDevice()

  it('parses slots and the slot layout', () => {
    expect(device.slots).toHaveLength(2)
    expect(device.slots?.[0].name).toContain('IO-Link Port 1')
    expect(device.slots?.[1].name).toContain('IO-Link Port 2')
    expect(device.slots?.[0].moduleIdents).toEqual([NO_SLAVE_MODULE_IDENT, '0x2c01'])
    expect(device.slotLayout).toEqual({ pdoIncrement: 1, indexIncrement: 16 })
  })

  it('parses the referenced module catalog with base PDO indexes', () => {
    expect(device.modules).toHaveLength(2)
    const iol = device.modules?.find((m) => m.ident === '0x2c01')
    expect(iol?.name).toBe('IOL_I/O_02/02 byte')
    expect(iol?.rxPdos[0].index).toBe('0x1690')
    expect(iol?.rxPdos[0].entries[0].index).toBe('0x7000')
    expect(iol?.rxPdos[0].entries[0].bitLen).toBe(16)
    expect(iol?.txPdos[0].index).toBe('0x1A90')
    expect(iol?.txPdos[0].entries[0].index).toBe('0x6000')
  })

  it('parses the module CoE activation InitCmds', () => {
    const iol = device.modules?.find((m) => m.ident === '0x2c01')
    expect(iol?.initCmds).toHaveLength(3)
    const pdOut = iol?.initCmds?.find((c) => c.subIndex === '0x25')
    expect(pdOut).toMatchObject({ index: '0x8000', data: '0200', comment: 'Set Process Data Out Length' })
  })
})

describe('moduleInitCmdToSdoEntry / buildModuleSdoConfigurations', () => {
  const device = parseDevice()

  it('converts a LE 2-byte InitCmd to a UINT32 startup SDO (port config subs are 4-byte)', () => {
    const entry = moduleInitCmdToSdoEntry(
      { index: '0x8000', subIndex: '0x25', data: '0200', comment: 'PD Out Length' },
      0,
      16,
    )
    expect(entry).toMatchObject({
      index: '0x8000',
      subIndex: 0x25,
      value: '2',
      dataType: 'UINT32',
      bitLength: 32,
      applyAfterOperational: true,
    })
  })

  it('offsets the object index per slot', () => {
    const entry = moduleInitCmdToSdoEntry(
      { index: '0x8000', subIndex: '0x24', data: '0200', comment: 'PD In Length' },
      1,
      16,
    )
    expect(entry?.index).toBe('0x8010')
    expect(entry?.applyAfterOperational).toBe(true)
  })

  it('drops non-scalar blobs (wider than 4 bytes)', () => {
    // The 8-byte ISDU data buffer is not representable as a scalar startup
    // SDO, so it is dropped (matching the original runtime's write model).
    expect(
      moduleInitCmdToSdoEntry(
        { index: '0x2002', subIndex: '0x04', data: '0000000000000000', comment: 'ISDU Data' },
        0,
        16,
      ),
    ).toBeNull()
    expect(
      moduleInitCmdToSdoEntry(
        { index: '0x2002', subIndex: '0x04', data: '00000000000000000000000000000000', comment: '' },
        0,
        16,
      ),
    ).toBeNull()
  })

  it('collects module rows (with metadata) plus one Class-A power per port', () => {
    const selections = device.slots!.map((s) => ({ slotName: s.name, moduleIdent: '0x2c01' }))
    const sdos = buildModuleSdoConfigurations(device, selections)
    // Per slot: PD in + PD out = 2 scalar rows; x2 slots + a single Class-A
    // power row for the port the two fixture slots share.
    expect(sdos).toHaveLength(5)
    // Every row is tagged so overrides can be preserved across reselects.
    expect(sdos.every((s) => s.moduleSlot && s.moduleIdent === '0x2c01')).toBe(true)
    // The port power row appears once and is flagged for post-OP replay.
    const powerRows = sdos.filter((s) => s.index === '0x3000')
    expect(powerRows).toHaveLength(1)
    expect(powerRows[0]).toMatchObject({ subIndex: 1, value: '2', applyAfterOperational: true })
    // PD length rows are flagged for post-OP replay (slot 1 indexes offset by
    // the SlotIndexIncrement); nothing else is flagged.
    expect(
      sdos
        .filter((s) => s.applyAfterOperational)
        .map((s) => s.index)
        .sort(),
    ).toEqual(['0x3000', '0x8000', '0x8000', '0x8010', '0x8010'])
  })

  it('yields no rows for NO-Slave / empty selections', () => {
    expect(buildModuleSdoConfigurations(device, [])).toEqual([])
    const noSlave = device.slots!.map((s) => ({ slotName: s.name, moduleIdent: NO_SLAVE_MODULE_IDENT }))
    expect(buildModuleSdoConfigurations(device, noSlave)).toEqual([])
  })
})

describe('buildModuleEnrich startup parameters (dictionary overlaid with module rows)', () => {
  const device = parseDevice()
  const dictRow = (index: string, subIndex = 1): SDOConfigurationEntry => ({
    index,
    subIndex,
    value: '5',
    defaultValue: '5',
    dataType: 'UINT8',
    bitLength: 8,
    name: 'param',
    objectName: 'EherCAT OffLine Config',
  })
  const selections = device.slots!.map((s) => ({ slotName: s.name, moduleIdent: '0x2c01' }))

  it('keeps the full dictionary rows and overlays module rows for populated slots', () => {
    const enriched = buildModuleEnrich(device, selections, undefined, [dictRow('0x2000'), dictRow('0x8000', 99)])
    // Dictionary rows are always present (nothing hidden)...
    const keys = enriched.sdoConfigurations.map((e) => `${e.index}:${e.subIndex}`)
    expect(keys).toContain('0x2000:1')
    expect(keys).toContain('0x8000:99')
    // ...and module InitCmd rows are merged in so their values are visible.
    const moduleRows = enriched.sdoConfigurations.filter((e) => e.moduleSlot)
    expect(moduleRows.length).toBeGreaterThan(0)
    expect(moduleRows.every((e) => e.moduleIdent === '0x2c01')).toBe(true)
    // Single source: the legacy moduleSdoConfigurations field is cleared.
    expect(enriched.moduleSdoConfigurations).toBeUndefined()
  })

  it('module rows win over dictionary rows sharing the same object entry', () => {
    const enriched = buildModuleEnrich(device, selections, undefined, [dictRow('0x8000', 0x24)])
    const entry = enriched.sdoConfigurations.find((e) => e.index === '0x8000' && e.subIndex === 0x24)
    expect(entry?.moduleSlot).toBeTruthy()
    const keys = enriched.sdoConfigurations.map((e) => `${e.index}:${e.subIndex}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('mergeModuleSdoRows', () => {
  const base = (index: string, value = '0', subIndex = 1): SDOConfigurationEntry => ({
    index,
    subIndex,
    value,
    defaultValue: '0',
    dataType: 'UINT8',
    bitLength: 8,
    name: 'p',
    objectName: 'parent',
  })

  it('keeps dictionary rows and lets a later module row override the same entry', () => {
    const merged = mergeModuleSdoRows(
      [base('0x2000'), base('0x8000', '0')],
      [{ ...base('0x8000', '2', 1), moduleSlot: 'Port1', moduleIdent: '0x2c01' }],
    )
    expect(merged.map((e) => `${e.index}:${e.subIndex}=${e.value}`)).toEqual(['0x2000:1=0', '0x8000:1=2'])
  })

  it('sorts rows by object index then subindex', () => {
    const merged = mergeModuleSdoRows(undefined, [
      { ...base('0x8000', '3', 40), moduleSlot: 'P1' },
      { ...base('0x3000', '2', 2), moduleSlot: 'P1' },
      { ...base('0x2002', '1', 1), moduleSlot: 'P1' },
      { ...base('0x8000', '2', 36), moduleSlot: 'P1' },
    ])
    expect(merged.map((e) => `${e.index}:${e.subIndex}`)).toEqual(['0x2002:1', '0x3000:2', '0x8000:36', '0x8000:40'])
  })

  it('handles a missing dictionary list', () => {
    expect(mergeModuleSdoRows(undefined, [base('0x3000')])).toHaveLength(1)
    expect(mergeModuleSdoRows([], [])).toEqual([])
  })
})

describe('isModularDevice', () => {
  const device = parseDevice()

  it('is true for a device with slots', () => {
    expect(isModularDevice(device)).toBe(true)
  })

  it('is false for a device without slots', () => {
    expect(isModularDevice({ slots: undefined })).toBe(false)
    expect(isModularDevice({ slots: [] })).toBe(false)
  })
})

describe('buildModuleProcessImage', () => {
  const device = parseDevice()

  const both = [
    { slotName: device.slots![0].name, moduleIdent: '0x2c01' },
    { slotName: device.slots![1].name, moduleIdent: '0x2c01' },
  ]

  it('returns device-level PDOs unchanged for non-modular devices', () => {
    const pdo = { index: '0x1a00', name: 'In', fixed: false, mandatory: false, entries: [] }
    const image = buildModuleProcessImage({ rxPdo: [pdo], txPdo: [] }, [])
    expect(image.rxPdo).toEqual([pdo])
  })

  it('offsets PDO and entry indexes per slot', () => {
    const image = buildModuleProcessImage(device, both)
    expect(image.rxPdo.map((p) => p.index)).toEqual(['0x1690', '0x1691'])
    expect(image.rxPdo[0].entries[0].index).toBe('0x7000')
    expect(image.rxPdo[1].entries[0].index).toBe('0x7010')
    expect(image.txPdo.map((p) => p.index)).toEqual(['0x1a90', '0x1a91'])
    expect(image.txPdo[1].entries[0].index).toBe('0x6010')
  })

  it('omits slots without a selection', () => {
    const image = buildModuleProcessImage(device, [both[0]])
    expect(image.rxPdo).toHaveLength(1)
    expect(image.txPdo).toHaveLength(1)
  })

  it('omits slots explicitly set to NO-Slave', () => {
    const image = buildModuleProcessImage(device, [
      { slotName: device.slots![0].name, moduleIdent: NO_SLAVE_MODULE_IDENT },
      both[1],
    ])
    expect(image.rxPdo.map((p) => p.index)).toEqual(['0x1691'])
  })

  it('omits slots whose module is not in the catalog', () => {
    const image = buildModuleProcessImage(device, [{ slotName: device.slots![0].name, moduleIdent: '0x9999' }])
    expect(image.rxPdo).toHaveLength(0)
  })

  it('keeps the coupler fixed PDOs alongside the module PDOs', () => {
    const composite = buildModuleProcessImage(
      {
        ...device,
        rxPdo: [{ index: '0x1680', name: 'Fixed Out', fixed: false, mandatory: false, entries: [] }],
        txPdo: [{ index: '0x1a80', name: 'Fixed In', fixed: false, mandatory: false, entries: [] }],
      },
      [both[0]],
    )
    expect(composite.rxPdo.map((p) => p.index)).toEqual(['0x1680', '0x1690'])
    expect(composite.txPdo.map((p) => p.index)).toEqual(['0x1a80', '0x1a90'])
  })
})

describe('buildModuleCatalog', () => {
  const device = parseDevice()

  it('adds a NO-Slave option and byte sizes per module', () => {
    const catalog = buildModuleCatalog(device)
    expect(catalog).toHaveLength(2)
    expect(catalog[0].options[0]).toEqual({
      ident: NO_SLAVE_MODULE_IDENT,
      name: 'NO-Slave',
      inputBytes: 0,
      outputBytes: 0,
    })
    expect(catalog[0].options[1]).toMatchObject({ ident: '0x2c01', inputBytes: 2, outputBytes: 2 })
  })

  it('is empty for non-modular devices', () => {
    expect(buildModuleCatalog({ slots: undefined, modules: undefined })).toEqual([])
  })
})

describe('isModuleSelectionComplete', () => {
  const slots = [
    { name: 'Port 1', options: [] },
    { name: 'Port 2', options: [] },
  ]

  it('is true when no module slots exist', () => {
    expect(isModuleSelectionComplete(undefined, undefined)).toBe(true)
    expect(isModuleSelectionComplete([], [])).toBe(true)
  })

  it('is false when a slot has no selection', () => {
    expect(isModuleSelectionComplete(slots, [{ slotName: 'Port 1', moduleIdent: '0x2c01' }])).toBe(false)
    expect(isModuleSelectionComplete(slots, [])).toBe(false)
  })

  it('is true when every slot has a selection', () => {
    const all = slots.map((s) => ({ slotName: s.name, moduleIdent: '0x2c01' }))
    expect(isModuleSelectionComplete(slots, all)).toBe(true)
  })
})

describe('listUnconfiguredModuleDevices', () => {
  const slots = [
    { name: 'Port 1', options: [] },
    { name: 'Port 2', options: [] },
  ]

  it('reports modular slaves without a complete selection', () => {
    const names = listUnconfiguredModuleDevices([
      { name: 'bus1', moduleSlots: slots, moduleSelections: [{ slotName: 'Port 1', moduleIdent: '0x2c01' }] },
      { name: 'bus2', moduleSlots: slots },
      { name: 'flat', moduleSlots: undefined },
    ])
    expect(names).toHaveLength(2)
    expect(names[0]).toContain("'bus1'")
    expect(names[1]).toContain("'bus2'")
  })

  it('is clean when every slot is selected (incl. deliberate NO-Slave)', () => {
    const all = slots.map((s) => ({ slotName: s.name, moduleIdent: NO_SLAVE_MODULE_IDENT }))
    expect(listUnconfiguredModuleDevices([{ name: 'bus', moduleSlots: slots, moduleSelections: all }])).toEqual([])
  })
})

describe('persistedPdosToChannels', () => {
  const device = parseDevice()
  const selections = device.slots!.map((s) => ({ slotName: s.name, moduleIdent: '0x2c01' }))

  it('reconstructs the same channels that were persisted for the selection', () => {
    const enriched = buildModuleEnrich(device, selections)
    const rebuilt = persistedPdosToChannels(enriched.rxPdos, enriched.txPdos)
    expect(rebuilt).toHaveLength(enriched.channelInfo.length)
    expect(rebuilt.map((c) => c.id).sort()).toEqual(enriched.channelInfo.map((c) => c.channelId).sort())
    expect(rebuilt.map((c) => c.iecType)).toEqual(enriched.channelInfo.map((c) => c.iecType))
    expect(rebuilt.map((c) => c.direction)).toEqual(enriched.channelInfo.map((c) => c.direction))
  })

  it('excludes fixed coupler PDOs from the channel list', () => {
    const fixedTx = {
      index: '0x1a80',
      name: 'CQ status',
      fixed: true,
      entries: [{ index: '0xb080', subIndex: '0x01', bitLen: 1, name: 'CQ Bit', dataType: 'BOOL' }],
    }
    const moduleTx = {
      index: '0x1a90',
      name: 'PD In',
      fixed: false,
      entries: [{ index: '0x6000', subIndex: '0x01', bitLen: 16, name: 'Input', dataType: 'UINT' }],
    }
    const channels = persistedPdosToChannels([], [fixedTx, moduleTx])
    expect(channels).toHaveLength(1)
    expect(channels[0].pdoIndex).toBe('0x1a90')
  })

  it('tags module channels and persisted PDOs with their source slot (port)', () => {
    const enriched = buildModuleEnrich(device, selections)
    const slotNames = device.slots!.map((s) => s.name)
    // Module PDOs (the fixed coupler PDOs are excluded) know their slot.
    expect(enriched.rxPdos.every((p) => p.slotName !== undefined && slotNames.includes(p.slotName!))).toBe(true)
    expect(enriched.txPdos.every((p) => p.slotName !== undefined && slotNames.includes(p.slotName!))).toBe(true)
    // The source slot survives the round-trip to the channel list the Channel
    // Mappings tab renders.
    const rebuilt = persistedPdosToChannels(enriched.rxPdos, enriched.txPdos)
    expect(rebuilt.length).toBeGreaterThan(0)
    expect(rebuilt.every((c) => c.slotName !== undefined && slotNames.includes(c.slotName!))).toBe(true)
  })
})

describe('defaultModuleSelections', () => {
  const slots = [
    { name: 'Port 1', options: [] },
    { name: 'Port 2', options: [] },
  ]

  it('sets every slot to NO-Slave', () => {
    expect(defaultModuleSelections(slots)).toEqual([
      { slotName: 'Port 1', moduleIdent: NO_SLAVE_MODULE_IDENT },
      { slotName: 'Port 2', moduleIdent: NO_SLAVE_MODULE_IDENT },
    ])
  })

  it('is empty without a catalog', () => {
    expect(defaultModuleSelections(undefined)).toEqual([])
  })
})

describe('enrichDeviceData (modular slave)', () => {
  const device = parseDevice()

  it('yields an empty process image plus the module catalog, every port defaulting to NO-Slave', () => {
    const enriched = enrichDeviceData(device)
    expect(enriched.channelInfo).toEqual([])
    expect(enriched.rxPdos).toEqual([])
    expect(enriched.txPdos).toEqual([])
    expect(enriched.channelMappings).toEqual([])
    expect(enriched.moduleSlots).toHaveLength(2)
    expect(enriched.moduleSelections).toHaveLength(2)
    expect(enriched.moduleSelections?.every((s) => s.moduleIdent === NO_SLAVE_MODULE_IDENT)).toBe(true)
    expect(isModuleSelectionComplete(enriched.moduleSlots, enriched.moduleSelections)).toBe(true)
  })
})

describe('buildModuleEnrich', () => {
  const device = parseDevice()
  const selections = device.slots!.map((s) => ({ slotName: s.name, moduleIdent: '0x2c01' }))

  it('produces flat channels/PDOs/mappings and the selection record', () => {
    const enriched = buildModuleEnrich(device, selections)
    expect(enriched.channelInfo).toHaveLength(4) // 2 in + 2 out across both ports
    expect(enriched.rxPdos).toHaveLength(2)
    expect(enriched.txPdos).toHaveLength(2)
    expect(enriched.channelMappings).toHaveLength(4)
    expect(enriched.moduleSlots).toHaveLength(2)
    expect(enriched.moduleSelections).toEqual(selections)
    expect(enriched.slaveType).toBe('analog_io')
  })

  it('excludes the coupler fixed PDOs from the exported rxPdos/txPdos', () => {
    const fixedRx = {
      index: '0x1680',
      name: 'Coupler Out',
      fixed: true,
      mandatory: true,
      entries: [{ index: '0xa080', subIndex: '0x02', bitLen: 1, name: 'CQ', dataType: 'BOOL' }],
    }
    const fixedTx = {
      index: '0x1a80',
      name: 'CQ status',
      fixed: true,
      mandatory: true,
      entries: [{ index: '0xb080', subIndex: '0x01', bitLen: 1, name: 'CQ Bit', dataType: 'BOOL' }],
    }
    const dev = { ...device, rxPdo: [fixedRx], txPdo: [fixedTx] }
    const enriched = buildModuleEnrich(dev, selections)
    expect(enriched.rxPdos.map((p) => p.index)).not.toContain('0x1680')
    expect(enriched.txPdos.map((p) => p.index)).not.toContain('0x1a80')
    // Module process-data PDOs still ship to the runtime.
    expect(enriched.rxPdos.length).toBeGreaterThan(0)
    expect(enriched.txPdos.length).toBeGreaterThan(0)
  })

  it('yields an empty image for no selections', () => {
    const enriched = buildModuleEnrich(device, [])
    expect(enriched.channelInfo).toHaveLength(0)
    expect(enriched.channelMappings).toHaveLength(0)
    expect(enriched.moduleSelections).toEqual([])
  })
})
