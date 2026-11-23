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
const chatQuestion = 'Which column identifies the owner in the sample task list?'
const chatAnswer = 'The Assignee column identifies the owner.'
const chiefQuestion = 'What should the sample team decide first?'
const chiefAnswer = 'Decide who owns the first task.'
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

  if (prompt.includes('Plan the pickup note.') || prompt.includes('Answer for work')) {
    const answering = prompt.includes('Answer for work')
    if (!result) return {name:'plan_work',arguments:{objective:'Arrange pickup',deliverable:'Pickup note',checks:'Verify the gate'}}
    if (result.tool_call_id === 'call_plan_work') {
      const brief = JSON.parse(textOf(result))
      return {name:'review_work',arguments:{id:brief.id,revision:brief.revision,action:answering?'result':'question',
        text:answering?'Meet at Gate 4.':'Which pickup gate?',...(answering?{}:{choices:['Gate 2','Gate 4']})}}
    }
    return answering ? 'Your pickup note is ready.' : 'Please choose a gate.'
  }
  if (prompt.includes(chatQuestion)) return chatAnswer
  if (prompt.includes(chiefQuestion)) return chiefAnswer
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

async function configureModel(invoke, profile, baseUrl) {
  const provider = await invoke('providers:save', {
    kind: 'openai-compatible', label: 'Local fixture', baseUrl,
    defaultModelId: modelId, enabled: true
  })
  assert.equal((await invoke('providers:test', { id: provider.id })).ok, true)
  await invoke('settings:update', { workspaceRoot: join(profile, 'workspaces') })
  return { providerId: provider.id, modelId }
}

async function checkChatHistory(invoke, mode, bot, question, answer) {
  const dm = await invoke('conv:open-dm', { botId: bot.id })
  assert.equal(dm.kind, 'dm')
  assert.deepEqual(dm.botIds, [bot.id])
  const conversationId = dm.id
  if (mode === 'chat') {
    await invoke('conv:send', {
      conversationId, text: question, clientNonce: 'smoke-' + bot.id,
      mentions: [], mentionsEveryone: false, attachmentPaths: []
    })
  }
  const deadline = Date.now() + 20_000
  let userMessage, reply
  do {
    const { entries } = await invoke('conv:entries', { conversationId })
    userMessage = entries.find((entry) => entry.kind === 'message' && entry.author.kind === 'user' && entry.text === question)
    reply = entries.find((entry) => entry.author.kind === 'bot' && entry.author.botId === bot.id &&
      entry.kind === 'message' && !entry.isStreaming && entry.text === answer)
    if (reply || mode === 'chat-reopen') break
    await delay(150)
  } while (Date.now() < deadline)
  assert(userMessage && reply && reply.seq > userMessage.seq, `Expected the user message followed by ${bot.name}'s reply`)
  return { conversationId, botId: bot.id, userEntryId: userMessage.id, replyId: reply.id }
}

async function primaryFai(invoke) {
  const primaries = (await invoke('bots:list')).filter((bot) => bot.isPrimary)
  assert.equal(primaries.length, 1, 'Expected one permanent primary bot')
  assert.equal(primaries[0].name, 'fai')
  return primaries[0]
}

async function waitForWindow(evaluate, condition, description) {
  const deadline = Date.now() + 15_000
  do {
    if (await evaluate(condition)) return
    await delay(100)
  } while (Date.now() < deadline)
  assert.fail(`Timed out waiting for ${description}`)
}

