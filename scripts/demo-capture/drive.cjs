// Drives the built faibots window for the desktop recording.
// Launched by run.cjs with the same Electron runtime the Windows checks workflow uses.

const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

const sourceRoot = resolve(__dirname, '..', '..')
const marker = process.argv.indexOf('--')
const demoArgs = marker >= 0 ? process.argv.slice(marker + 1) : process.argv.slice(-3)
const [profile, baseUrl, outDir] = demoArgs
const logPath = outDir ? join(outDir, 'electron.log') : ''

function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  console.log(text)
  try { appendFileSync(logPath, text + '\n') } catch { /* logging must not hide the real error */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function roundTenth(value) {
  return (Math.round(value * 10) / 10).toFixed(1)
}

if (!process.versions.electron) {
  console.error('drive.cjs runs inside Electron. Start scripts/demo-capture/run.cjs instead.')
  process.exit(1)
}

const { app, BrowserWindow, Menu, screen } = require('electron')

if (!profile || !baseUrl || !outDir) {
  console.error('Missing demo arguments', process.argv)
  app.exit(1)
}
log(`electron ${process.versions.electron} profile=${profile} base=${baseUrl}`)
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.setPath('userData', profile)
delete process.env.ELECTRON_RENDERER_URL

let videoStartedAt = 0
const shots = []
let openShot = null

function seconds() {
  return (Date.now() - videoStartedAt) / 1000
}

function beginShot(n) {
  openShot = { n, start: seconds(), proof: null }
  log(`shot ${n} start ${roundTenth(openShot.start)}`)
}

function markProof() {
  if (openShot) openShot.proof = seconds()
}

function endShot() {
  if (!openShot) return
  openShot.end = seconds()
  shots.push(openShot)
  log(`shot ${openShot.n} end ${roundTenth(openShot.end)}`)
  openShot = null
}

function writeShots() {
  const lines = shots
    .slice()
    .sort((a, b) => a.n - b.n)
    .map((shot) => `${roundTenth(shot.start)} ${roundTenth(shot.end)}`)
  writeFileSync(join(outDir, 'shots.txt'), lines.join('\n') + '\n')
  writeFileSync(join(outDir, 'shots.json'), JSON.stringify(shots, null, 2))
}

async function evalJs(win, source) {
  return win.webContents.executeJavaScript(source)
}

async function invoke(win, channel, args) {
  return evalJs(win, `window.faibots.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`)
}

async function pageText(win) {
  return evalJs(win, `document.body ? document.body.innerText.slice(0, 2500) : ''`)
}

async function waitFor(win, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      if (await evalJs(win, expression)) return
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    await sleep(120)
  }
  const text = await pageText(win).catch(() => '')
  throw new Error(`Timed out waiting for ${label}. ${last}\n${text}`)
}

async function clickButton(win, text) {
  const ok = await evalJs(win, `(() => {
    const wanted = ${JSON.stringify(text)}
    const el = [...document.querySelectorAll('button')].find((button) => (button.innerText || '').replace(/\\s+/g, ' ').trim() === wanted)
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!ok) throw new Error(`Could not find the button "${text}".\n${await pageText(win)}`)
}

async function clickSelector(win, selector) {
  const ok = await evalJs(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    el.click()
    return true
  })()`)
  if (!ok) throw new Error(`Could not find ${selector}.\n${await pageText(win)}`)
}

async function typeInto(win, selector, text, perCharMs) {
  await evalJs(win, `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('Missing field ${selector}')
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set
    const write = (next) => {
      const previous = el.value
      set.call(el, next)
      if (el._valueTracker) el._valueTracker.setValue(previous)
      el.focus()
      el.setSelectionRange(next.length, next.length)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    let value = ''
    for (const ch of ${JSON.stringify(text)}) {
      value += ch
      write(value)
      await new Promise((resolve) => setTimeout(resolve, ${perCharMs}))
    }
    if (el.value !== ${JSON.stringify(text)}) throw new Error('Field value is "' + el.value + '"')
  })()`)
}

async function typeMore(win, selector, extra, perCharMs) {
  await evalJs(win, `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('Missing field ${selector}')
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set
    let value = el.value
    for (const ch of ${JSON.stringify(extra)}) {
      const previous = value
      value += ch
      set.call(el, value)
      if (el._valueTracker) el._valueTracker.setValue(previous)
      el.focus()
      el.setSelectionRange(value.length, value.length)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, ${perCharMs}))
    }
  })()`)
}

