// OpenAI-compatible stand-in for the demo capture. Plain Node, no dependencies.
// Every visible reply starts with "[stand-in model]". This is canned text, not a model.

const { createServer } = require('node:http')
const { appendFileSync } = require('node:fs')

const LABEL = '[stand-in model]'

const SUMMARY = [
  LABEL,
  '- The riverside market opens at 8.',
  '- Stall holders bring their own tables.',
  '- The square closes at noon on market day.'
].join('\n')

const ASK = `${LABEL} Please tighten these three notes into one sentence: the riverside market opens at 8, stall holders bring their own tables, and the square closes at noon.`
const EDITOR_EXCHANGE = `${LABEL} Tightened: The riverside market runs from 8 until noon, and stall holders bring their own tables.`
const RESEARCHER_FOLLOWUP = `${LABEL} I asked Editor to tighten the three notes. @editor, please confirm this line: The riverside market runs from 8 until noon, and stall holders bring their own tables.`
const EDITOR_GROUP = `${LABEL} Yes. That line matches the notes: open at 8, own tables, and close at noon.`
const REVIEWER_GROUP = `${LABEL} That line covers all three notes.`
const FALLBACK = `${LABEL} This stand-in has no other scripted reply.`

function textOf(message) {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      if (typeof part.text === 'string') return part.text
      if (typeof part.content === 'string') return part.content
      return ''
    }).join('\n')
  }
  if (typeof message.text === 'string') return message.text
  return ''
}

function flatten(messages) {
  return (messages || []).map((message) => `[${message.role}] ${textOf(message)}`).join('\n')
}

function hasToolResult(messages) {
  return (messages || []).some((message) => {
    if (message.role === 'tool') return true
    return Array.isArray(message.content) && message.content.some((part) => part && (part.type === 'tool-result' || part.type === 'tool_result'))
  })
}

function labeled(text) {
  const body = String(text || '').trim()
  return body.startsWith(LABEL) ? body : `${LABEL} ${body}`
}

function asText(text) {
  return { type: 'text', text: labeled(text) }
}

function asTool(name, args) {
  return { type: 'tool', name, arguments: args }
}

