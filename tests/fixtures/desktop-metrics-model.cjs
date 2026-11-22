// Local deterministic model for completed-task measurements. It can read only what the app sends.
const assert = require('node:assert/strict')
const { createServer } = require('node:http')

const sourceName = 'workshop-r1.md'
const sourceText = '# Pilot brief, revision 1\nPilot ceiling is QAR 12,000. Sponsor approval is pending.\n'
const question = 'What ceiling does the selected pilot brief give and who approved it?'
const directAnswer = 'The ceiling is QAR 12,000. Sponsor approval is pending. Source: workshop-r1.md, revision 1.'
const firstDraft = '# Pilot proposal\n\nScope: a workshop pilot.\nBudget: QAR 12,000.\nSource: workshop-r1.md, revision 1.'
const fixedDraft = firstDraft + '\nAssumption: sponsor approval is pending.'
const textOf = (message) =>
  Array.isArray(message?.content)
    ? message.content.map((part) => part.text ?? '').join('\n')
    : String(message?.content ?? '')

function startFixture() {
  const revisions = new Map()
  function reply(messages) {
    const userIndex = messages.findLastIndex((m) => m.role === 'user')
    const prompt = textOf(messages[userIndex])
    const tool = messages.slice(userIndex + 1).findLast((m) => m.role === 'tool')
    if (prompt.includes(question)) {
      if (!tool) {
        const path = /\[Attached file: workshop-r1\.md .*? at ([^\]]+)\]/.exec(prompt)?.[1]
        assert(path, 'No readable attached revision in direct question')
        return { name: 'read_file', args: { path } }
      }
      assert(textOf(tool).includes('Sponsor approval is pending.'), 'Direct answer needs the selected evidence')
      return directAnswer
    }
    if (prompt.includes('<<<REVIEW MESSAGE')) {
      if (tool) return 'Review received.'
      return {
        name: 'send_to_agent',
        args: {
          to: '@workshop-reviewer',
          message: prompt.split('<<<REVIEW MESSAGE\n')[1].split('\nREVIEW MESSAGE>>>')[0]
        }
      }
    }
    if (prompt.includes('Review for mission run')) {
      assert(
        prompt.includes('Pilot ceiling is QAR 12,000. Sponsor approval is pending.'),
        'Reviewer did not receive the source'
      )
      return prompt.includes(fixedDraft)
        ? 'The budget and approval statement agree with the source.\nVERDICT: accepted — All required evidence is present.'
        : 'The sponsor approval status is missing.\nVERDICT: repair — State the unresolved assumption.'
    }
    const path = /mission-([\da-f-]+)\/project-notes\/1-workshop-r1\.md/.exec(prompt)
    assert(path, 'Missing selected project source in draft turn')
    if (!revisions.has(path[1])) revisions.set(path[1], revisions.size)
    if (!tool) return { name: 'read_file', args: { path: path[0] } }
    if (tool.tool_call_id === 'measure_write_file') return 'Proposal saved.'
    assert(textOf(tool).includes('QAR 12,000'), 'Drafting did not read the current source')
    return {
      name: 'write_file',
      args: {
        path: 'mission-' + path[1] + '/proposal.md',
        content: revisions.get(path[1]) % 2 === 0 ? firstDraft : fixedDraft
      }
    }
  }
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'local-measure', object: 'model' }] }))
        return
      }
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      let payload = ''
      for await (const chunk of request) payload += chunk
      const result = reply(JSON.parse(payload).messages)
      const tool = typeof result !== 'string'
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'measure_' + result.name,
                type: 'function',
                function: { name: result.name, arguments: JSON.stringify(result.args) }
              }
            ]
          }
        : { role: 'assistant', content: result }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const [increment, reason] of [
        [delta, null],
        [{}, tool ? 'tool_calls' : 'stop']
      ]) {
        response.write(
          'data: ' +
            JSON.stringify({
              id: 'measure',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'local-measure',
              choices: [{ index: 0, delta: increment, finish_reason: reason }]
            }) +
            '\n\n'
        )
      }
      // This model has no tokenizer or price. Missing provider usage must stay unknown in the receipt.
      response.end('data: [DONE]\n\n')
    } catch (error) {
      console.error('Fixture:', error.message)
      response.writeHead(400)
      response.end(String(error.message))
    }
  })
  return new Promise((resolve, reject) =>
    server
      .once('error', reject)
      .listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port + '/v1' }))
  )
}
module.exports = { startFixture, sourceName, sourceText, question, directAnswer, fixedDraft }
