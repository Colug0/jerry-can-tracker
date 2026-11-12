import { FLUID_TYPES, SET_ID_PATTERN, TANK_KINDS, type SetConfig, type TankKind } from './schema.js'

/** One physical can. `capacity` is in litres. */
export interface Can {
  key: string
  name: string
  capacity: number
}

export interface CanSet {
  id: string
  name: string
  kind: TankKind
  fluid?: string
  cans: Can[]
}

/** Fill ratio (0..1) per can key, per set id. */
export type Levels = Record<string, Record<string, number>>

export interface Totals {
  /** litres */
  capacity: number
  /** litres */
  volume: number
  /** 0..1, undefined without capacity */
  level: number | undefined
}

const idPattern = new RegExp(SET_ID_PATTERN)

/**
 * Turns the configured sets into cans with stable keys. A can line with
 * `count: 3` becomes three cans. Keys follow the position in the
 * configuration (`<line>-<n>`), so reordering lines moves fill levels.
 * Invalid sets are left out and reported in `errors`.
 */
export function buildSets(configured: unknown): { sets: CanSet[]; errors: string[] } {
  const sets: CanSet[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  const list = Array.isArray(configured) ? (configured as Partial<SetConfig>[]) : []
  list.forEach((s, i) => {
    const label = typeof s?.name === 'string' && s.name !== '' ? `"${s.name}"` : `#${i + 1}`
    const id = typeof s?.id === 'string' ? s.id : ''
    if (!idPattern.test(id)) {
      errors.push(`Set ${label}: invalid id "${id}"`)
      return
    }
    const kind = (TANK_KINDS as readonly string[]).includes(s.kind as string) ? (s.kind as TankKind) : 'fuel'
    const pathKey = `${kind}.${id}`
    if (seen.has(pathKey)) {
      errors.push(`Set ${label}: tanks.${pathKey} is used twice`)
      return
    }
    const cans: Can[] = []
    ;(Array.isArray(s.cans) ? s.cans : []).forEach((c, line) => {
      const capacity = Number(c?.capacity)
      if (!Number.isFinite(capacity) || capacity <= 0) {
        errors.push(`Set ${label}: can ${line + 1} has no valid capacity`)
        return
      }
      const count = Number.isInteger(c?.count) && (c.count as number) > 0 ? (c.count as number) : 1
      const name = typeof c?.name === 'string' && c.name !== '' ? c.name : `Can ${line + 1}`
      for (let n = 0; n < count; n++) {
        cans.push({ key: `${line}-${n}`, name: count > 1 ? `${name} ${n + 1}` : name, capacity })
      }
    })
    if (cans.length === 0) {
      errors.push(`Set ${label}: no cans`)
      return
    }
    seen.add(pathKey)
    const fluid = (FLUID_TYPES as readonly string[]).includes(s.fluid as string) ? (s.fluid as string) : undefined
    sets.push({ id, name: typeof s.name === 'string' && s.name !== '' ? s.name : id, kind, fluid, cans })
  })
  return { sets, errors }
}

export function clampRatio(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

/**
 * Keeps the stored level of every can that still exists; new cans start
 * empty, removed cans and sets are dropped.
 */
export function reconcile(sets: CanSet[], stored: unknown): Levels {
  const old = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
  const levels: Levels = {}
  for (const set of sets) {
    const before = old[set.id] && typeof old[set.id] === 'object' ? (old[set.id] as Record<string, unknown>) : {}
    levels[set.id] = {}
    for (const can of set.cans) {
      const v = before[can.key]
      levels[set.id][can.key] = typeof v === 'number' ? clampRatio(v) : 0
    }
  }
  return levels
}

export function totals(set: CanSet, levels: Record<string, number>): Totals {
  let capacity = 0
  let volume = 0
  for (const can of set.cans) {
    capacity += can.capacity
    volume += can.capacity * clampRatio(levels[can.key] ?? 0)
  }
  return { capacity, volume, level: capacity > 0 ? volume / capacity : undefined }
}

/**
 * Spreads a total volume (litres) over the cans in configured order: the
 * first cans are full, one can is partly filled, the rest are empty. That is
 * how jerry cans usually are on board.
 */
export function fillInOrder(set: CanSet, litres: number): Record<string, number> {
  let left = Math.max(0, Number.isFinite(litres) ? litres : 0)
  const out: Record<string, number> = {}
  for (const can of set.cans) {
    const put = Math.min(can.capacity, left)
    out[can.key] = can.capacity > 0 ? put / can.capacity : 0
    left -= put
  }
  return out
}

/** Rounds to 0.1 litre for display and status messages. */
export function litres(v: number): string {
  return (Math.round(v * 10) / 10).toString()
}
