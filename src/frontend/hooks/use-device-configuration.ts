import { enrichDeviceData } from '@root/backend/shared/ethercat/enrich-device-data'
import {
  generateDefaultChannelMappings,
  pdoToChannels,
  persistedPdosToChannels,
} from '@root/backend/shared/ethercat/esi-parser'
import {
  buildModuleCatalog,
  buildModuleSdoConfigurations,
  defaultModuleSelections,
  mergeModuleSdoRows,
  reconcileModuleSdoConfigurations,
} from '@root/backend/shared/ethercat/module-process-image'
import { extractDefaultSdoConfigurations } from '@root/backend/shared/ethercat/sdo-config-defaults'
import { toast } from '@root/frontend/components/_features/[app]/toast/use-toast'
import { useOpenPLCStore } from '@root/frontend/store'
import type {
  ConfiguredEtherCATDevice,
  EnrichDeviceData,
  ESIChannel,
  ESICoEObject,
  EtherCATChannelMapping,
  EtherCATSlaveConfig,
} from '@root/middleware/shared/ports/esi-types'
import { useEsi } from '@root/middleware/shared/providers/platform-context'
import {
  buildAddressPool,
  buildAliasRegistry,
  describeSource,
  validateAliasEdit,
} from '@root/middleware/shared/utils/iec-address'
import { resolveTargetCapabilities } from '@root/middleware/shared/utils/target-capabilities'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type UseDeviceConfigurationParams = {
  device: ConfiguredEtherCATDevice
  projectPath: string
  externalAddresses: Set<string>
  onUpdateDevice: (config: EtherCATSlaveConfig) => void
  onUpdateChannelMappings: (mappings: EtherCATChannelMapping[]) => void
  onEnrichDevice: (data: EnrichDeviceData) => void
  enabled?: boolean
}

type UseDeviceConfigurationResult = {
  channels: ESIChannel[]
  coeObjects: ESICoEObject[] | undefined
  isLoadingChannels: boolean
  channelLoadError: string | null
  handleAliasChange: (channelId: string, alias: string) => void
  updateConfig: <K extends keyof EtherCATSlaveConfig>(section: K, updates: Partial<EtherCATSlaveConfig[K]>) => void
}

