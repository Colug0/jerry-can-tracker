import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionHandler, Plugin, ServerAPI } from '@signalk/server-api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import createPlugin from '../src/index.js'
import { LevelStore } from '../src/store.js'

type Handler = (req: { params?: Record<string, string>; body?: unknown }, res: FakeRes) => void
interface FakeRes {
  code: number
  data: unknown
  status(code: number): FakeRes
  json(value: unknown): void
}

interface Fake {
  app: ServerAPI
  statuses: string[]
  errors: string[]
  deltas: Array<{ updates: Array<{ values: Array<{ path: string; value: unknown }> }> }>
  puts: Map<string, ActionHandler>
  meta: Map<string, unknown>
  routes: Map<string, { access: string; handler: Handler }>
}

function fakeApp(dir: string): Fake {
  const f: Fake = {
    app: undefined as unknown as ServerAPI,
    statuses: [],
    errors: [],
    deltas: [],
    puts: new Map(),
    meta: new Map(),
    routes: new Map()
  }
  f.app = {
    getDataDirPath: () => dir,
    setPluginStatus: (m: string) => f.statuses.push(m),
    setPluginError: (m: string) => f.errors.push(m),
    error: (m: string) => f.errors.push(m),
    debug: () => {},
    handleMessage: (_id: string, delta: Fake['deltas'][number]) => f.deltas.push(delta),
    registerPutHandler: (_ctx: string, path: string, handler: ActionHandler) => f.puts.set(path, handler),
    setDefaultMetadata: async (path: string, meta: unknown) => {
      f.meta.set(path, meta)
      return true
    }
  } as unknown as ServerAPI
  return f
}

function fakeRouter(f: Fake) {
  const reg = (access: string) => ({
    get: (p: string, h: Handler) => f.routes.set(`GET ${p}`, { access, handler: h }),
    post: (p: string, h: Handler) => f.routes.set(`POST ${p}`, { access, handler: h })
  })
  return { ...reg('admin'), access: (level: string) => reg(level) }
}

function call(f: Fake, route: string, params: Record<string, string> = {}, body?: unknown): FakeRes {
  const r = f.routes.get(route)
  if (!r) throw new Error(`no route ${route}`)
  const res: FakeRes = {
    code: 200,
    data: undefined,
    status(code) {
      this.code = code
      return this
    },
    json(value) {
      this.data = value
    }
  }
  r.handler({ params, body }, res)
  return res
}

function latest(f: Fake): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const d of f.deltas) for (const u of d.updates) for (const v of u.values) out[v.path] = v.value
  return out
}

const config = {
  sets: [
    {
      id: 'dieselCans',
      name: 'Diesel jerry cans',
      kind: 'fuel',
      fluid: 'diesel',
      cans: [
        { name: '20 L', capacity: 20, count: 2 },
        { name: '5 L', capacity: 5 }
      ]
    },
    { id: 'petrolCans', name: 'Petrol', kind: 'fuel', fluid: 'petrol', cans: [{ name: 'Red', capacity: 10 }] }
  ]
}

let dir: string
let f: Fake
let plugin: Plugin

