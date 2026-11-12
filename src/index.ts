import type { ActionResult, Plugin, ServerAPI } from '@signalk/server-api'
import { registerApi, type RouterLike } from './api.js'
import { buildSets, reconcile } from './model.js'
import { ConfigSchema } from './schema.js'
import { LevelStore } from './store.js'
import { BadValue, errorStatus, NotFound, setPath, Tracker } from './tracker.js'

const PLUGIN_ID = 'jerry-can-tracker'

/** Values that only change when someone changes them: never stale. */
const EVENT_PATHS = ['capacity', 'currentVolume', 'currentLevel'] as const

export default function createPlugin(app: ServerAPI): Plugin {
  let tracker: Tracker | undefined
  let generation = 0

  const failed = (error: unknown): ActionResult => ({
    state: 'COMPLETED',
    statusCode: errorStatus(error),
    message: error instanceof Error ? error.message : String(error)
  })

  /**
   * Bad values are answered at once; a valid change answers PENDING and
   * completes once the new levels are saved.
   */
  const registerPut = (path: string, apply: (t: Tracker, value: unknown) => Promise<unknown>): void => {
    app.registerPutHandler('vessels.self', path, (_ctx, _path, value, callback) => {
      let pending: Promise<unknown>
      try {
        // Handlers cannot be removed; one left over from an earlier start
        // finds no running tracker or no set with that id.
        if (!tracker) throw new NotFound('the plugin is not running')
        pending = apply(tracker, value)
      } catch (error) {
        return failed(error)
      }
      pending.then(
        () => callback({ state: 'COMPLETED', statusCode: 200 }),
        (error: unknown) => callback(failed(error))
      )
      return { state: 'PENDING' }
    })
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Jerry Can Tracker',
    description: 'Sets of jerry cans as extra tanks in Signal K',
    schema: () => ConfigSchema,

    start(config: object) {
      const run = ++generation
      const { sets, errors } = buildSets((config as { sets?: unknown }).sets)
      for (const e of errors) app.error(e)
      const store = new LevelStore(app.getDataDirPath())
      store
        .load()
        .then(async (stored) => {
          if (run !== generation) return
          const levels = reconcile(sets, stored)
          await store.save(levels)
          if (run !== generation) return
          const t = new Tracker(app, PLUGIN_ID, sets, levels, store)
          tracker = t
          for (const set of sets) {
            const base = setPath(set)
            registerPut(`${base}.currentLevel`, (tr, value) => {
              const s = tr.find(set.id)
              const level = typeof value === 'number' ? value : NaN
              if (!Number.isFinite(level) || level < 0 || level > 1) {
                throw new BadValue('currentLevel must be a ratio between 0 and 1')
              }
              return tr.setVolume(s.id, tr.view(s).capacity * level)
            })
            registerPut(`${base}.currentVolume`, (tr, value) => {
              if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new BadValue('currentVolume must be a number in m3')
              }
              return tr.setVolume(set.id, value * 1000)
            })
          }
          t.publish()
          setMetadata(app, sets.map(setPath))
          const status = t.status()
          if (errors.length > 0) app.setPluginError(`${errors.join('; ')} | ${status}`)
          else app.setPluginStatus(status)
        })
        .catch((error: unknown) => {
          if (run === generation) app.setPluginError(`Could not load fill levels: ${String(error)}`)
        })
    },

    stop() {
      generation++
      tracker?.clear()
      tracker = undefined
    },

    registerWithRouter(router) {
      registerApi(router as unknown as RouterLike, () => tracker)
    }
  }
  return plugin
}

function setMetadata(app: ServerAPI, bases: string[]): void {
  if (typeof app.setDefaultMetadata !== 'function') return // server < 2.30
  void (async () => {
    for (const base of bases) {
      for (const leaf of EVENT_PATHS) {
        try {
          await app.setDefaultMetadata(`${base}.${leaf}`, { updateContract: 'event' })
        } catch (error) {
          app.error(`Could not set metadata for ${base}.${leaf}: ${String(error)}`)
        }
      }
    }
  })()
}
