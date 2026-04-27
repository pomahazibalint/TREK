import React, { useMemo } from 'react'
import type { ScopeDefinition } from '../../api/oauthApi'

interface ScopeGroupPickerProps {
  availableScopes: ScopeDefinition[]
  selectedScopes: string[]
  onChange: (scopes: string[]) => void
  readOnly?: boolean
}

export default function ScopeGroupPicker({ availableScopes, selectedScopes, onChange, readOnly }: ScopeGroupPickerProps): React.ReactElement {
  const groups = useMemo(() => {
    const map = new Map<string, ScopeDefinition[]>()
    for (const def of availableScopes) {
      if (!map.has(def.group)) map.set(def.group, [])
      map.get(def.group)!.push(def)
    }
    return Array.from(map.entries())
  }, [availableScopes])

  const toggle = (scope: string) => {
    if (readOnly) return
    onChange(selectedScopes.includes(scope)
      ? selectedScopes.filter(s => s !== scope)
      : [...selectedScopes, scope])
  }

  const toggleGroup = (groupScopes: ScopeDefinition[]) => {
    if (readOnly) return
    const allSelected = groupScopes.every(s => selectedScopes.includes(s.scope))
    if (allSelected) {
      onChange(selectedScopes.filter(s => !groupScopes.find(g => g.scope === s)))
    } else {
      const toAdd = groupScopes.map(s => s.scope).filter(s => !selectedScopes.includes(s))
      onChange([...selectedScopes, ...toAdd])
    }
  }

  return (
    <div className="space-y-3">
      {groups.map(([group, defs]) => {
        const allSelected = defs.every(d => selectedScopes.includes(d.scope))
        const someSelected = defs.some(d => selectedScopes.includes(d.scope))
        return (
          <div key={group} className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-primary)' }}>
            <button
              type="button"
              onClick={() => toggleGroup(defs)}
              disabled={readOnly}
              className="w-full flex items-center justify-between px-3 py-2 text-left text-sm font-medium transition-colors"
              style={{
                background: someSelected ? 'var(--bg-secondary)' : 'var(--bg-card)',
                color: 'var(--text-primary)',
                cursor: readOnly ? 'default' : 'pointer',
              }}
            >
              <span>{group}</span>
              {!readOnly && (
                <span className="text-xs font-normal" style={{ color: 'var(--text-tertiary)' }}>
                  {allSelected ? 'Deselect all' : someSelected ? 'Select all' : 'Select all'}
                </span>
              )}
            </button>
            <div className="divide-y" style={{ borderColor: 'var(--border-primary)' }}>
              {defs.map(def => {
                const checked = selectedScopes.includes(def.scope)
                return (
                  <label
                    key={def.scope}
                    className="flex items-center gap-3 px-3 py-2 text-sm"
                    style={{
                      cursor: readOnly ? 'default' : 'pointer',
                      color: 'var(--text-primary)',
                      background: 'var(--bg-card)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(def.scope)}
                      disabled={readOnly}
                      className="w-4 h-4 accent-indigo-600 shrink-0"
                    />
                    <span className="flex-1">{def.label}</span>
                    <code className="text-xs font-mono shrink-0" style={{ color: 'var(--text-tertiary)' }}>{def.scope}</code>
                  </label>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
