// Kill the production Electron app after a child writes a fixture file and before its answer.
// Both launches use one disposable profile, one loopback provider, and no external credentials.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { DatabaseSync } = require('node:sqlite')

const marker = 'The delegated action ran.'
const root = join(__dirname, '..')

function electronStage(mode, profile, url) {
  const { app } = require('electron')
  app.setPath('userData', profile)
  delete process.env.ELECTRON_RENDERER_URL
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      const invoke = (channel, args) => window.webContents.executeJavaScript(
        `window.faibots.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`
      )
      try {
        const checkpoint = join(profile, 'test-parent.json')
        if (mode === 'start') {
          const provider = await invoke('providers:save', {
            kind: 'openai-compatible', label: 'Fixture', baseUrl: url, defaultModelId: 'chief-test', enabled: true
          })
          await invoke('settings:update', { workspaceRoot: join(profile, 'workspaces') })
          const chief = await invoke('bots:create', { name: 'Chief Test', model: { providerId: provider.id, modelId: 'chief-test' } })
          await invoke('bots:create', { name: 'Child Test', handle: 'child-test', model: { providerId: provider.id, modelId: 'child-test' } })
          const dm = await invoke('conv:open-dm', { botId: chief.id })
          writeFileSync(checkpoint, JSON.stringify({ conversationId: dm.id }))
          await invoke('conv:send', { conversationId: dm.id, text: 'Delegate a test.', clientNonce: 'only-request', mentions: [], mentionsEveryone: false, attachmentPaths: [] })
          return
        }
        const { conversationId } = JSON.parse(readFileSync(checkpoint, 'utf8'))
        const { entries } = await invoke('conv:entries', { conversationId })
        const cards = entries.filter((entry) => entry.toolCall?.toolName === 'send_to_agent')
        assert.equal(cards.length, 1)
        assert.equal(cards[0].toolCall.status, 'error')
        assert.match(cards[0].toolCall.resultText, /closed before the delegated task returned a confirmed result/)
        const exchange = await invoke('conv:entries', { conversationId: cards[0].toolCall.exchangeConversationId })
        assert.equal(exchange.entries.filter((entry) => entry.toolCall?.toolName === 'write_file' && entry.toolCall.status === 'done').length, 1)
        assert.equal(exchange.entries.filter((entry) => entry.kind === 'message').length, 1)
        app.quit()
      } catch (error) {
        console.error(error)
        app.exit(1)
      }
    })
  })
  import(pathToFileURL(join(root, 'out', 'main', 'index.js')).href).catch((error) => {
    console.error(error)
    app.exit(1)
  })
}

async function smoke() {
  assert.equal(process.platform, 'win32')
  const profile = mkdtempSync(join(tmpdir(), 'faibots-delegation-'))
  mkdirSync(join(profile, 'workspaces'))
  const executable = process.env.FAIBOTS_SMOKE_ELECTRON || require('electron')
  let chiefCalls = 0
  let childCalls = 0
  let injectedCrash = false
  let firstProcess
  let fixtureError
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        return response.end(JSON.stringify({ object: 'list', data: ['chief-test', 'child-test'].map((id) => ({ id, object: 'model' })) }))
      }
      assert.equal(request.url, '/v1/chat/completions')
      let body = ''
      for await (const block of request) body += block
      const { model, messages } = JSON.parse(body)
      const chief = model === 'chief-test'
      if (chief) chiefCalls++
      else { assert.equal(model, 'child-test'); childCalls++ }
      if (!chief && messages.some((message) => message.role === 'tool')) {
        assert.equal(readFileSync(join(profile, 'workspaces', 'child-test', 'marker.txt'), 'utf8'), marker)
        assert.equal(injectedCrash, false)
        injectedCrash = true
        assert(firstProcess.kill('SIGKILL'))
        return
      }
      const tool = chief ? 'send_to_agent' : 'write_file'
      const args = chief ? { to: 'child-test', message: 'Write the test marker.' } : { path: 'marker.txt', content: marker }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 0, model, choices: [{ index: 0, delta, finish_reason }]
      })}\n\n`)
      chunk({ role: 'assistant', tool_calls: [{ index: 0, type: 'function', id: 'call-' + tool, function: { name: tool, arguments: JSON.stringify(args) } }] }, null)
      chunk({}, 'tool_calls')
      response.end('data: [DONE]\n\n')
    } catch (error) {
      fixtureError = error
      response.destroy()
      firstProcess?.kill()
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1`
    for (const mode of ['start', 'inspect', 'inspect']) {
      const child = spawn(executable, [__filename, mode, profile, url], { stdio: 'inherit', timeout: 40_000 })
      if (mode === 'start') firstProcess = child
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      if (fixtureError) throw fixtureError
      if (mode === 'start') assert(injectedCrash, 'The first launch ended before the planned interruption')
      else assert.equal(code, 0)
    }
    const db = new DatabaseSync(join(profile, 'faibots.db'), { readOnly: true })
    try {
      const rows = db.prepare('select state,lease,engine,system_hash,delivered_at from delegations').all()
      assert.equal(rows.length, 1)
      assert.equal(rows[0].state, 'reconciliation_required')
      assert.equal(rows[0].lease, null)
      assert.equal(rows[0].engine, 'native')
      assert.match(rows[0].system_hash, /^[a-f0-9]{64}$/)
      assert(rows[0].delivered_at)
      assert.equal(db.prepare("select count(*) n from actions where tool_name = 'write_file' and state = 'completed'").get().n, 1)
    } finally { db.close() }
    assert.equal(chiefCalls, 1)
    assert.equal(childCalls, 2)
    console.log('Forced Electron exit after one child file write. Two restarts recovered the parent card without another model call or write.')
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

if (process.versions.electron) electronStage(...process.argv.slice(-3))
else smoke().catch((error) => { console.error(error); process.exitCode = 1 })
