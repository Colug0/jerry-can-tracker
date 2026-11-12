import { lstat, readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../src/schema.js'

describe('package', () => {
  it('ships the app icon as a regular SVG file', async () => {
    const url = new URL('../public/icon.svg', import.meta.url)
    expect((await lstat(url)).isFile()).toBe(true)
    expect(await readFile(url, 'utf8')).toContain('<svg')
  })

  it('has a config schema the admin UI can render', () => {
    const schema = JSON.parse(JSON.stringify(ConfigSchema)) as {
      properties: { sets: { items: { properties: Record<string, { enum?: string[] }>; required: string[] } } }
    }
    const set = schema.properties.sets.items
    expect(set.properties.kind.enum).toContain('fuel')
    expect(set.required).toEqual(['id', 'name', 'kind', 'cans'])
  })
})
