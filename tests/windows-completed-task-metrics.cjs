// Build faibots, then run: node tests/windows-completed-task-metrics.cjs [1..20 samples]
// FAIBOTS_SMOKE_ELECTRON may identify an existing local Electron executable.
// A sample is a fresh process and profile. It completes the same scenario twice in that process.
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { cpus, release, tmpdir, totalmem } = require('node:os')
const { join, resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { setTimeout: delay } = require('node:timers/promises')
const { pathToFileURL } = require('node:url')
const {
  startFixture,
  sourceName,
  sourceText,
  question,
  directAnswer,
  fixedDraft
} = require('./fixtures/desktop-metrics-model.cjs')

const root = resolve(__dirname, '..')
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')
const round = (v) => Math.round(v * 100) / 100

async function until(check, description) {
  const end = performance.now() + 30000
  do {
    const match = await check()
    if (match) return match
    await delay(25)
  } while (performance.now() < end)
  throw new Error('Timed out waiting for ' + description)
}

function processFamily(app, includeStartup = false) {
  const started = performance.now()
  const cpuByProcess = new Map()
  const types = new Set()
  let peakWorkingSetKiB = 0,
    samples = 0,
    completeCpu = true,
    peakProcesses = 0
  function sample() {
    const metrics = app.getAppMetrics()
    samples++
    peakProcesses = Math.max(peakProcesses, metrics.length)
    let workingSet = 0
    for (const metric of metrics) {
      types.add(metric.type)
      const key = metric.pid + '/' + metric.creationTime
      const value = metric.cpu.cumulativeCPUUsage
      if (!Number.isFinite(value)) completeCpu = false
      else {
        const prior = cpuByProcess.get(key)
        // A newly observed process after the baseline contributes CPU since its creation.
        cpuByProcess.set(key, { first: prior?.first ?? (samples === 1 && !includeStartup ? value : 0), last: value })
      }
      workingSet += metric.memory.workingSetSize
    }
    peakWorkingSetKiB = Math.max(peakWorkingSetKiB, workingSet)
  }
  sample()
  const timer = setInterval(sample, 20)
  return () => {
    clearInterval(timer)
    sample()
    return {
      elapsedMs: round(performance.now() - started),
      sampledFamilyCpuMs: completeCpu
        ? round([...cpuByProcess.values()].reduce((sum, m) => sum + (m.last - m.first) * 1000, 0))
        : null,
      peakFamilyWorkingSetMiB: round(peakWorkingSetKiB / 1024),
      sampleIntervalMs: 20,
      samples,
      peakProcesses,
      processTypes: [...types].sort()
    }
  }
}

// Resolve and composite the actual paint colors at the normal-size chat heading.
function headingContrast() {
  const heading = document.querySelector('main h1')
  if (!heading) throw new Error('Missing accessible chat heading')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const layers = []
  for (let e = heading; e; e = e.parentElement) layers.unshift(getComputedStyle(e).backgroundColor)
  function pixel(color) {
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
  }
  const luminance = () => {
    const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data)
      .slice(0, 3)
      .map((n) => {
        const c = n / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  pixel('white')
  layers.forEach(pixel)
  const background = luminance()
  pixel(getComputedStyle(heading).color)
  const text = luminance()
  return Math.round((100 * (Math.max(text, background) + 0.05)) / (Math.min(text, background) + 0.05)) / 100
}

async function keyboardAndDisplay(window) {
  const view = window.webContents
  const evaluate = (js) => view.executeJavaScript(js)
  const debuggerApi = view.debugger
  debuggerApi.attach('1.3')
  const key = async (key, code, virtualKey, modifiers = 0) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: virtualKey,
        modifiers
      })
    }
  }
  const checks = {}
  try {
    await evaluate('document.querySelector(\'button[aria-label="Open fai"]\').focus()')
    await key('k', 'KeyK', 75, 2)
    await until(() => evaluate("document.activeElement?.getAttribute('aria-label') === 'Jump to'"), 'keyboard palette focus')
    await key('Tab', 'Tab', 9)
    checks.tabStayedInDialog = await evaluate("Boolean(document.activeElement.closest('[role=dialog]'))")
    await key('Escape', 'Escape', 27)
    await until(() => evaluate("!document.querySelector('[role=dialog]')"), 'Escape dismissal')
    checks.focusRestored = await evaluate("document.activeElement?.getAttribute('aria-label') === 'Open fai'")
    await debuggerApi.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    })
    checks.reducedMotion = await evaluate(
      "matchMedia('(prefers-reduced-motion: reduce)').matches && parseFloat(getComputedStyle(document.querySelector('main')).transitionDuration) < .001"
    )
    checks.headingContrast = await evaluate('(' + headingContrast.toString() + ')()')
    checks.devicePixelRatio = await evaluate('devicePixelRatio')
    await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    checks.composerAt200Percent = false
    try {
      view.setZoomFactor(2)
      checks.composerAt200Percent = await evaluate(
        "(() => {const r=document.querySelector('main textarea').getBoundingClientRect(); return r.width>0 && r.left >= 0 && r.left < innerWidth && r.top >= 0 && r.top < innerHeight})()"
      )
    } finally {
      view.setZoomFactor(1)
    }
    assert(
      checks.tabStayedInDialog && checks.focusRestored && checks.reducedMotion && checks.composerAt200Percent,
      JSON.stringify(checks)
    )
    assert.equal(checks.devicePixelRatio, 1.25)
    assert(checks.headingContrast >= 4.5, 'Insufficient chat heading contrast: ' + checks.headingContrast)
    return checks
  } finally {
    debuggerApi.detach()
  }
}

