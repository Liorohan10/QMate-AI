import React from 'react'

export function parseStepCategory(name: string): { category: 'happy-path' | 'negative' | 'edge' | null; cleanName: string } {
  if (!name) return { category: null, cleanName: '' }
  if (name.startsWith('[Happy Path]')) {
    return { category: 'happy-path', cleanName: name.substring('[Happy Path]'.length).trim() }
  }
  if (name.startsWith('[Negative]')) {
    return { category: 'negative', cleanName: name.substring('[Negative]'.length).trim() }
  }
  if (name.startsWith('[Edge]')) {
    return { category: 'edge', cleanName: name.substring('[Edge]'.length).trim() }
  }
  return { category: null, cleanName: name }
}

export function StepCategoryBadge({ category }: { category: 'happy-path' | 'negative' | 'edge' | null }) {
  if (!category) return null

  let bg = ''
  let text = ''
  let label = ''

  if (category === 'happy-path') {
    bg = 'bg-emerald-500/10 border-emerald-500/20'
    text = 'text-emerald-500 dark:text-emerald-400'
    label = 'Happy Path'
  } else if (category === 'negative') {
    bg = 'bg-rose-500/10 border-rose-500/20'
    text = 'text-rose-500 dark:text-rose-400'
    label = 'Negative'
  } else {
    bg = 'bg-amber-500/10 border-amber-500/20'
    text = 'text-amber-500 dark:text-amber-400'
    label = 'Edge'
  }

  return (
    <span className={`inline-flex shrink-0 items-center rounded-sm px-1 py-0.5 text-[9px] font-semibold border ${bg} ${text} select-none mr-1.5 align-middle uppercase tracking-wider`}>
      {label}
    </span>
  )
}
