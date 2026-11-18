// Exercise the production Electron window and IPC with a deterministic loopback provider.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { release, tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const { pathToFileURL } = require('node:url')

const sourceRoot = resolve(__dirname, '..')
const notes = join(sourceRoot, 'examples', 'workshop-notes.md')
const modelId = 'proposal-fixture'
const projectName = 'Community Workshop Smoke Test'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const proposal = [
  '# Workshop proposal',
  '',
  'Run a six-week pilot for up to 40 participants across two workshops.',
  'Use a manual fallback and keep spending within the QAR 12,000 ceiling.',
  'The sponsor still needs to approve the data retention period and name the exception owner.',
  'Approval for any wider rollout remains open.'
].join('\n')

function fixtureResponse(messages) {
  const textOf = (message) => Array.isArray(message.content)
    ? message.content.map((part) => part.text ?? '').join('\n')
    : String(message.content ?? '')
  const promptIndex = messages.findLastIndex((message) => message.role === 'user')
  const prompt = textOf(messages[promptIndex])
  const result = messages.slice(promptIndex + 1).findLast((message) => message.role === 'tool')

  if (prompt.includes('<<<REVIEW MESSAGE')) {
    if (result) return 'Review received.'
    return {
      name: 'send_to_agent',
      arguments: {
        to: '@proposal-reviewer',
        message: prompt.split('<<<REVIEW MESSAGE\n')[1].split('\nREVIEW MESSAGE>>>')[0]
      }
    }
  }
  if (prompt.includes('Review for mission run')) {
    assert(prompt.includes(proposal), 'The reviewer did not receive the saved proposal')
    assert(prompt.includes('QAR 12,000'), 'The reviewer did not receive the fictional notes')
    return 'The draft stays within scope.\nVERDICT: accepted — Matches the selected notes.'
  }
  const source = /mission-[0-9a-f-]+\/project-notes\/1-workshop-notes\.md/.exec(prompt)?.[0]
  assert(source, 'The draft request did not include the staged sample')
  if (result?.tool_call_id === 'call_write_file') return 'The workshop proposal is saved.'
  if (result?.tool_call_id === 'call_read_file') {
    assert.match(textOf(result), /QAR 12,000/)
    const path = /mission-[0-9a-f-]+\/proposal\.md/.exec(prompt)?.[0]
    assert(path, 'The draft request did not include its destination')
    return { name: 'write_file', arguments: { path, content: proposal } }
  }
  return { name: 'read_file', arguments: { path: source } }
}

async function startFixture() {
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ object: 'list', data: [{ id: modelId, object: 'model' }] }))
        return
      }
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.method, 'POST')
      let body = ''
      for await (const chunk of request) body += chunk
      const model = fixtureResponse(JSON.parse(body).messages)
      const delta = typeof model === 'string'
        ? { role: 'assistant', content: model }
        : { role: 'assistant', tool_calls: [{
          index: 0, id: `call_${model.name}`, type: 'function',
          function: { name: model.name, arguments: JSON.stringify(model.arguments) }
        }] }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (value, reason) => response.write(`data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 0, model: modelId,
        choices: [{ index: 0, delta: value, finish_reason: reason }]
      })}\n\n`)
      send(delta, null)
      send({}, typeof model === 'string' ? 'stop' : 'tool_calls')
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(400)
      response.end(String(error.message))
    }
  })
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done))
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

function runDesktop() {
  const { app } = require('electron')
  const [mode, profile, baseUrl] = process.argv.slice(-3)
  app.setPath('userData', profile)
  delete process.env.ELECTRON_RENDERER_URL
  app.once('browser-window-created', (_event, window) => {
    window.webContents.once('did-finish-load', async () => {
      const invoke = (channel, args) => window.webContents.executeJavaScript(
        `window.faibots.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`
      )
      try {
        assert.equal((await invoke('app:info')).platform, 'win32')
        const proofPath = join(profile, 'smoke-proof.json')
        let project
        if (mode === 'draft') {
          const provider = await invoke('providers:save', {
            kind: 'openai-compatible', label: 'Local fixture', baseUrl,
            defaultModelId: modelId, enabled: true
          })
          assert.equal((await invoke('providers:test', { id: provider.id })).ok, true)
          await invoke('settings:update', { workspaceRoot: join(profile, 'workspaces') })
          const model = { providerId: provider.id, modelId }
          await invoke('bots:create', { name: 'Proposal Drafter', handle: 'proposal-drafter', model, isPrimary: true })
          await invoke('bots:create', { name: 'Proposal Reviewer', handle: 'proposal-reviewer', model, notify: false })
          project = await invoke('projects:create', { name: projectName, description: 'Fictional workshop example' })
          const sources = await invoke('projects:attach-notes', { projectId: project.id, paths: [notes] })
          assert.equal(sources[0].sha256, hash(readFileSync(notes)))
          await invoke('projects:start-mission', { projectId: project.id })
        } else {
          project = (await invoke('projects:list')).find((item) => item.name === projectName)
        }
        assert(project)
        const query = { projectId: project.id }
        const deadline = Date.now() + 30_000
        let run
        do {
          ;[run] = await invoke('projects:list-runs', query)
          if (run && !['working', 'waiting_review'].includes(run.status)) break
          await delay(150)
        } while (Date.now() < deadline)
        assert.equal(run?.status, 'complete', JSON.stringify(run))
        const [artifact] = await invoke('artifacts:list', query)
        assert.equal(artifact.content, proposal)
        const [revision] = artifact.revisions
        assert.equal(revision.sha256, hash(proposal))
        assert.equal(revision.reviews[0].decision, 'accepted')
        const proof = { runId: run.id, revisionId: revision.id, sha256: revision.sha256 }
        if (mode === 'draft') writeFileSync(proofPath, JSON.stringify(proof))
        else assert.deepEqual(proof, JSON.parse(readFileSync(proofPath, 'utf8')))
        console.log(`Windows ${release()}, Electron ${process.versions.electron}: ${mode} passed, revision ${proof.sha256}`)
        app.quit()
      } catch (error) {
        console.error(error)
        app.exit(1)
      }
    })
  })
  import(pathToFileURL(join(sourceRoot, 'out', 'main', 'index.js')).href).catch((error) => {
    console.error(error)
    app.exit(1)
  })
}

async function runSmoke() {
  assert.equal(process.platform, 'win32')
  const profile = mkdtempSync(join(tmpdir(), 'faibots-desktop-'))
  mkdirSync(join(profile, 'workspaces'))
  const electron = process.env.FAIBOTS_SMOKE_ELECTRON || require('electron')
  const { server, baseUrl } = await startFixture()
  try {
    for (const mode of ['draft', 'reopen']) {
      const exitCode = await new Promise((done, fail) => {
        const child = spawn(electron, [__filename, mode, profile, baseUrl], { stdio: 'inherit', timeout: 65_000 })
        child.once('error', fail)
        child.once('close', done)
      })
      assert.equal(exitCode, 0, `Electron did not complete the ${mode} check`)
    }
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

if (process.versions.electron) runDesktop()
else runSmoke().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
