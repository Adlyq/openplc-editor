import { useCallback, useState } from 'react'

import type { DebugTreeNode } from '../../../../middleware/shared/ports/types'
import ViewIcon from '../../../assets/icons/interface/View'
import ZapIcon from '../../../assets/icons/interface/Zap'
import { TreeNode } from '../../_atoms/debug-tree-node'

type Variable = {
  name: string
  type: string
  value?: string
  compositeKey: string
}

type VariablePanelProps = {
  variables?: Variable[]
  variableTree?: Map<string, DebugTreeNode>
  graphList?: string[]
  setGraphList: React.Dispatch<React.SetStateAction<string[]>>
  debugBoolValues?: Map<string, string>
  debugNonBoolValues?: Map<string, string>
  debugVariableIndexes?: Map<string, number>
  debugForcedVariables?: Map<string, boolean>
  debugExpandedNodes?: Map<string, boolean>
  onToggleExpandedNode?: (compositeKey: string) => void
  isDebuggerVisible?: boolean
  /** Soft-write a value (force=false); BOOL passes a boolean, others text. */
  onWriteValue?: (compositeKey: string, variableType: string, value: string | boolean, lookupKey?: string) => void
  /** Turn a variable's force on/off (on = force the current value). */
  onToggleForce?: (
    compositeKey: string,
    variableType: string,
    forceOn: boolean,
    lookupKey?: string,
    currentValue?: string,
  ) => void
}