export function useDeviceConfiguration({
  device,
  projectPath,
  externalAddresses,
  onUpdateDevice,
  onUpdateChannelMappings,
  onEnrichDevice,
  enabled = true,
}: UseDeviceConfigurationParams): UseDeviceConfigurationResult {
  const esiPort = useEsi()
  const [rawChannels, setRawChannels] = useState<ESIChannel[]>([])
  const [coeObjects, setCoeObjects] = useState<ESICoEObject[] | undefined>(undefined)
  const [isLoadingChannels, setIsLoadingChannels] = useState(false)
  const [channelLoadError, setChannelLoadError] = useState<string | null>(null)
  const fullDeviceLoadedRef = useRef(false)

  // Capture latest callback refs to avoid stale closures and unstable deps
  const onUpdateDeviceRef = useRef(onUpdateDevice)
  onUpdateDeviceRef.current = onUpdateDevice
  const onUpdateChannelMappingsRef = useRef(onUpdateChannelMappings)
  onUpdateChannelMappingsRef.current = onUpdateChannelMappings
  const onEnrichDeviceRef = useRef(onEnrichDevice)
  onEnrichDeviceRef.current = onEnrichDevice

  useEffect(() => {
    if (!enabled || !device || fullDeviceLoadedRef.current) return

    const loadFullDevice = async () => {
      setIsLoadingChannels(true)
      setChannelLoadError(null)

      try {
        const result = await esiPort!.loadDeviceFull(
          device.esiDeviceRef.repositoryItemId,
          device.esiDeviceRef.deviceIndex,
        )

        if (result.success && result.device) {
          const deviceChannels = pdoToChannels(result.device)
          // Prefer the persisted PDOs: after a module selection (or any
          // previous enrich) the device's real process image lives there,
          // while a modular slave's device-level PDOs are empty by design.
          const storedChannels =
            (device.rxPdos?.length ?? 0) > 0 || (device.txPdos?.length ?? 0) > 0
              ? persistedPdosToChannels(device.rxPdos ?? [], device.txPdos ?? [])
              : deviceChannels
          setRawChannels(storedChannels)
          setCoeObjects(result.device.coeObjects)
          fullDeviceLoadedRef.current = true

          // Legacy migration: a Slot/Module based slave persisted BEFORE
          // module support has no `moduleSlots` — its old flat channel list
          // is meaningless until modules are assigned.  Default every port to
          // NO-Slave so the device opens as "complete but empty"; the Module
          // Selection tab drives the rebuild for the ports actually fitted.
          if ((result.device.slots?.length ?? 0) > 0 && !device.moduleSlots) {
            setRawChannels([])
            const moduleSlots = buildModuleCatalog(result.device)
            onEnrichDeviceRef.current({
              channelInfo: [],
              rxPdos: [],
              txPdos: [],
              slaveType: device.slaveType ?? 'coupler',
              channelMappings: [],
              moduleSlots,
              moduleSelections: defaultModuleSelections(moduleSlots),
            })
          }

          // Legacy migration: a modular slave persisted before module-driven
          // startup parameters kept only the raw device CoE dictionary dump in
          // `sdoConfigurations` and derived the per-port activation values into
          // `moduleSdoConfigurations`.  Keep the dictionary rows verbatim and
          // overlay module-derived rows (same-module overrides preserved) so
          // the runtime receives the identical startup SDO set as before.
          if ((result.device.slots?.length ?? 0) > 0 && device.moduleSlots && device.moduleSelections) {
            const stored = device.sdoConfigurations
            if (stored && stored.length > 0 && !stored.some((entry) => entry.moduleSlot)) {
              const rows = buildModuleSdoConfigurations(result.device, device.moduleSelections)
              onEnrichDeviceRef.current({
                sdoConfigurations: mergeModuleSdoRows(stored, reconcileModuleSdoConfigurations(stored, rows)),
                moduleSdoConfigurations: undefined,
              })
            }
          }

          // Legacy cleanup: the module process-image exporter once shipped the
          // coupler's fixed PDOs (0x1680 / 0x1A80 / 0x1A81) in rxPdos/txPdos.
          // The runtime adds them to the assignment itself and re-bases the
          // module channel offsets, so keep the persisted PDO list module-only
          // (matching the module-only channel list) or the runtime mis-computes
          // the input channel offset.
          if (
            (result.device.slots?.length ?? 0) > 0 &&
            (device.rxPdos?.some((p) => p.fixed) || device.txPdos?.some((p) => p.fixed))
          ) {
            onEnrichDeviceRef.current({
              rxPdos: (device.rxPdos ?? []).filter((p) => !p.fixed),
              txPdos: (device.txPdos ?? []).filter((p) => !p.fixed),
            })
          }

          if (device.channelMappings.length === 0 && storedChannels.length > 0) {
            onUpdateChannelMappingsRef.current(generateDefaultChannelMappings(storedChannels, externalAddresses))
          }

          if (!device.channelInfo || !device.rxPdos || !device.txPdos) {
            const { sdoConfigurations, ...rest } = enrichDeviceData(result.device, externalAddresses)
            onEnrichDeviceRef.current(device.sdoConfigurations !== undefined ? rest : { ...rest, sdoConfigurations })
            // Modular slaves must never fall through to the dictionary-based
            // startup-parameter seeding below: their per-port objects are
            // module-owned and generated from the module selections.
          } else if (
            device.sdoConfigurations === undefined &&
            (result.device.slots?.length ?? 0) === 0 &&
            result.device.coeObjects?.length
          ) {
            onEnrichDeviceRef.current({
              channelInfo: device.channelInfo,
              rxPdos: device.rxPdos,
              txPdos: device.txPdos,
              slaveType: device.slaveType ?? '',
              sdoConfigurations: extractDefaultSdoConfigurations(result.device.coeObjects),
            })
          }
        } else {
          setChannelLoadError(!result.success ? (result.error ?? 'Failed') : 'Failed to load device data')
        }
      } catch (error) {
        setChannelLoadError(String(error))
      } finally {
        setIsLoadingChannels(false)
      }
    }

    void loadFullDevice()
  }, [enabled, projectPath, device?.esiDeviceRef?.repositoryItemId, device?.esiDeviceRef?.deviceIndex])

  // The channel list follows the device's *persisted* process image: once a
  // modular slave has a module selection (or a flat device has been enriched)
  // the PDOs live in device.rxPdos/txPdos, and a modular slave's device-level
  // PDOs are empty by design.  Re-derive from the persisted PDOs whenever
  // they change so the Channel Mappings tab tracks module-selection edits.
  const channels = useMemo(
    () =>
      (device?.rxPdos?.length ?? 0) > 0 || (device?.txPdos?.length ?? 0) > 0
        ? persistedPdosToChannels(device?.rxPdos ?? [], device?.txPdos ?? [])
        : rawChannels,
    [device?.rxPdos, device?.txPdos, rawChannels],
  )

  const handleAliasChange = useCallback(
    (channelId: string, alias: string) => {
      if (!device) return

      // Resolve the bus owning this slave so we can construct a
      // `SourceRef` whose `ref` matches the format used by the
      // address pool (`${busName}:${slaveName}:${channelId}` — see
      // `address-pool.ts:243`).  Without this, `validateAliasEdit`'s
      // "ignoring" comparison wouldn't recognise a no-op self-rename
      // and would spuriously reject it.
      const state = useOpenPLCStore.getState()
      const owningBus = state.project.data.remoteDevices?.find((d) =>
        d.ethercatConfig?.devices?.some((s) => s.name === device.name),
      )
      const busName = owningBus?.name ?? ''
      const sourceRef = { kind: 'ethercat' as const, ref: `${busName}:${device.name}:${channelId}` }

      // Phase 1 — write-time uniqueness gate (global across all
      // producers).  Build a fresh registry from the live state and
      // reject the edit on collision.  See
      // `module-slots-layout.tsx::handleAliasChange` for the longer
      // rationale.
      const board = state.deviceDefinitions.configuration.deviceBoard ?? ''
      const boardInfo = state.deviceAvailableOptions.availableBoards.get(board)
      const ioMapping =
        (
          state.deviceDefinitions.configuration.vendorScreenData?.['io-mapping'] as
            | { entries?: Array<{ iecAddress: string; alias?: string; slot: number; channelName: string }> }
            | undefined
        )?.entries ?? []
      const pool = buildAddressPool(
        {
          pinMapping: { pins: state.deviceDefinitions.pinMapping.pinsByBoard[board] ?? [] },
          vendorIoMapping: { entries: ioMapping },
          remoteDevices: state.project.data.remoteDevices,
        },
        resolveTargetCapabilities(boardInfo),
      )
      const registry = buildAliasRegistry(pool)
      const validation = validateAliasEdit(registry, alias, sourceRef)
      if (!validation.ok) {
        toast({
          title: 'Alias already in use',
          description: `"${alias}" is already assigned to ${describeSource(validation.conflict.source)} (${validation.conflict.address}). Alias names must be unique across all I/O channels.`,
          variant: 'fail',
        })
        return
      }

      // Phase 2 — cascade rename onto bound variables BEFORE
      // writing the new alias so the downstream sync sees variables
      // pointing at the new name and refreshes locations rather
      // than orphaning them.
      const oldAlias = device.channelMappings.find((m) => m.channelId === channelId)?.alias ?? ''
      if (oldAlias) {
        useOpenPLCStore.getState().projectActions.renameAlias(oldAlias, alias)
      }

      const updated = device.channelMappings.map((m) => (m.channelId === channelId ? { ...m, alias } : m))
      onUpdateChannelMappingsRef.current(updated)
    },
    [device?.channelMappings, device?.name],
  )

  const updateConfig = useCallback(
    <K extends keyof EtherCATSlaveConfig>(section: K, updates: Partial<EtherCATSlaveConfig[K]>) => {
      if (!device) return
      onUpdateDeviceRef.current({
        ...device.config,
        [section]: { ...device.config[section], ...updates },
      })
    },
    [device?.config],
  )

  return {
    channels,
    coeObjects,
    isLoadingChannels,
    channelLoadError,
    handleAliasChange,
    updateConfig,
  }
}
