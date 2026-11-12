import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Levels } from './model.js'

const FILE = 'levels.json'

/**
 * Pending writes per directory. Shared by all stores, because a plugin
 * restart creates a new store while the old one may still be writing, and
 * two writers on the same temporary file break the rename.
 */
const queues = new Map<string, Promise<void>>()

/**
 * Keeps the fill levels in the plugin's data directory, so they survive
 * restarts and plugin updates, and changing them does not touch the plugin
 * configuration (which would restart the plugin).
 */
export class LevelStore {
  constructor(private readonly dir: string) {}

  /** Waits for pending writes, so a restart reads the latest levels. */
  async load(): Promise<unknown> {
    await queues.get(this.dir)
    try {
      return JSON.parse(await readFile(join(this.dir, FILE), 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  /** Writes are queued and replace the file atomically. */
  save(levels: Levels): Promise<void> {
    const data = JSON.stringify(levels, null, 2)
    const run = async (): Promise<void> => {
      const tmp = join(this.dir, `${FILE}.tmp`)
      await writeFile(tmp, data, 'utf8')
      await rename(tmp, join(this.dir, FILE))
    }
    const next = (queues.get(this.dir) ?? Promise.resolve()).then(run, run)
    queues.set(
      this.dir,
      next.catch(() => {})
    )
    return next
  }
}
