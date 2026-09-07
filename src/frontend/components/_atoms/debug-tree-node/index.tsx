import { ComponentPropsWithoutRef, useCallback, useState } from 'react'

import type { DebugTreeNode } from '../../../../middleware/shared/ports/types'
import { ArrowIcon } from '../../../assets/icons/interface/Arrow'
import ViewIcon from '../../../assets/icons/interface/View'
import { cn } from '../../../utils/cn'

type TreeNodeProps = ComponentPropsWithoutRef<'div'> & {
  node: DebugTreeNode
  onToggleExpand: (compositeKey: string) => void
  onViewToggle?: (compositeKey: string) => void
  isViewing?: (compositeKey: string) => boolean
  getValue?: (compositeKey: string) => string | undefined
  isForced?: (compositeKey: string) => boolean
  getForcedValue?: (compositeKey: string) => boolean | undefined
  canForce?: (node: DebugTreeNode) => boolean
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
  level?: number
}

/** Inline numeric/string value editor that commits on Enter and cancels on Esc/blur. */
const EditableValue = ({ text, onCommit }: { text: string; onCommit: (value: string) => void }) => {
  const [value, setValue] = useState(text)

  const commit = useCallback(() => {
    if (value.trim().length > 0) onCommit(value.trim())
  }, [value, onCommit])

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') setValue(text)
      }}
      onBlur={() => {
        if (value.trim().length > 0 && value.trim() !== text) onCommit(value.trim())
      }}
      className='h-[20px] w-24 rounded border border-brand bg-white px-1 font-mono text-xs text-neutral-900 outline-none dark:bg-neutral-950 dark:text-neutral-100'
    />
  )
}

const TreeNode = ({
  node,
  onToggleExpand,
  onViewToggle,
  isViewing,
  getValue,
  isForced,
  getForcedValue,
  canForce,
  onWriteValue,
  onToggleForce,
  level = 0,
  ...rest
}: TreeNodeProps) => {
  const [editing, setEditing] = useState(false)
  const indentWidth = level * 16
  const isCurrentNodeViewing = isViewing ? isViewing(node.compositeKey) : false
  const isCurrentNodeForced = isForced ? isForced(node.compositeKey) : false
  const forcedValue = getForcedValue ? getForcedValue(node.compositeKey) : undefined
  const canForceNode = canForce ? canForce(node) : false
  const isLeaf = !node.isComplex

  const lookupKey = node.debugIndex !== undefined ? node.fullPath : node.compositeKey
  const valueText = isLeaf ? getValue?.(node.compositeKey) : undefined
  const isBool = isLeaf && (node.type.toUpperCase() === 'BOOL' || node.type.toUpperCase() === 'X')

  const isRoot = level === 0
  let displayLabel = node.name
  if (isRoot) {
    const [pouName, path] = node.compositeKey.split(':')
    if (pouName && path) {
      displayLabel = `${pouName}.${path}`
    }
  }

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (node.isComplex) {
      onToggleExpand(node.compositeKey)
    }
  }

  const handleViewToggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (onViewToggle && !node.isComplex) {
      onViewToggle(node.compositeKey)
    }
  }

  const handleValueClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!isLeaf || !canForceNode) return
    if (isBool && onWriteValue) {
      const currentOn = valueText === 'TRUE' || valueText === '1'
      onWriteValue(node.compositeKey, node.type, !currentOn, lookupKey)
      return
    }
    setEditing(true)
  }

  const commitEdit = useCallback(
    (text: string) => {
      setEditing(false)
      onWriteValue?.(node.compositeKey, node.type, text, lookupKey)
    },
    [node.compositeKey, node.type, lookupKey, onWriteValue],
  )

  const toggleForce = (checked: boolean) => {
    onToggleForce?.(node.compositeKey, node.type, checked, lookupKey, valueText)
  }

  const textColor = isCurrentNodeForced ? (forcedValue ? '#80C000' : '#4080FF') : undefined

  return (
    <div {...rest}>
      <div className='flex h-auto w-full items-center gap-2'>
        <div className='flex h-4 w-4 flex-shrink-0 items-center justify-center'>
          {node.isComplex ? (
            <button
              onClick={handleToggleExpand}
              className='flex h-4 w-4 items-center justify-center'
              aria-label={node.isExpanded ? 'Collapse' : 'Expand'}
            >
              <ArrowIcon
                direction='right'
                className={cn(
                  'h-4 w-4 stroke-brand-light transition-all',
                  node.isExpanded && 'rotate-270 stroke-brand',
                )}
              />
            </button>
          ) : onViewToggle ? (
            <button
              onClick={handleViewToggle}
              className='flex h-4 w-4 items-center justify-center'
              aria-label='Toggle graph visibility'
            >
              <ViewIcon className='h-4 w-4 cursor-pointer' stroke={isCurrentNodeViewing ? '#7C3AED' : '#B4D0FE'} />
            </button>
          ) : null}
        </div>

        <div
          className={cn(
            'grid min-w-0 flex-1 grid-cols-[1fr_auto_auto_auto] items-center gap-2 py-1',
            isLeaf && canForceNode && 'cursor-text hover:bg-neutral-100 dark:hover:bg-neutral-850',
          )}
          style={{ paddingLeft: `${indentWidth}px` }}
        >
          <p
            className='truncate text-neutral-1000 dark:text-white'
            style={{
              color: textColor,
              fontWeight: isCurrentNodeForced ? 600 : undefined,
            }}
          >
            {displayLabel}
          </p>
          <p className='uppercase text-neutral-400 dark:text-neutral-700'>{node.type}</p>

          {node.isComplex && !node.isExpanded ? (
            <button className='text-neutral-500' onClick={handleToggleExpand}>
              ...
            </button>
          ) : node.isComplex ? (
            <span />
          ) : editing ? (
            <EditableValue text={valueText ?? '0'} onCommit={commitEdit} />
          ) : (
            <button
              className='text-left text-neutral-1000 dark:text-white'
              style={{ color: textColor, fontWeight: isCurrentNodeForced ? 600 : undefined }}
              onClick={handleValueClick}
              title={canForceNode ? (isBool ? 'Click to toggle value' : 'Click to edit value') : undefined}
            >
              {valueText ?? '-'}
            </button>
          )}

          {isLeaf && canForceNode ? (
            <input
              type='checkbox'
              checked={isCurrentNodeForced}
              onChange={(e) => toggleForce(e.target.checked)}
              title='Force (pin) this variable'
              className='h-3.5 w-3.5 cursor-pointer'
            />
          ) : (
            <span />
          )}
        </div>
      </div>

      {node.isComplex && node.isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.compositeKey}
              node={child}
              onToggleExpand={onToggleExpand}
              onViewToggle={onViewToggle}
              isViewing={isViewing}
              getValue={getValue}
              isForced={isForced}
              getForcedValue={getForcedValue}
              canForce={canForce}
              onWriteValue={onWriteValue}
              onToggleForce={onToggleForce}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export { TreeNode }
