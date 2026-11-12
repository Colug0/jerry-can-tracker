import { BadValue, NotFound, type Tracker } from './tracker.js'

interface Req {
  params?: Record<string, string>
  body?: unknown
}
interface Res {
  status(code: number): Res
  json(value: unknown): void
}
type Handler = (req: Req, res: Res) => void

interface Registrar {
  get(path: string, handler: Handler): unknown
  post(path: string, handler: Handler): unknown
}

/** Minimal view of the server's plugin router; `access` exists from Signal K 2.35 on. */
export interface RouterLike extends Registrar {
  access?: (level: 'readwrite' | 'readonly') => Registrar
}

function body(req: Req): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
}

/**
 * REST API for the webapp, mounted at /plugins/jerry-can-tracker.
 * On servers with route access levels, reading needs read-only access and
 * changing levels read/write access; older servers keep every route admin-only.
 * Volumes are in litres, levels are ratios from 0 to 1.
 */
export function registerApi(router: RouterLike, tracker: () => Tracker | undefined): void {
  const rw: Registrar = typeof router.access === 'function' ? router.access('readwrite') : router
  const ro: Registrar = typeof router.access === 'function' ? router.access('readonly') : router

  const handle =
    (fn: (t: Tracker, req: Req) => unknown): Handler =>
    (req, res) => {
      const t = tracker()
      if (!t) {
        res.status(503).json({ error: 'the plugin is not running' })
        return
      }
      try {
        res.json(fn(t, req))
      } catch (error) {
        const code = error instanceof NotFound ? 404 : error instanceof BadValue ? 400 : 500
        res.status(code).json({ error: error instanceof Error ? error.message : String(error) })
      }
    }
  const param = (req: Req, name: string): string => req.params?.[name] ?? ''

  ro.get(
    '/api/sets',
    handle((t) => t.views())
  )
  ro.get(
    '/api/sets/:id',
    handle((t, req) => t.view(t.find(param(req, 'id'))))
  )
  rw.post(
    '/api/sets/:id/cans/:key',
    handle((t, req) => t.setCan(param(req, 'id'), param(req, 'key'), body(req).level))
  )
  rw.post(
    '/api/sets/:id/fill',
    handle((t, req) => t.setAll(param(req, 'id'), 1))
  )
  rw.post(
    '/api/sets/:id/empty',
    handle((t, req) => t.setAll(param(req, 'id'), 0))
  )
  rw.post(
    '/api/sets/:id/volume',
    handle((t, req) => t.setVolume(param(req, 'id'), body(req).volume))
  )
}
