import type { Path, PathValue, ServerAPI } from '@signalk/server-api'
import { clampRatio, fillInOrder, litres, totals, type Can, type CanSet, type Levels } from './model.js'
import type { LevelStore } from './store.js'

export interface CanView extends Can {
  level: number
}

export interface SetView {
  id: string
  name: string
  kind: string
  fluid?: string
  path: string
  /** litres */
  capacity: number
  /** litres */
  volume: number
  level: number | undefined
  cans: CanView[]
}

export class NotFound extends Error {}
export class BadValue extends Error {}
export class SaveFailed extends Error {}

/** HTTP status for an error from the tracker. */
export function errorStatus(error: unknown): number {
  return error instanceof NotFound ? 404 : error instanceof BadValue ? 400 : 500
}

/** Base path of a set in the data model, e.g. `tanks.fuel.dieselCans`. */
export function setPath(set: CanSet): string {
  return `tanks.${set.kind}.${set.id}`
}

/** Holds the sets and their fill levels while the plugin runs. */
export class Tracker {
  constructor(
    private readonly app: ServerAPI,
    private readonly pluginId: string,
    readonly sets: CanSet[],
    private readonly levels: Levels,
    private readonly store: LevelStore
  ) {}

  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  find(id: string): CanSet {
    const set = this.sets.find((s) => s.id === id)
    if (!set) throw new NotFound(`unknown set "${id}"`)
    return set
  }

  view(set: CanSet): SetView {
    const levels = this.levels[set.id]
    return {
      id: set.id,
      name: set.name,
      kind: set.kind,
      fluid: set.fluid,
      path: setPath(set),
      ...totals(set, levels),
      cans: set.cans.map((c) => ({ ...c, level: levels[c.key] ?? 0 }))
    }
  }

  views(): SetView[] {
    return this.sets.map((s) => this.view(s))
  }

  /** Sets one can to a fill ratio (0..1). */
  setCan(id: string, key: string, level: unknown): Promise<SetView> {
    const set = this.find(id)
    if (!set.cans.some((c) => c.key === key)) throw new NotFound(`unknown can "${key}" in set "${id}"`)
    const r = ratio(level)
    return this.mutate(set, (current) => ({ ...current, [key]: r }))
  }

  /** Sets every can of a set to the same fill ratio (1 = all full). */
  setAll(id: string, level: unknown): Promise<SetView> {
    const set = this.find(id)
    const r = ratio(level)
    return this.mutate(set, () => Object.fromEntries(set.cans.map((c) => [c.key, r])))
  }

  /** Spreads a total volume in litres over the cans, first cans first. */
  setVolume(id: string, volume: unknown): Promise<SetView> {
    const set = this.find(id)
    const capacity = set.cans.reduce((sum, c) => sum + c.capacity, 0)
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > capacity + 1e-9) {
      throw new BadValue(`volume must be between 0 and ${litres(capacity)} litres`)
    }
    return this.mutate(set, () => fillInOrder(set, volume))
  }

  publish(sets: CanSet[] = this.sets): void {
    const values: PathValue[] = []
    for (const set of sets) {
      const base = setPath(set)
      const t = totals(set, this.levels[set.id])
      values.push({ path: `${base}.name` as Path, value: set.name })
      if (set.fluid) values.push({ path: `${base}.type` as Path, value: set.fluid })
      values.push({ path: `${base}.capacity` as Path, value: t.capacity / 1000 })
      values.push({ path: `${base}.currentVolume` as Path, value: t.volume / 1000 })
      if (t.level !== undefined) values.push({ path: `${base}.currentLevel` as Path, value: t.level })
    }
    if (values.length > 0) this.app.handleMessage(this.pluginId, { updates: [{ values }] })
  }

  /**
   * Sets every published value to null. Called on stop, so a set that was
   * removed or a disabled plugin leaves no level that looks current (the
   * values are event data and never time out).
   */
  clear(): void {
    this.closed = true
    const values: PathValue[] = []
    for (const set of this.sets) {
      const base = setPath(set)
      for (const leaf of ['name', 'type', 'capacity', 'currentVolume', 'currentLevel']) {
        values.push({ path: `${base}.${leaf}` as Path, value: null })
      }
    }
    if (values.length > 0) this.app.handleMessage(this.pluginId, { updates: [{ values }] })
  }

  status(): string {
    if (this.sets.length === 0) return 'No sets configured'
    return this.sets
      .map((s) => {
        const t = totals(s, this.levels[s.id])
        return `${s.name}: ${litres(t.volume)} of ${litres(t.capacity)} L`
      })
      .join(' · ')
  }

  /**
   * Applies a change once the new levels are saved, so a reported success
   * survives a restart. Changes run one after another, each on the levels
   * the previous one left. Invalid input is rejected by the caller before
   * this, synchronously; the returned promise rejects with SaveFailed, or
   * NotFound when the plugin stopped before the change ran.
   */
  private mutate(set: CanSet, next: (current: Record<string, number>) => Record<string, number>): Promise<SetView> {
    const run = async (): Promise<SetView> => {
      // A queued change must not overwrite the file once a restarted plugin
      // has read it.
      if (this.closed) throw new NotFound('the plugin is not running')
      const levels = next({ ...this.levels[set.id] })
      try {
        await this.store.save({ ...this.levels, [set.id]: levels })
      } catch (error) {
        this.app.error(`Could not save fill levels: ${String(error)}`)
        throw new SaveFailed('could not save the fill levels; nothing was changed')
      }
      this.levels[set.id] = levels
      if (!this.closed) {
        this.publish([set])
        this.app.setPluginStatus(this.status())
      }
      return this.view(set)
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }
}

function ratio(level: unknown): number {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) {
    throw new BadValue('level must be a number between 0 and 1')
  }
  return clampRatio(level)
}