const VariablesPanel = ({
  variables,
  variableTree,
  setGraphList,
  graphList,
  debugBoolValues,
  debugNonBoolValues,
  debugVariableIndexes,
  debugForcedVariables,
  debugExpandedNodes,
  onToggleExpandedNode,
  isDebuggerVisible,
  onWriteValue,
  onToggleForce,
}: VariablePanelProps) => {
  const expandedNodes = debugExpandedNodes ?? new Map<string, boolean>()
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editType, setEditType] = useState('')
  const [editText, setEditText] = useState('')

  const getValue = (compositeKey: string): string | undefined => {
    return debugBoolValues?.get(compositeKey) ?? debugNonBoolValues?.get(compositeKey)
  }

  const toggleGraphVisibility = (variableName: string) => {
    setGraphList((prevGraphList) => {
      if (prevGraphList.includes(variableName)) {
        return prevGraphList.filter((name) => name !== variableName)
      } else {
        return [...prevGraphList, variableName]
      }
    })
  }

  const handleToggleExpand = (compositeKey: string) => {
    if (onToggleExpandedNode) {
      onToggleExpandedNode(compositeKey)
    }
  }

  const updateNodeExpansion = (node: DebugTreeNode): DebugTreeNode => {
    const isExpanded = expandedNodes.get(node.compositeKey) ?? false
    return {
      ...node,
      isExpanded,
      children: node.children?.map(updateNodeExpansion),
    }
  }

  const isViewingPredicate = useCallback(
    (compositeKey: string) => {
      return graphList?.includes(compositeKey) ?? false
    },
    [graphList],
  )

  const isForcedPredicate = useCallback(
    (compositeKey: string) => {
      return debugForcedVariables?.has(compositeKey) ?? false
    },
    [debugForcedVariables],
  )

  const getForcedValue = useCallback(
    (compositeKey: string) => {
      return debugForcedVariables?.get(compositeKey)
    },
    [debugForcedVariables],
  )

  const canForceVariable = useCallback(
    (node: DebugTreeNode) => {
      if (!isDebuggerVisible || node.isComplex) return false
      if (node.debugIndex !== undefined) return true
      return (
        (debugVariableIndexes?.has(node.fullPath) ?? false) || (debugVariableIndexes?.has(node.compositeKey) ?? false)
      )
    },
    [isDebuggerVisible, debugVariableIndexes],
  )

  const lookupKeyFor = (node: DebugTreeNode): string => {
    return node.debugIndex !== undefined ? node.fullPath : node.compositeKey
  }

  const commitEdit = useCallback(
    (compositeKey: string, text: string) => {
      setEditingKey(null)
      onWriteValue?.(compositeKey, editType, text)
    },
    [onWriteValue, editType],
  )

  const renderTreeView = () => {
    if (!variableTree || variableTree.size === 0) return null
    const rootNodes = Array.from(variableTree.values()).map(updateNodeExpansion)
    return (
      <div className='flex h-full flex-col overflow-auto whitespace-nowrap'>
        {rootNodes.map((node) => (
          <TreeNode
            key={node.compositeKey}
            node={node}
            onToggleExpand={handleToggleExpand}
            onViewToggle={toggleGraphVisibility}
            isViewing={isViewingPredicate}
            getValue={getValue}
            isForced={isForcedPredicate}
            getForcedValue={getForcedValue}
            canForce={canForceVariable}
            onWriteValue={onWriteValue}
            onToggleForce={onToggleForce}
          />
        ))}
      </div>
    )
  }

  const renderFlatView = () => {
    if (!variables || variables.length === 0) return null
    return (
      <div className='flex h-full flex-col gap-2 overflow-auto whitespace-nowrap'>
        {variables.map((variable) => {
          const nodeForFlat: DebugTreeNode = {
            name: variable.name,
            fullPath: variable.compositeKey,
            compositeKey: variable.compositeKey,
            type: variable.type,
            isComplex: false,
            debugIndex: debugVariableIndexes?.get(variable.compositeKey),
          }
          const canForce = canForceVariable(nodeForFlat)
          const isForced = isForcedPredicate(variable.compositeKey)
          const forcedVal = getForcedValue(variable.compositeKey)
          const valueText = getValue(variable.compositeKey) ?? '0'
          const textColor = isForced ? (forcedVal ? '#80C000' : '#4080FF') : undefined
          const isBool = nodeForFlat.type.toUpperCase() === 'BOOL'
          const lookupKey = lookupKeyFor(nodeForFlat)
          const isEditing = editingKey === variable.compositeKey

          return (
            <div key={variable.compositeKey} className='flex h-auto w-full items-center gap-2'>
              <div className='flex h-4 w-4 flex-shrink-0 items-center justify-center'>
                <ViewIcon
                  type='button'
                  className='h-4 w-4 cursor-pointer'
                  stroke={graphList?.includes(variable.compositeKey) ? '#7C3AED' : '#B4D0FE'}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleGraphVisibility(variable.compositeKey)
                  }}
                />
              </div>
              <p
                className='min-w-0 flex-1 truncate'
                style={{ color: textColor, fontWeight: isForced ? 600 : undefined }}
              >
                {variable.name}
              </p>
              <p className='uppercase text-neutral-400 dark:text-neutral-700'>{variable.type}</p>

              {canForce && isBool ? (
                <button
                  className='text-neutral-1000 dark:text-white'
                  onClick={() =>
                    onWriteValue?.(
                      variable.compositeKey,
                      nodeForFlat.type,
                      !(valueText === 'TRUE' || valueText === '1'),
                      lookupKey,
                    )
                  }
                >
                  {valueText}
                </button>
              ) : isEditing ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit(variable.compositeKey, editText)
                    if (e.key === 'Escape') setEditingKey(null)
                  }}
                  onBlur={() => commitEdit(variable.compositeKey, editText)}
                  className='w-24 rounded border border-brand bg-white px-1 font-mono text-xs text-neutral-900 outline-none dark:bg-neutral-950 dark:text-neutral-100'
                />
              ) : canForce ? (
                <button
                  className='text-neutral-1000 dark:text-white'
                  style={{ color: textColor, fontWeight: isForced ? 600 : undefined }}
                  onClick={() => {
                    setEditText(valueText)
                    setEditType(nodeForFlat.type)
                    setEditingKey(variable.compositeKey)
                  }}
                >
                  {valueText}
                </button>
              ) : (
                <p className='text-neutral-1000 dark:text-white'>{valueText}</p>
              )}

              {canForce ? (
                <input
                  type='checkbox'
                  checked={isForced}
                  onChange={(e) =>
                    onToggleForce?.(variable.compositeKey, nodeForFlat.type, e.target.checked, lookupKey, valueText)
                  }
                  title='Force (pin) this variable'
                  className='h-3.5 w-3.5 cursor-pointer'
                />
              ) : (
                <span className='h-3.5 w-3.5' />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className='flex h-full w-full min-w-52 flex-col gap-2 overflow-hidden rounded-lg border-[0.75px] border-neutral-200 bg-white p-2 text-cp-sm font-medium text-neutral-1000 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50'>
      <div className='flex h-7 w-[90px] select-none items-center gap-1 rounded-lg bg-neutral-100 p-1 text-cp-sm dark:bg-brand-dark'>
        <ZapIcon className='h-4 w-4' />
        <p>Variables</p>
      </div>
      {variableTree && variableTree.size > 0 ? renderTreeView() : renderFlatView()}
    </div>
  )
}

export { VariablesPanel }
