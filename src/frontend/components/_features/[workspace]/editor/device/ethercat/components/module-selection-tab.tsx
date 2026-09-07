import {
  buildModuleEnrich,
  isModuleSelectionComplete,
  NO_SLAVE_MODULE_IDENT,
} from '@root/backend/shared/ethercat/module-process-image'
import type {
  ConfiguredEtherCATDevice,
  EnrichDeviceData,
  ESIDevice,
  ModuleSelection,
} from '@root/middleware/shared/ports/esi-types'
import { useEsi } from '@root/middleware/shared/providers/platform-context'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface ModuleSelectionTabProps {
  /** The modular slave being edited. */
  device: ConfiguredEtherCATDevice
  /** IEC locations already claimed by other producers (avoids conflicts). */
  externalAddresses: Set<string>
  /** Persist a recomputed enrichment back onto the device. */
  onEnrich: (data: EnrichDeviceData) => void
}

/**
 * Per-slot module picker for modular (Slot/Module based) EtherCAT slaves.
 *
 * Every port/slot gets a dropdown of the modules the ESI allows.  Changing a
 * selection rebuilds the slave's process image (channels / PDOs / IEC
 * mappings) from the selected modules and writes it back through the existing
 * `updateEthercatConfig` pipeline, so the compile gate sees a fully
 * configured device.
 */
const ModuleSelectionTab = ({ device, externalAddresses, onEnrich }: ModuleSelectionTabProps) => {
  const esi = useEsi()
  const [fullDevice, setFullDevice] = useState<ESIDevice | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const slots = useMemo(() => device.moduleSlots ?? [], [device.moduleSlots])
  const selections = useMemo(() => device.moduleSelections ?? [], [device.moduleSelections])
  const complete = isModuleSelectionComplete(device.moduleSlots, selections)

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setLoadError(null)

    const load = async () => {
      try {
        const result = await esi!.loadDeviceFull(device.esiDeviceRef.repositoryItemId, device.esiDeviceRef.deviceIndex)
        if (cancelled) return
        if (result.success && result.device) {
          setFullDevice(result.device)
        } else {
          setLoadError(!result.success ? (result.error ?? 'Failed') : 'Failed to load device data')
        }
      } catch (error) {
        if (!cancelled) setLoadError(String(error))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [device.esiDeviceRef.repositoryItemId, device.esiDeviceRef.deviceIndex, esi])

  const missingSlots = useMemo(
    () => slots.filter((slot) => !selections.some((s) => s.slotName === slot.name)),
    [slots, selections],
  )

  const totals = useMemo(() => {
    let inputBytes = 0
    let outputBytes = 0
    for (const selection of selections) {
      const slot = slots.find((s) => s.name === selection.slotName)
      const option = slot?.options.find((o) => o.ident === selection.moduleIdent)
      if (!option || option.ident === NO_SLAVE_MODULE_IDENT) continue
      inputBytes += option.inputBytes
      outputBytes += option.outputBytes
    }
    return { inputBytes, outputBytes }
  }, [slots, selections])

  const handleSelect = useCallback(
    (slotName: string, moduleIdent: string) => {
      const nextSelections: ModuleSelection[] = selections
        .filter((s) => s.slotName !== slotName)
        .concat({ slotName, moduleIdent })
        .sort((a, b) => slots.findIndex((s) => s.name === a.slotName) - slots.findIndex((s) => s.name === b.slotName))

      if (!fullDevice) return

      // Surface what changing the process image costs before applying it.
      const oldAliasByChannel = new Map(device.channelMappings.map((m) => [m.channelId, m.alias]))
      const enriched = buildModuleEnrich(fullDevice, nextSelections, externalAddresses, device.sdoConfigurations)
      const newChannelIds = new Set(enriched.channelInfo.map((c) => c.channelId))
      const droppedAliases = [...oldAliasByChannel.entries()].filter(
        ([channelId, alias]) => alias && !newChannelIds.has(channelId),
      )
      const droppedCount = oldAliasByChannel.size - newChannelIds.size
      if (
        droppedAliases.length > 0 &&
        !window.confirm(
          `Changing the module for "${slotName}" removes ${droppedCount} channel(s) ` +
            `including ${droppedAliases.length} with aliases.\n\n` +
            droppedAliases
              .slice(0, 8)
              .map(([, alias]) => `  • ${alias}`)
              .join('\n') +
            (droppedAliases.length > 8 ? '\n  …' : '') +
            '\n\nProceed?',
        )
      ) {
        return
      }

      // Keep the aliases of channels that survive the change.
      const channelMappings = enriched.channelMappings.map((m) => ({
        ...m,
        alias: oldAliasByChannel.get(m.channelId) ?? '',
      }))

      onEnrich({
        channelInfo: enriched.channelInfo,
        rxPdos: enriched.rxPdos,
        txPdos: enriched.txPdos,
        slaveType: enriched.slaveType,
        channelMappings,
        // Module-derived startup parameters are the single source for a
        // modular slave.  Overrides for rows that survive (same module/slot)
        // are preserved by buildModuleEnrich; rows of a replaced module reset
        // to the new module's defaults.
        sdoConfigurations: enriched.sdoConfigurations,
        moduleSdoConfigurations: undefined,
        moduleSlots: enriched.moduleSlots,
        moduleSelections: enriched.moduleSelections,
      })
    },
    [selections, slots, fullDevice, device.channelMappings, device.sdoConfigurations, externalAddresses, onEnrich],
  )

  if (isLoading) {
    return <div className='p-4 text-sm text-neutral-500'>Loading module definitions…</div>
  }

  if (loadError) {
    return <div className='p-4 text-sm text-red-600'>{loadError}</div>
  }

  if (slots.length === 0) {
    return (
      <div className='p-4 text-sm text-neutral-500'>
        This ESI device does not declare modules. No per-slot configuration is needed.
      </div>
    )
  }

  return (
    <div className='flex max-w-3xl flex-col gap-4 p-4'>
      {!complete && (
        <div className='rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300'>
          This modular slave has no module assignment yet. Assign a module (or NO-Slave) to every port before compiling
          — otherwise the EtherCAT process image is empty.
          {missingSlots.length > 0 && (
            <span className='mt-1 block font-medium'>Missing: {missingSlots.map((s) => s.name).join(', ')}</span>
          )}
        </div>
      )}

      <div className='flex flex-col gap-3'>
        {slots.map((slot) => {
          const current = selections.find((s) => s.slotName === slot.name)?.moduleIdent ?? ''
          return (
            <div
              key={slot.name}
              className='flex flex-col gap-1 rounded-md border border-neutral-200 p-3 dark:border-neutral-700'
            >
              <span className='text-xs font-medium text-neutral-700 dark:text-neutral-300'>{slot.name}</span>
              <select
                className='w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100'
                value={current}
                disabled={!fullDevice}
                onChange={(e) => handleSelect(slot.name, e.target.value)}
              >
                {!current && <option value=''>— select a module —</option>}
                {slot.options.map((option) => (
                  <option key={option.ident} value={option.ident}>
                    {option.name}
                    {option.ident !== NO_SLAVE_MODULE_IDENT &&
                      ` (${option.outputBytes} B out / ${option.inputBytes} B in)`}
                  </option>
                ))}
              </select>
            </div>
          )
        })}
      </div>

      <div className='rounded-md border border-neutral-200 p-3 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-400'>
        Process image:{' '}
        <span className='font-mono font-medium'>
          {totals.outputBytes} B out / {totals.inputBytes} B in
        </span>
      </div>
    </div>
  )
}

export { ModuleSelectionTab }