async function measureInDesktop(profile, scenario, baseUrl) {
  const { app } = require('electron')
  const start = performance.now()
  app.setPath('userData', profile)
  app.commandLine.appendSwitch('force-device-scale-factor', '1.25')
  delete process.env.ELECTRON_RENDERER_URL
  const sourcePath = join(profile, sourceName)
  writeFileSync(sourcePath, sourceText)
  app.once('browser-window-created', (_event, window) => {
    const startupFamily = processFamily(app, true)
    const view = window.webContents
    const invoke = (name, args = {}) =>
      view.executeJavaScript('window.faibots.invoke(' + JSON.stringify(name) + ',' + JSON.stringify(args) + ')')
    view.once('did-finish-load', async () => {
      let db
      try {
        const readyUi = () =>
          view.executeJavaScript('Boolean(document.querySelector(\'main textarea[aria-label="Message fai"]\'))')
        await until(readyUi, 'fai composer')
        const startup = startupFamily()
        startup.elapsedMs = round(performance.now() - start)
        const keyboard = await keyboardAndDisplay(window)
        const chief = (await invoke('bots:list')).find((b) => b.isPrimary)
        assert.equal(chief.name, 'fai')
        const provider = await invoke('providers:save', {
          kind: 'openai-compatible',
          label: 'Loopback measurement',
          baseUrl,
          defaultModelId: 'local-measure',
          enabled: true
        })
        const model = { providerId: provider.id, modelId: 'local-measure' }
        await invoke('settings:update', { workspaceRoot: join(profile, 'workspaces') })
        await invoke('bots:update', { id: chief.id, patch: { model } })
        await invoke('bots:create', { name: 'Workshop Reviewer', handle: 'workshop-reviewer', model, notify: false })
        const project = await invoke('projects:create', {
          name: 'Workshop measurement',
          description: 'Local synthetic notes'
        })
        const { id: projectId } = project
        const [source] = await invoke('projects:attach-notes', { projectId, paths: [sourcePath] })
        assert.equal(source.sha256, hash(sourceText))
        const dm = await invoke('conv:open-dm', { botId: chief.id })
        db = new DatabaseSync(join(profile, 'faibots.db'), { readOnly: true })
        const runs = []
        const turnMark = () => db.prepare('select coalesce(max(rowid),0) n from turns').get().n
        for (const temperature of ['cold', 'warm']) {
          const before = turnMark()
          const assignmentsBefore = db.prepare('select count(*) n from delegations').get().n
          const endResource = processFamily(app)
          let evidence
          if (scenario === 'C01') {
            const previous = (await invoke('conv:entries', { conversationId: dm.id })).entries.at(-1)?.seq ?? 0
            await invoke('conv:send', {
              conversationId: dm.id,
              text: question,
              clientNonce: 'measurement-' + temperature,
              attachmentPaths: [sourcePath],
              mentions: [],
              mentionsEveryone: false
            })
            let approvals = 0
            await until(async () => {
              const { entries } = await invoke('conv:entries', { conversationId: dm.id })
              const pending = entries.find((e) => e.seq > previous && e.approval?.status === 'pending')?.approval
              if (pending) {
                assert.equal(pending.toolName, 'read_file')
                assert.equal(pending.input.path, join(profile, 'attachments', source.sha256.slice(0, 16) + '-' + sourceName))
                await invoke('approval:resolve', { approvalId: pending.approvalId, decision: 'allow_once' })
                approvals++
              }
              return entries.some(
                (e) => e.seq > previous && e.author.botId === chief.id && e.text === directAnswer && !e.isStreaming
              )
            }, 'answer identifying the selected revision')
            await until(() => turnMark() > before, 'completed direct turn')
            const newAssignments = db.prepare('select count(*) n from delegations').get().n - assignmentsBefore
            assert.equal(newAssignments, 0)
            evidence = { answer: directAnswer, sourceSha256: source.sha256, newAssignments, approvals }
          } else {
            const first = await invoke('projects:start-mission', { projectId })
            const waitRun = (id) =>
              until(
                async () =>
                  (await invoke('projects:list-runs', { projectId })).find(
                    (r) => r.id === id && !['waiting_review', 'working'].includes(r.status)
                  ),
                'terminal reviewed run'
              )
            const failed = await waitRun(first.id)
            assert.equal(failed.status, 'partial', JSON.stringify(failed))
            const { runId } = await invoke('content:rerun', { projectId, runId: first.id })
            const repaired = await waitRun(runId)
            assert.equal(repaired.status, 'complete', JSON.stringify(repaired))
            const { pages, evaluations } = await invoke('content:project', { projectId })
            const page = pages.find((p) => p.runId === runId)
            assert(page)
            const result = await invoke('content:read-page', { projectId, pageId: page.id })
            assert.equal(result.body, fixedDraft)
            assert.equal(result.sources[0].sha256, source.sha256)
            assert.equal(page.sha256, hash(fixedDraft))
            const record = evaluations.find((e) => e.runId === first.id)
            assert.equal(record.report.candidateId, runId)
            assert.equal(record.report.status, 'passed')
            evidence = {
              firstStatus: failed.status,
              finalStatus: repaired.status,
              rubricSha256: hash(record.rubric),
              sourceSha256: source.sha256,
              pageSha256: page.sha256,
              repairs: 1,
              destination: 'private project Space'
            }
          }
          const resources = endResource()
          const turns = db.prepare('select input_tokens,output_tokens from turns where rowid>?').all(before)
          assert(turns.length)
          const unknown = turns.filter((t) => t.input_tokens === 0 && t.output_tokens === 0).length
          const tokenData = {
            input: unknown === turns.length ? null : turns.reduce((s, t) => s + t.input_tokens, 0),
            output: unknown === turns.length ? null : turns.reduce((s, t) => s + t.output_tokens, 0),
            unknownTurns: unknown
          }
          runs.push({
            temperature,
            scenario,
            ...resources,
            turnCount: turns.length,
            tokens: tokenData,
            spend: null,
            evidence
          })
        }
        writeFileSync(
          join(profile, 'completed-task.json'),
          JSON.stringify({ startup, keyboard, runs, electron: process.versions.electron })
        )
        app.quit()
      } catch (error) {
        console.error(error)
        app.exit(1)
      } finally {
        db?.close()
      }
    })
  })
  await import(pathToFileURL(join(root, 'out', 'main', 'index.js')).href)
}