async function checkDirectChat(invoke, window, mode, profile, baseUrl) {
  const evaluate = (expression) => window.webContents.executeJavaScript(expression)
  const proofPath = join(profile, 'chat-proof.json')
  const chief = await primaryFai(invoke)
  await waitForWindow(evaluate, `Boolean(document.querySelector('main textarea[aria-label="Message fai"]'))`, 'the fai conversation on startup')
  if (mode === 'chat') {
    const work = await invoke('conv:open-dm', { botId: chief.id })
    const last = Date.now() - 65_000
    const state = { botId: chief.id, conversationId: work.id, phase: 'tool', activity: 'Checking the fixture', updatedAt: last }
    window.webContents.send('bot:state', { state })
    await waitForWindow(evaluate, "document.querySelector('main')?.innerText.includes('Status unknown · last reported Checking the fixture')", 'the stale status and its last observation')
    window.webContents.send('bot:state', { state: { ...state, phase: 'typing', updatedAt: Date.now() } })
    await waitForWindow(evaluate, "document.querySelector('main')?.innerText.includes('fai is typing')", 'current activity after a fresh observation')
    window.webContents.send('bot:state', { state: { ...state, phase: 'idle', updatedAt: Date.now() } })
    const model = await configureModel(invoke, profile, baseUrl)
    await invoke('bots:update', { id: chief.id, patch: { model } })
    await invoke('bots:create', { name: 'Editor', handle: 'editor', model, notify: false })
  }
  const editor = (await invoke('bots:list')).find((bot) => bot.handle === 'editor')
  assert(editor && !editor.isPrimary && editor.id !== chief.id)
  const chiefChat = await checkChatHistory(invoke, mode, chief, chiefQuestion, chiefAnswer)
  await waitForWindow(evaluate, `document.querySelector('main')?.innerText.includes(${JSON.stringify(chiefAnswer)})`, 'the saved fai reply on screen')
  const editorChat = await checkChatHistory(invoke, mode, editor, chatQuestion, chatAnswer)
  const proof = { chiefChat, editorChat }
  if (mode === 'chat') {
    await waitForWindow(evaluate, `Boolean(document.querySelector('button[aria-label="Open Editor"]'))`, 'the editor sidebar button')
    await evaluate(`document.querySelector('button[aria-label="Open Editor"]').click()`)
    await waitForWindow(evaluate, `Boolean(document.querySelector('main textarea[aria-label="Message Editor"]'))`, 'the specialist conversation')
    // Older releases saved the last open specialist. Recreate that preference on exit.
    await evaluate(`(() => {
      const saved = JSON.parse(localStorage.getItem('faibots.ui.v1') || '{}')
      saved.lastConversationId = ${JSON.stringify(editorChat.conversationId)}
      const persist = () => localStorage.setItem('faibots.ui.v1', JSON.stringify(saved))
      persist()
      window.addEventListener('pagehide', persist, { once: true })
    })()`)
    writeFileSync(proofPath, JSON.stringify(proof))
  } else {
    assert.deepEqual(proof, JSON.parse(readFileSync(proofPath, 'utf8')))
  }
  console.log(`Windows ${release()}, Electron ${process.versions.electron}: ${mode} passed for fai startup and both saved DMs`)
}

async function checkWorkBrief(invoke, window, mode, profile, baseUrl) {
  const evaluate = (expression) => window.webContents.executeJavaScript(expression)
  const chief = await primaryFai(invoke)
  const dm = await invoke('conv:open-dm', {botId: chief.id})
  const query = {conversationId: dm.id}
  const panel = 'aside[aria-label="Work in this chat"]'
  const contains = (value) => `document.querySelector(${JSON.stringify(panel)})?.innerText.includes(${JSON.stringify(value)})`
  if (mode === 'brief') {
    const model = await configureModel(invoke,profile,baseUrl)
    await invoke('bots:update', {id: chief.id, patch: {model}})
    await invoke('conv:send', {...query, text:'Plan the pickup note.', clientNonce:'pickup', mentions:[],mentionsEveryone:false,attachmentPaths:[]})
    await waitForWindow(evaluate, contains('Which pickup gate?'), 'the owner question')
    const [brief] = await invoke('work:list',query)
    assert.equal(brief.state,'needs_input')
    writeFileSync(join(profile,'brief-id.txt'),brief.id)
  } else if (mode === 'brief-answer') {
    await waitForWindow(evaluate,contains('Which pickup gate?'),'the recovered owner question')
    await evaluate(`[...document.querySelectorAll('[aria-label="Suggested answers"] button')].find(b=>b.textContent==='Gate 4').click()`)
    await waitForWindow(evaluate,`document.querySelector('textarea[aria-label="Your answer"]').value === 'Gate 4'`, 'the editable selected answer')
    assert.equal((await invoke('work:list',query))[0].state,'needs_input')
    await waitForWindow(evaluate, `[...document.querySelectorAll('button')].some(b=>b.textContent==='Send answer' && !b.disabled)`, 'the answer button')
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Send answer').click()`)
    await waitForWindow(evaluate,contains('Meet at Gate 4.'),'the pickup note')
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Accept result').click()`)
    await waitForWindow(evaluate,contains('Accepted'),'the owner acceptance')
  } else {
    await waitForWindow(evaluate,contains('Accepted'),'the persisted acceptance')
    const briefs = await invoke('work:list',query)
    assert.equal(briefs.length,1)
    assert.equal(briefs[0].id,readFileSync(join(profile,'brief-id.txt'),'utf8'))
    assert.equal(briefs[0].state,'accepted')
    const {entries} = await invoke('conv:entries',query)
    assert.equal(entries.filter(entry=>entry.clientNonce?.startsWith('work-')).length,1)
  }
  console.log(`Windows ${release()}, Electron ${process.versions.electron}: ${mode} passed for the same work brief.`)
}

