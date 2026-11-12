import { describe, expect, it } from 'vitest'
import { buildSets, fillInOrder, reconcile, totals } from '../src/model.js'

const diesel = {
  id: 'dieselCans',
  name: 'Diesel',
  kind: 'fuel',
  fluid: 'diesel',
  cans: [
    { name: 'Big', capacity: 20, count: 2 },
    { name: 'Small', capacity: 5 }
  ]
}

describe('buildSets', () => {
  it('expands cans by count with stable keys', () => {
    const { sets, errors } = buildSets([diesel])
    expect(errors).toEqual([])
    expect(sets[0].cans).toEqual([
      { key: '0-0', name: 'Big 1', capacity: 20 },
      { key: '0-1', name: 'Big 2', capacity: 20 },
      { key: '1-0', name: 'Small', capacity: 5 }
    ])
    expect(sets[0].fluid).toBe('diesel')
  })

  it('rejects invalid ids, duplicate paths and sets without cans', () => {
    const { sets, errors } = buildSets([
      { ...diesel, id: '1bad' },
      diesel,
      { ...diesel, name: 'Twin' },
      { ...diesel, id: 'empty', cans: [] },
      { ...diesel, id: 'zero', cans: [{ name: 'x', capacity: 0 }] }
    ])
    expect(sets.map((s) => s.id)).toEqual(['dieselCans'])
    expect(errors).toHaveLength(5) // the zero-capacity set reports its can and "no cans"
    expect(errors[1]).toContain('id "dieselCans" is used twice')
  })

  it('rejects the same id under a different tank kind', () => {
    const { sets, errors } = buildSets([diesel, { ...diesel, kind: 'freshWater', fluid: 'fresh water' }])
    expect(sets.map((s) => s.kind)).toEqual(['fuel'])
    expect(errors).toEqual(['Set "Diesel": id "dieselCans" is used twice'])
  })

  it('handles a missing configuration', () => {
    expect(buildSets(undefined)).toEqual({ sets: [], errors: [] })
  })

  it('drops an unknown fluid and defaults the kind to fuel', () => {
    const { sets } = buildSets([{ ...diesel, kind: 'nonsense', fluid: 'beer' }])
    expect(sets[0].kind).toBe('fuel')
    expect(sets[0].fluid).toBeUndefined()
  })
})

describe('reconcile', () => {
  it('keeps known cans, starts new cans empty and drops removed ones', () => {
    const { sets } = buildSets([diesel])
    const levels = reconcile(sets, { dieselCans: { '0-0': 1, '0-1': 1.7, '9-9': 1 }, gone: { '0-0': 1 } })
    expect(levels).toEqual({ dieselCans: { '0-0': 1, '0-1': 1, '1-0': 0 } })
  })

  it('tolerates garbage', () => {
    const { sets } = buildSets([diesel])
    expect(reconcile(sets, 'nope')).toEqual({ dieselCans: { '0-0': 0, '0-1': 0, '1-0': 0 } })
  })
})

describe('totals and fillInOrder', () => {
  const { sets } = buildSets([diesel])
  const set = sets[0]

  it('sums capacity and volume', () => {
    expect(totals(set, { '0-0': 1, '0-1': 0.5, '1-0': 0 })).toEqual({ capacity: 45, volume: 30, level: 30 / 45 })
  })

  it('fills cans in configured order', () => {
    expect(fillInOrder(set, 27.5)).toEqual({ '0-0': 1, '0-1': 0.375, '1-0': 0 })
    expect(fillInOrder(set, 45)).toEqual({ '0-0': 1, '0-1': 1, '1-0': 1 })
    expect(fillInOrder(set, -3)).toEqual({ '0-0': 0, '0-1': 0, '1-0': 0 })
  })
})