/** Pick a canned chat completion from the request the app actually sends. */
function decide(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : []
  const flat = flatten(messages)
  const identity = /You are ([^(\n]+?) \(@([a-z0-9_-]+)\)/.exec(flat)
  const name = identity ? identity[1].trim() : ''
  const kind = flat.includes('A side conversation with')
    ? 'exchange'
    : flat.includes('The group chat "')
      ? 'group'
      : flat.includes('A private chat between you and')
        ? 'dm'
        : 'other'
  const tool = hasToolResult(messages)
  const spoke = messages.filter((message) => message.role === 'assistant').map(textOf).join('\n').includes(LABEL)
  const addressed = flat.includes('you were addressed, so reply')

  let decision
  if (kind === 'exchange') {
    decision = asText(name === 'Editor' ? EDITOR_EXCHANGE : FALLBACK)
  } else if (flat.includes('Summarise these 3 notes into 3 bullet points.') && kind !== 'group') {
    decision = asText(SUMMARY)
  } else if (kind === 'group' && name === 'Researcher') {
    if (tool) decision = asText(RESEARCHER_FOLLOWUP)
    else if (spoke) decision = asTool('pass_turn', { reason: 'Already brought the edit back.' })
    else decision = asTool('send_to_agent', { to: '@editor', message: ASK, reason: 'Editor tightens wording.' })
  } else if (kind === 'group' && name === 'Editor') {
    decision = addressed ? asText(EDITOR_GROUP) : asTool('pass_turn', { reason: 'Nothing to add.' })
  } else if (kind === 'group' && name === 'Reviewer') {
    const lineIsIn = flat.includes('The riverside market runs from 8 until noon')
    if (spoke || !lineIsIn) decision = asTool('pass_turn', { reason: 'Nothing to add.' })
    else decision = asText(REVIEWER_GROUP)
  } else if (kind === 'group') {
    decision = addressed ? asText(FALLBACK) : asTool('pass_turn', { reason: 'Nothing to add.' })
  } else if (kind === 'dm') {
    decision = asText(FALLBACK)
  } else {
    decision = asText(FALLBACK)
  }

  if (decision.type === 'text' && !decision.text.startsWith(LABEL)) {
    throw new Error('Refusing to send an unlabeled reply')
  }
  if (decision.type === 'tool' && decision.name === 'send_to_agent' && !String(decision.arguments.message).startsWith(LABEL)) {
    throw new Error('Refusing to send an unlabeled ask')
  }
  return { decision, meta: { kind, name, tool, spoke, addressed } }
}

function chunk(model, delta, finish) {
  return {
    id: 'stand-in',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  }
}

function writeEvent(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

async function writeTextStream(response, model, text) {
  const pieces = []
  for (let i = 0; i < text.length; i += 12) pieces.push(text.slice(i, i + 12))
  writeEvent(response, chunk(model, { role: 'assistant', content: '' }, null))
  for (const piece of pieces) {
    writeEvent(response, chunk(model, { content: piece }, null))
    await new Promise((resolve) => setTimeout(resolve, 28))
  }
  writeEvent(response, {
    ...chunk(model, {}, 'stop'),
    usage: { prompt_tokens: 24, completion_tokens: pieces.length, total_tokens: 24 + pieces.length }
  })
  response.end('data: [DONE]\n\n')
}

function writeToolStream(response, model, decision) {
  writeEvent(response, chunk(model, {
    role: 'assistant',
    tool_calls: [{
      index: 0,
      id: `call_${decision.name}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: decision.name, arguments: JSON.stringify(decision.arguments) }
    }]
  }, null))
  writeEvent(response, {
    ...chunk(model, {}, 'tool_calls'),
    usage: { prompt_tokens: 24, completion_tokens: 8, total_tokens: 32 }
  })
  response.end('data: [DONE]\n\n')
}

function startStandIn(options = {}) {
  const logPath = options.logPath
  const log = (line) => {
    if (!logPath) return
    try { appendFileSync(logPath, line + '\n') } catch { /* the demo log is best-effort */ }
  }
  const server = createServer(async (request, response) => {
    try {
      const url = request.url || ''
      if (request.method === 'GET' && (url === '/health' || url.startsWith('/health?'))) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
        return
      }
      if (request.method === 'GET' && /\/models\/?$/.test(url)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'stand-in', object: 'model', context_window: 128000 }]
        }))
        return
      }
      if (request.method !== 'POST' || !/\/chat\/completions\/?$/.test(url)) {
        response.writeHead(404)
        response.end('not found')
        return
      }
      let raw = ''
      for await (const part of request) raw += part
      const body = raw ? JSON.parse(raw) : {}
      const { decision, meta } = decide(body)
      const model = typeof body.model === 'string' && body.model ? body.model : 'stand-in'
      log(`${meta.kind} ${meta.name || '?'} tool=${meta.tool} spoke=${meta.spoke} addressed=${meta.addressed} -> ${decision.type}${decision.name ? ' ' + decision.name : ''}`)
      if (body.stream === false) {
        const message = decision.type === 'text'
          ? { role: 'assistant', content: decision.text }
          : {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `call_${decision.name}`,
              type: 'function',
              function: { name: decision.name, arguments: JSON.stringify(decision.arguments) }
            }]
          }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({
          id: 'stand-in',
          object: 'chat.completion',
          created: 0,
          model,
          choices: [{ index: 0, message, finish_reason: decision.type === 'text' ? 'stop' : 'tool_calls' }]
        }))
        return
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      if (decision.type === 'tool') writeToolStream(response, model, decision)
      else await writeTextStream(response, model, decision.text)
    } catch (error) {
      log(`error ${error instanceof Error ? error.stack || error.message : String(error)}`)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  const port = options.port || 0
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done) => server.close(() => done()))
      })
    })
  })
}

async function selfTest() {
  const { baseUrl, close } = await startStandIn()
  const post = async (messages) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stand-in', stream: true, messages })
    })
    const raw = await response.text()
    if (!response.ok) throw new Error(raw)
    if (!raw.includes('data: [DONE]')) throw new Error('missing DONE marker')
    let text = ''
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
      const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta
      if (delta?.content) text += delta.content
      if (delta?.tool_calls) text += JSON.stringify(delta.tool_calls)
    }
    return text
  }
  const system = (who, where) => ({ role: 'system', content: `You are ${who}.\n${where}` })
  const summary = await post([
    system('Researcher (@researcher).', 'A private chat between you and Sam.'),
    { role: 'user', content: [{ type: 'text', text: 'Summarise these 3 notes into 3 bullet points.\n\nNote 1: opens at 8.' }] }
  ])
  if (summary !== SUMMARY) throw new Error('summary reply was not the three notes')
  if (summary.includes('Morning trade') || summary.includes('not supplied')) throw new Error('summary added a fact')
  const ask = await post([
    system('Researcher (@researcher).', 'The group chat "Notes".'),
    { role: 'user', content: '[Sam] @researcher Ask Editor to tighten the notes.\n(faibots: you were addressed, so reply; do not pass.)' }
  ])
  if (!ask.includes('send_to_agent') || !ask.includes(LABEL)) throw new Error('group ask was not a labeled tool call')
  const follow = await post([
    system('Researcher (@researcher).', 'The group chat "Notes".'),
    { role: 'tool', content: EDITOR_EXCHANGE }
  ])
  if (!follow.includes('@editor') || !follow.includes(LABEL)) throw new Error('follow-up was not labeled')
  const exchange = await post([
    system('Editor (@editor).', 'A side conversation with Researcher (@researcher), who asked you for help.')
  ])
  if (!exchange.includes('Tightened:') || !exchange.includes(LABEL)) throw new Error('exchange reply was not labeled')
  const editor = await post([
    system('Editor (@editor).', 'The group chat "Notes".'),
    { role: 'user', content: '(faibots: you were addressed, so reply; do not pass.)' }
  ])
  if (!editor.includes('That line matches the notes') || !editor.includes(LABEL)) throw new Error('editor group reply was not labeled')
  const reviewer = await post([
    system('Reviewer (@reviewer).', 'The group chat "Notes".'),
    { role: 'user', content: '(faibots: nobody addressed you directly. Reply only if you can add something useful; otherwise call pass_turn.)' }
  ])
  if (!reviewer.includes('pass_turn')) throw new Error('reviewer did not pass')
  const reviewerSpeaks = await post([
    system('Reviewer (@reviewer).', 'The group chat "Notes".'),
    { role: 'user', content: '[Researcher] The riverside market runs from 8 until noon, and stall holders bring their own tables.\n(faibots: nobody addressed you directly. Reply only if you can add something useful; otherwise call pass_turn.)' }
  ])
  if (!reviewerSpeaks.startsWith(LABEL) || !reviewerSpeaks.includes('That line covers all three notes.')) throw new Error('reviewer group reply was not the three-note check')
  const reviewerAgain = await post([
    system('Reviewer (@reviewer).', 'The group chat "Notes".'),
    { role: 'assistant', content: REVIEWER_GROUP },
    { role: 'user', content: '[Editor] Yes. The riverside market runs from 8 until noon.\n(faibots: nobody addressed you directly. Reply only if you can add something useful; otherwise call pass_turn.)' }
  ])
  if (!reviewerAgain.includes('pass_turn')) throw new Error('reviewer spoke twice')
  const models = await fetch(`${baseUrl}/models`)
  if (!(await models.json()).data.some((row) => row.id === 'stand-in')) throw new Error('model list missing stand-in')
  await close()
  console.log('stand-in self-test passed')
}

module.exports = { startStandIn, decide, LABEL }

if (require.main === module && process.argv.includes('--self-test')) {
  selfTest().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
