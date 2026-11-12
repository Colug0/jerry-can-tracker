const API = '/plugins/jerry-can-tracker/api'
const REFRESH_MS = 10_000

const setsEl = document.getElementById('sets')
const messageEl = document.getElementById('message')
const setTemplate = document.getElementById('set-template')
const canTemplate = document.getElementById('can-template')

/** Set ids with a request in flight; a refresh must not overwrite their controls. */
const busy = new Set()

/**
 * Counts the changes started per set. A refresh whose GET began before a
 * change may answer after it, with the old levels, so it skips that set.
 */
const revisions = new Map()
const revision = (id) => revisions.get(id) ?? 0

function fmt(litres) {
  return (Math.round(litres * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })
}

function showMessage(text, kind = 'error') {
  messageEl.textContent = text
  messageEl.className = `message ${kind}`
  messageEl.hidden = !text
}

async function request(path, options = {}) {
  const res = await fetch(API + path, {
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      options.method === 'POST'
        ? 'You need read/write access to change fill levels. Log in to Signal K first.'
        : 'Log in to Signal K to see the jerry cans.'
    )
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

function post(path, body) {
  return request(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
}

function renderSet(set) {
  let el = setsEl.querySelector(`[data-set="${CSS.escape(set.id)}"]`)
  if (!el) {
    el = setTemplate.content.firstElementChild.cloneNode(true)
    el.dataset.set = set.id
    el.querySelector('[data-action="fill"]').addEventListener('click', () => change(set.id, `/sets/${enc(set.id)}/fill`))
    el.querySelector('[data-action="empty"]').addEventListener('click', () => change(set.id, `/sets/${enc(set.id)}/empty`))
    el.querySelector('.volume-form').addEventListener('submit', (ev) => {
      ev.preventDefault()
      const input = ev.target.elements.volume
      const volume = Number(input.value)
      if (input.value === '' || !Number.isFinite(volume)) return
      input.value = ''
      input.blur()
      change(set.id, `/sets/${enc(set.id)}/volume`, { volume })
    })
    setsEl.appendChild(el)
  }
  el.querySelector('.set-name').textContent = set.name
  el.querySelector('.set-path').textContent = set.path
  el.querySelector('.set-total').textContent = `${fmt(set.volume)} / ${fmt(set.capacity)} L`
  const pct = Math.round((set.level ?? 0) * 100)
  const fill = el.querySelector('.bar-fill')
  fill.style.width = `${pct}%`
  fill.classList.toggle('low', pct <= 25)
  const volumeInput = el.querySelector('.volume-form input')
  volumeInput.max = String(set.capacity)
  if (document.activeElement !== volumeInput) volumeInput.placeholder = fmt(set.volume)

  const list = el.querySelector('.cans')
  const keys = set.cans.map((c) => c.key)
  for (const li of [...list.children]) if (!keys.includes(li.dataset.can)) li.remove()
  for (const can of set.cans) {
    let li = list.querySelector(`[data-can="${CSS.escape(can.key)}"]`)
    if (!li) {
      li = canTemplate.content.firstElementChild.cloneNode(true)
      li.dataset.can = can.key
      const path = `/sets/${enc(set.id)}/cans/${enc(can.key)}`
      for (const b of li.querySelectorAll('button[data-level]')) {
        b.addEventListener('click', () => change(set.id, path, { level: Number(b.dataset.level) }))
      }
      const range = li.querySelector('input[type="range"]')
      range.addEventListener('input', () => {
        li.querySelector('.can-volume').textContent = canText(can, Number(range.value) / 100)
      })
      range.addEventListener('change', () => change(set.id, path, { level: Number(range.value) / 100 }))
      list.appendChild(li)
    }
    li.querySelector('.can-name').textContent = can.name
    li.querySelector('.can-volume').textContent = canText(can, can.level)
    const range = li.querySelector('input[type="range"]')
    if (document.activeElement !== range) range.value = String(Math.round(can.level * 100))
  }
}

function canText(can, level) {
  return `${fmt(can.capacity * level)} / ${fmt(can.capacity)} L · ${Math.round(level * 100)} %`
}

function enc(s) {
  return encodeURIComponent(s)
}

function setBusy(id, on) {
  const el = setsEl.querySelector(`[data-set="${CSS.escape(id)}"]`)
  if (on) busy.add(id)
  else busy.delete(id)
  if (el) for (const c of el.querySelectorAll('button, input')) c.disabled = on
}

function bump(id) {
  revisions.set(id, revision(id) + 1)
}

async function change(id, path, body) {
  bump(id)
  setBusy(id, true)
  try {
    renderSet(await post(path, body))
    showMessage('')
  } catch (error) {
    showMessage(error.message)
    // Show the server's levels for this set again; a refresh already in
    // flight may hold levels from before this attempt.
    bump(id)
    await refresh(id)
  } finally {
    // The server switches to the new levels only once they are saved, so a
    // refresh that started while this change ran may still carry old ones.
    bump(id)
    setBusy(id, false)
  }
}

/** Reloads all sets; `forceId` is rendered even while its change is busy. */
async function refresh(forceId) {
  const started = new Map(revisions)
  try {
    const sets = await request('/sets')
    const ids = sets.map((s) => s.id)
    for (const el of [...setsEl.children]) if (!ids.includes(el.dataset.set)) el.remove()
    for (const set of sets) {
      if (revision(set.id) !== (started.get(set.id) ?? 0)) continue
      if (set.id === forceId || !busy.has(set.id)) renderSet(set)
    }
    if (sets.length === 0) {
      showMessage('No sets yet. Add sets of jerry cans in the plugin configuration (Server → Plugin Config → Jerry Can Tracker).', 'info')
    } else if (messageEl.classList.contains('info') || forceId === undefined) {
      showMessage('')
    }
  } catch (error) {
    showMessage(error.message)
  }
}

refresh()
setInterval(() => {
  if (document.visibilityState === 'visible') refresh()
}, REFRESH_MS)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh()
})