async function start(cfg: object = config): Promise<void> {
  plugin = createPlugin(f.app)
  plugin.registerWithRouter?.(fakeRouter(f) as never)
  const before = f.statuses.length + f.errors.length
  plugin.start(cfg, () => {})
  await vi.waitFor(() => {
    if (f.statuses.length + f.errors.length === before) throw new Error('not started')
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jct-'))
  f = fakeApp(dir)
})
afterEach(async () => {
  plugin?.stop()
  // load() waits for writes still queued, which would otherwise race the rm
  await new LevelStore(dir).load().catch(() => {})
  await rm(dir, { recursive: true, force: true })
})

describe('plugin', () => {
  it('publishes each set as a tank in SI units', async () => {
    await start()
    const v = latest(f)
    expect(v['tanks.fuel.dieselCans.name']).toBe('Diesel jerry cans')
    expect(v['tanks.fuel.dieselCans.type']).toBe('diesel')
    expect(v['tanks.fuel.dieselCans.capacity']).toBeCloseTo(0.045)
    expect(v['tanks.fuel.dieselCans.currentVolume']).toBe(0)
    expect(v['tanks.fuel.dieselCans.currentLevel']).toBe(0)
    expect(v['tanks.fuel.petrolCans.capacity']).toBeCloseTo(0.01)
    expect(Object.keys(v).some((p) => p.includes('cans.'))).toBe(false)
    expect(f.statuses.at(-1)).toBe('Diesel jerry cans: 0 of 45 L · Petrol: 0 of 10 L')
    await vi.waitFor(() => expect(f.meta.get('tanks.fuel.dieselCans.currentLevel')).toEqual({ updateContract: 'event' }))
  })

  it('accepts a PUT on currentVolume and fills cans in order', async () => {
    await start()
    const result = f.puts.get('tanks.fuel.dieselCans.currentVolume')!('vessels.self', 'x', 0.03, () => {})
    expect(result).toMatchObject({ state: 'COMPLETED', statusCode: 200 })
    expect(latest(f)['tanks.fuel.dieselCans.currentVolume']).toBeCloseTo(0.03)
    const view = call(f, 'GET /api/sets/:id', { id: 'dieselCans' }).data as { cans: Array<{ level: number }> }
    expect(view.cans.map((c) => c.level)).toEqual([1, 0.5, 0])
  })

  it('accepts a PUT on currentLevel and rejects out-of-range values', async () => {
    await start()
    const put = f.puts.get('tanks.fuel.petrolCans.currentLevel')!
    expect(put('vessels.self', 'x', 0.5, () => {})).toMatchObject({ statusCode: 200 })
    expect(latest(f)['tanks.fuel.petrolCans.currentVolume']).toBeCloseTo(0.005)
    expect(put('vessels.self', 'x', 1.5, () => {})).toMatchObject({ statusCode: 400 })
    expect(put('vessels.self', 'x', 'full', () => {})).toMatchObject({ statusCode: 400 })
    expect(
      f.puts.get('tanks.fuel.petrolCans.currentVolume')!('vessels.self', 'x', 0.02, () => {})
    ).toMatchObject({ statusCode: 400 })
  })

  it('serves the webapp API with the right access levels', async () => {
    await start()
    expect(f.routes.get('GET /api/sets')!.access).toBe('readonly')
    expect(f.routes.get('POST /api/sets/:id/cans/:key')!.access).toBe('readwrite')

    let res = call(f, 'POST /api/sets/:id/fill', { id: 'dieselCans' })
    expect(res.data).toMatchObject({ volume: 45, level: 1 })
    res = call(f, 'POST /api/sets/:id/cans/:key', { id: 'dieselCans', key: '1-0' }, { level: 0 })
    expect(res.data).toMatchObject({ volume: 40 })
    res = call(f, 'POST /api/sets/:id/volume', { id: 'dieselCans' }, { volume: 12 })
    expect(res.data).toMatchObject({ volume: 12 })
    res = call(f, 'POST /api/sets/:id/empty', { id: 'dieselCans' })
    expect(res.data).toMatchObject({ volume: 0 })

    expect(call(f, 'POST /api/sets/:id/fill', { id: 'nope' }).code).toBe(404)
    expect(call(f, 'POST /api/sets/:id/cans/:key', { id: 'dieselCans', key: '7-0' }, { level: 1 }).code).toBe(404)
    expect(call(f, 'POST /api/sets/:id/cans/:key', { id: 'dieselCans', key: '0-0' }, { level: 2 }).code).toBe(400)
    expect(call(f, 'POST /api/sets/:id/volume', { id: 'dieselCans' }, { volume: 46 }).code).toBe(400)
  })

  it('keeps fill levels across restarts and config changes', async () => {
    await start()
    call(f, 'POST /api/sets/:id/fill', { id: 'dieselCans' })
    await vi.waitFor(async () => {
      const saved = JSON.parse(await readFile(join(dir, 'levels.json'), 'utf8'))
      expect(saved.dieselCans['0-0']).toBe(1)
    })
    plugin.stop()

    const changed = structuredClone(config)
    changed.sets[0].cans.push({ name: 'New', capacity: 10 })
    f.deltas = []
    await start(changed)
    const v = latest(f)
    expect(v['tanks.fuel.dieselCans.capacity']).toBeCloseTo(0.055)
    expect(v['tanks.fuel.dieselCans.currentVolume']).toBeCloseTo(0.045)
    expect((await lstat(join(dir, 'levels.json.tmp')).catch(() => undefined)) === undefined).toBe(true)
  })

  it('reports invalid sets but runs the valid ones', async () => {
    await start({ sets: [config.sets[0], { id: 'bad id', name: 'Bad', kind: 'fuel', cans: [] }] })
    await vi.waitFor(() => expect(f.errors.at(-1)).toContain('Diesel jerry cans: 0 of 45 L'))
    expect(f.errors.at(-1)).toContain('invalid id')
    expect(latest(f)['tanks.fuel.dieselCans.capacity']).toBeCloseTo(0.045)
  })

  it('clears its values on stop, so a removed set does not look current', async () => {
    await start()
    call(f, 'POST /api/sets/:id/fill', { id: 'petrolCans' })
    plugin.stop()
    const v = latest(f)
    expect(v['tanks.fuel.petrolCans.currentVolume']).toBeNull()
    expect(v['tanks.fuel.dieselCans.capacity']).toBeNull()
    await start({ sets: [config.sets[0]] })
    const after = latest(f)
    expect(after['tanks.fuel.petrolCans.currentVolume']).toBeNull()
    expect(after['tanks.fuel.dieselCans.capacity']).toBeCloseTo(0.045)
  })

  it('answers 503 and rejects PUTs while stopped', async () => {
    await start()
    const put = f.puts.get('tanks.fuel.dieselCans.currentVolume')!
    plugin.stop()
    expect(call(f, 'GET /api/sets').code).toBe(503)
    expect(put('vessels.self', 'x', 0, () => {})).toMatchObject({ statusCode: 404 })
  })

  it('starts with a corrupt levels file reported as an error', async () => {
    await writeFile(join(dir, 'levels.json'), '{nope', 'utf8')
    await start()
    expect(f.errors.at(-1)).toContain('Could not load fill levels')
  })
})