async function checkSourceComparison(invoke, window, profile) {
  const evaluate = source => window.webContents.executeJavaScript(source)
  const name = 'Supplier comparison'
  const project = await invoke('projects:create',{name})
  for (const [file,body] of [['quote-a.md','Price: 40 QAR'],['quote-b.md','Price: ٤٠ QAR'],['quote-c.md','Price: 45 QAR']]) {
    const path = join(profile,file)
    writeFileSync(path,body)
    await invoke('projects:attach-notes',{projectId:project.id,paths:[path]})
  }
  const loaded = new Promise(done=>window.webContents.once('did-finish-load',done))
  window.webContents.reload()
  await loaded
  const click = async (tag,label) => {
    const selector = `[...document.querySelectorAll(${JSON.stringify(tag)})].find(el=>el.textContent.trim()===${JSON.stringify(label)} && !el.disabled)`
    await waitForWindow(evaluate,`Boolean(${selector})`,label)
    await evaluate(`${selector}.click()`)
  }
  await click('button',name)
  await click('button','Start fresh')
  await waitForWindow(evaluate,`Boolean(document.querySelector('input[aria-label="Search selected evidence"]'))`,'evidence search')
  await evaluate(`document.querySelector('input[aria-label="Search selected evidence"]').focus()`)
  await window.webContents.insertText('Price')
  await click('button','Search evidence')
  await click('summary','Compare source lines')
  const groups = await evaluate(`[...document.querySelectorAll('article[aria-label="Saved answer"] dl dd')].map(node=>node.innerText)`)
  assert.equal(groups.length,2)
  assert.ok(groups.some(row=>row.includes('40 qar') && row.includes('quote-a.md r1, line 1') && row.includes('quote-b.md r1, line 1')))
  assert.ok(groups.some(row=>row.includes('45 qar') && row.includes('quote-c.md r1, line 1')))
  console.log('Windows project search linked all three selected quotes to their checked source lines.')
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
        assert.equal(await window.webContents.executeJavaScript('document.title'), 'faibots')
        assert.equal(window.getTitle(), 'faibots')
        if (mode === 'source-comparison') {
          await checkSourceComparison(invoke,window,profile)
          // A final renderer request can arrive while Electron is closing its windows.
          window.once('close', (event) => {
            event.preventDefault()
            void invoke('conv:exchange-summaries', {conversationId:'closing', entryIds:['last-render']})
              .then((rows) => {
                assert.deepEqual(rows, [])
                console.log('Final renderer read completed during Windows shutdown.')
                app.quit()
              })
              .catch((error) => { console.error(error); app.exit(1) })
          })
          app.quit()
          return
        }
        if (mode.startsWith('brief')) {
          await checkWorkBrief(invoke,window,mode,profile,baseUrl)
          app.quit()
          return
        }
        if (mode === 'chat' || mode === 'chat-reopen') {
          await checkDirectChat(invoke, window, mode, profile, baseUrl)
          app.quit()
          return
        }
        const proofPath = join(profile, 'smoke-proof.json')
        let project
        if (mode === 'draft') {
          const model = await configureModel(invoke, profile, baseUrl)
          const chief = await primaryFai(invoke)
          await invoke('bots:update', { id: chief.id, patch: { model } })
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
  const electron = process.env.FAIBOTS_SMOKE_ELECTRON || require('electron')
  const { server, baseUrl } = await startFixture()
  try {
    for (const stages of [['chat', 'chat-reopen'], ['draft', 'reopen'], ['brief','brief-answer','brief-reopen'], ['source-comparison']]) {
      const profile = mkdtempSync(join(tmpdir(), 'faibots-desktop-'))
      mkdirSync(join(profile, 'workspaces'))
      for (const mode of stages) {
        const exitCode = await new Promise((done, fail) => {
          const child = spawn(electron, [__filename, mode, profile, baseUrl], { stdio: 'inherit', timeout: 65_000 })
          child.once('error', fail)
          child.once('close', done)
        })
        assert.equal(exitCode, 0, `Electron did not complete the ${mode} check`)
      }
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