async function run() {
  assert.equal(process.platform, 'win32')
  const count = Number(process.argv[2] ?? 3)
  assert(Number.isInteger(count) && count >= 1 && count <= 20, 'Use 1 to 20 independent profile pairs')
  const electron = process.env.FAIBOTS_SMOKE_ELECTRON || require('electron')
  const reportRoot = mkdtempSync(join(tmpdir(), 'faibots-metrics-'))
  const report = {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    windowsBuild: release(),
    measuredAt: new Date().toISOString(),
    architecture: process.arch,
    cpuModel: cpus()[0]?.model,
    logicalProcessors: cpus().length,
    systemMemoryGiB: round(totalmem() / 1024 ** 3),
    electronExecutableSha256: hash(readFileSync(electron)),
    mainBundleSha256: hash(readFileSync(join(root, 'out', 'main', 'index.js'))),
    provider: 'Deterministic loopback fixture; tokenizer and account price unavailable.',
    method:
      'First and second completed task in a fresh process. Setup excluded from task time. Startup separately measured from Electron test entry to usable composer. CPU is summed cumulative Electron-process time; peak is maximum sampled concurrent working set, including shared pages. The external fixture is excluded. Between-sample short-lived processes and higher peaks may be missed.',
    profiles: []
  }
  const { server, url } = await startFixture()
  try {
    for (let i = 0; i < count; i++) {
      for (const scenario of ['C01', 'C15']) {
        const profile = mkdtempSync(join(reportRoot, scenario + '-'))
        mkdirSync(join(profile, 'workspaces'))
        const status = await new Promise((resolve, reject) => {
          const child = spawn(electron, [__filename, profile, scenario, url], { stdio: 'inherit', timeout: 75000 })
          child.once('error', reject)
          child.once('exit', resolve)
        })
        assert.equal(status, 0, scenario + ' failed on fresh disposable profile ' + profile)
        const result = JSON.parse(readFileSync(join(profile, 'completed-task.json'), 'utf8'))
        report.profiles.push({ sample: i + 1, scenario, ...result })
      }
    }
    const path = join(reportRoot, 'report.json')
    writeFileSync(path, JSON.stringify(report, null, 2))
    console.log(path)
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

const action = process.versions.electron ? measureInDesktop(...process.argv.slice(-3)) : run()
action.catch((error) => {
  console.error(error)
  process.exitCode = 1
})