async function pressEnter(win, selector) {
  await evalJs(win, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) throw new Error('Missing field ${selector}')
    el.focus()
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }))
  })()`)
}

function fit(win, strict = false) {
  Menu.setApplicationMenu(null)
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  win.setContentSize(1280, 720)
  const display = screen.getPrimaryDisplay()
  const area = display.workArea
  const bounds = win.getBounds()
  const content = win.getContentSize()
  log(`display ${display.size.width}x${display.size.height} scale ${display.scaleFactor} work ${area.width}x${area.height} window ${bounds.width}x${bounds.height} content ${content.join('x')}`)
  if (bounds.width > area.width || bounds.height > area.height) {
    const message = `Window ${bounds.width}x${bounds.height} does not fit the work area ${area.width}x${area.height}.`
    if (strict) throw new Error(message)
    log(message)
    return
  }
  win.setPosition(
    area.x + Math.floor((area.width - bounds.width) / 2),
    area.y + Math.floor((area.height - bounds.height) / 2)
  )
  win.setContentSize(1280, 720)
  const [width, height] = win.getContentSize()
  if (width !== 1280 || height !== 720) {
    const message = `Client area is ${width}x${height}, expected 1280x720.`
    if (strict) throw new Error(message)
    log(message)
  }
}

async function captureClient(win, filename) {
  fit(win, true)
  await sleep(200)
  const image = await win.webContents.capturePage()
  const size = image.getSize()
  if (size.width !== 1280 || size.height !== 720) {
    throw new Error(`Screenshot is ${size.width}x${size.height}, expected 1280x720.`)
  }
  writeFileSync(join(outDir, filename), image.toPNG())
}

async function configure(win) {
  const provider = await invoke(win, 'providers:save', {
    kind: 'openai-compatible',
    label: 'Stand-in',
    baseUrl,
    defaultModelId: 'stand-in',
    enabled: true
  })
  const test = await invoke(win, 'providers:test', { id: provider.id })
  if (!test.ok) throw new Error(`Stand-in provider test failed: ${test.message}`)
  const model = { providerId: provider.id, modelId: 'stand-in' }
  await invoke(win, 'settings:update', {
    defaultModel: model,
    notifications: { enabled: false, sound: false }
  })
  const bots = await invoke(win, 'bots:list')
  const fai = bots.find((bot) => bot.isPrimary)
  if (!fai || fai.name !== 'fai') throw new Error('The main bot fai was not loaded.')
  await invoke(win, 'bots:update', { id: fai.id, patch: { model, notify: false } })
  return model
}

async function ensureModel(win, name, model) {
  const bots = await invoke(win, 'bots:list')
  const bot = bots.find((item) => item.name === name)
  if (!bot) throw new Error(`Bot ${name} was not created.`)
  if (bot.model.providerId !== model.providerId || bot.model.modelId !== 'stand-in') {
    await invoke(win, 'bots:update', { id: bot.id, patch: { model, notify: false } })
  } else if (bot.notify) {
    await invoke(win, 'bots:update', { id: bot.id, patch: { notify: false } })
  }
}

const DM_MESSAGE = [
  'Summarise these 3 notes into 5 bullet points.',
  '',
  'Note 1: The riverside market opens at 8.',
  'Note 2: Stall holders bring their own tables.',
  'Note 3: The square closes at noon on market day.'
].join('\n')

const GROUP_REST = 'Ask Editor to tighten the three market notes into one sentence, then bring that line back here.'
const NAME_FIELD = '[role="dialog"] input[placeholder="Researcher"]'
const DESC_FIELD = '[role="dialog"] textarea[placeholder="Add a description"]'
const DM_FIELD = 'textarea[aria-label="Message Researcher"]'
const GROUP_FIELD = 'textarea[aria-label="Message group"]'

async function demo(win) {
  win.show()
  win.focus()
  try { fit(win) } catch (error) { log(error instanceof Error ? error.message : String(error)) }
  await waitFor(win, `Boolean(document.querySelector('textarea[aria-label="Message fai"]'))`, 'the fai chat')
  const model = await configure(win)
  writeFileSync(join(outDir, 'ready.json'), JSON.stringify({ ok: true }))
  log('waiting for the recorder')
  const goPath = join(outDir, 'go.json')
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      videoStartedAt = JSON.parse(readFileSync(goPath, 'utf8')).videoStartedAt
      break
    } catch {
      await sleep(100)
    }
  }
  if (!videoStartedAt) throw new Error('The recorder did not start.')
  await sleep(600)

  beginShot(1)
  await clickSelector(win, 'button[title^="New Bot"]')
  await waitFor(win, `document.querySelector('[role="dialog"] h2')?.textContent === 'Create New Bot'`, 'the Create New Bot dialog')
  await sleep(1100)
  await typeInto(win, NAME_FIELD, 'Researcher', 80)
  await sleep(500)
  await typeInto(win, DESC_FIELD, 'finds and summarises sources', 40)
  await waitFor(win, `document.querySelector(${JSON.stringify(NAME_FIELD)}).value === 'Researcher' && document.querySelector(${JSON.stringify(DESC_FIELD)}).value === 'finds and summarises sources'`, 'the filled Create New Bot dialog')
  await sleep(1400)
  markProof()
  await sleep(400)
  await clickButton(win, 'Create bot')
  await waitFor(win, `Boolean(document.querySelector(${JSON.stringify(DM_FIELD)}))`, 'the Researcher chat')
  await ensureModel(win, 'Researcher', model)
  await sleep(900)
  await invoke(win, 'bots:create', { name: 'Editor', description: 'tightens wording', model, notify: false })
  await invoke(win, 'bots:create', { name: 'Reviewer', description: 'checks the wording', model, notify: false })
  await waitFor(win, `[...document.querySelectorAll('button')].some((button) => (button.getAttribute('aria-label') || '') === 'Open Editor') && [...document.querySelectorAll('button')].some((button) => (button.getAttribute('aria-label') || '') === 'Open Reviewer')`, 'Editor and Reviewer in the sidebar')
  await sleep(1000)
  endShot()

  beginShot(2)
  if (await evalJs(win, `Boolean(document.querySelector('aside[aria-label="Details"]'))`)) {
    await clickSelector(win, 'button[aria-label^="Toggle details"]')
    await waitFor(win, `!document.querySelector('aside[aria-label="Details"]')`, 'the details pane to close')
  }
  await sleep(500)
  await typeInto(win, DM_FIELD, DM_MESSAGE, 18)
  await sleep(700)
  await pressEnter(win, DM_FIELD)
  await waitFor(win, `(() => {
    const text = document.querySelector('main')?.innerText || ''
    return text.includes('[stand-in model]') && text.includes('Morning trade ends at noon.') && !/is (typing|working|reading)/.test(text)
  })()`, 'the Researcher reply', 45000)
  await sleep(500)
  markProof()
  await sleep(1800)
  endShot()

  beginShot(3)
  await clickSelector(win, 'button[aria-label^="New chat"]')
  await waitFor(win, `Boolean(document.querySelector('section[aria-label="New chat"]'))`, 'New chat')
  await sleep(700)
  for (const name of ['Researcher', 'Editor', 'Reviewer']) {
    await evalJs(win, `(() => {
      const option = [...document.querySelectorAll('[aria-label="All Bots"] [role="option"]')].find((button) => (button.innerText || '').includes(${JSON.stringify(name)}))
      if (!option) throw new Error('Missing bot option ${name}')
      option.click()
    })()`)
    await sleep(550)
  }
  await sleep(600)
  await clickButton(win, 'Create group chat')
  await waitFor(win, `Boolean(document.querySelector(${JSON.stringify(GROUP_FIELD)}))`, 'the group composer')
  await sleep(900)
  await typeInto(win, GROUP_FIELD, '@researcher', 50)
  await waitFor(win, `Boolean(document.querySelector('[aria-label="Mention"] [role="option"]'))`, 'the mention menu')
  await sleep(400)
  await pressEnter(win, GROUP_FIELD)
  await waitFor(win, `(document.querySelector(${JSON.stringify(GROUP_FIELD)})?.value || '').startsWith('@researcher ')`, 'the Researcher mention')
  await sleep(300)
  await typeMore(win, GROUP_FIELD, GROUP_REST, 16)
  await waitFor(win, `(document.querySelector(${JSON.stringify(GROUP_FIELD)})?.value || '').includes('bring that line back here')`, 'the group message')
  await sleep(600)
  await pressEnter(win, GROUP_FIELD)
  await waitFor(win, `(() => {
    const text = document.querySelector('main')?.innerText || ''
    const link = document.querySelector('button[aria-label^="Open bot conversation:"]')?.getAttribute('aria-label') || ''
    const labels = (text.match(/\\[stand-in model\\]/g) || []).length
    return labels >= 2 && link.includes('messages with Editor') && text.includes('I asked Editor to tighten') && text.includes('That line matches the notes') && !/is (typing|working|reading)/.test(text)
  })()`, 'both group replies and the messages link', 60000)
  await evalJs(win, `(() => { const el = document.querySelector('[data-transcript]'); if (el) el.scrollTop = el.scrollHeight })()`)
  const linkLabel = await evalJs(win, `document.querySelector('button[aria-label^="Open bot conversation:"]')?.getAttribute('aria-label') || ''`)
  log(`link ${linkLabel}`)
  await sleep(400)
  markProof()
  await captureClient(win, 'group-chat.png')
  await sleep(1800)
  endShot()

  beginShot(4)
  await clickSelector(win, 'button[aria-label^="Open bot conversation:"]')
  await waitFor(win, `(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find((el) => (el.innerText || '').includes('Close chat'))
    return dialog && ((dialog.innerText.match(/\\[stand-in model\\]/g) || []).length >= 2)
  })()`, 'the bot conversation dialog', 20000)
  await sleep(400)
  markProof()
  await sleep(2200)
  await clickButton(win, 'Close chat')
  await waitFor(win, `![...document.querySelectorAll('[role="dialog"]')].some((el) => (el.innerText || '').includes('Close chat'))`, 'the dialog to close')
  await sleep(900)
  endShot()

  beginShot(5)
  await clickSelector(win, 'button[title^="Settings"]')
  await waitFor(win, `Boolean(document.querySelector('[aria-label="faibots settings"]'))`, 'Settings')
  await sleep(800)
  await evalJs(win, `(() => {
    const root = document.querySelector('[aria-label="faibots settings"]')
    const about = [...root.querySelectorAll('button')].find((button) => (button.innerText || '').replace(/\\s+/g, ' ').trim() === 'About')
    if (!about) throw new Error('Missing About')
    about.click()
  })()`)
  await waitFor(win, `(() => {
    const row = [...document.querySelectorAll('dt')].find((item) => item.textContent.trim() === 'Your data')
    return Boolean(row && row.nextElementSibling && row.nextElementSibling.textContent.trim())
  })()`, 'the Your data row')
  const dataDir = await evalJs(win, `(() => {
    const row = [...document.querySelectorAll('dt')].find((item) => item.textContent.trim() === 'Your data')
    return row?.nextElementSibling?.textContent || ''
  })()`)
  log(`Your data: ${dataDir}`)
  await sleep(400)
  markProof()
  await sleep(2200)
  endShot()
  writeShots()
}

function runInside() {
  mkdirSync(outDir, { recursive: true })
  app.on('ready', () => Menu.setApplicationMenu(null))
  app.once('browser-window-created', (_event, win) => {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.once('ready-to-show', () => {
      try { fit(win) } catch (error) { log(error instanceof Error ? error.message : String(error)) }
      win.show()
      win.focus()
    })
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          await demo(win)
          log('demo finished')
          app.quit()
        } catch (error) {
          log(error instanceof Error ? error.stack || error.message : String(error))
          try { writeShots() } catch { /* partial timestamps are still useful */ }
          try { await captureClient(win, 'failure.png') } catch (captureError) {
            log(captureError instanceof Error ? captureError.message : String(captureError))
          }
          try { writeFileSync(join(outDir, 'ready.json'), JSON.stringify({ ok: false, error: String(error) })) } catch { /* already ready */ }
          app.exit(1)
        }
      })()
    })
  })
  import(pathToFileURL(join(sourceRoot, 'out', 'main', 'index.js')).href).catch((error) => {
    log(error instanceof Error ? error.stack || error.message : String(error))
    app.exit(1)
  })
}

runInside()
