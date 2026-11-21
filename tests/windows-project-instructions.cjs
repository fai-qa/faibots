// Review, trial, activate and roll back a project correction through the production Windows UI.
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createServer } = require('node:http')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { setTimeout: delay } = require('node:timers/promises')

const name = 'Instruction QA'
const rule = 'Add the next decision heading to the proposal.'
const required = '## Next decision'
const profileKey = 'project-proof.json'

async function wait(fn, description) {
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    const result = await fn()
    if (result) return result
    await delay(80)
  }
  throw new Error('Timed out waiting for ' + description)
}

function model(messages) {
  const index = messages.findLastIndex((m) => m.role === 'user')
  const text = (m) => Array.isArray(m.content) ? m.content.map((c) => c.text || '').join('\n') : String(m.content || '')
  const prompt = text(messages[index])
  const tool = messages.slice(index + 1).filter((m) => m.role === 'tool').at(-1)
  if (prompt.includes('<<<REVIEW MESSAGE')) {
    if (tool) return 'Reviewed.'
    return ['send_to_agent', { to: 'editor', message: prompt.split('<<<REVIEW MESSAGE\n')[1].split('\nREVIEW MESSAGE>>>')[0] }]
  }
  if (prompt.includes('Review for mission run')) return 'VERDICT: accepted — verified against the selected notes.'
  const note = /mission-[a-f\d-]+\/project-notes\/1-[\w.-]+/.exec(prompt)?.[0]
  const path = /mission-[a-f\d-]+\/proposal\.md/.exec(prompt)?.[0]
  assert(note && path)
  if (!tool) return ['read_file', { path: note }]
  if (tool.tool_call_id === 'call-read_file') return ['write_file', {
    path, content: '# Proposal\n\n' + text(tool).slice(0,300) + (prompt.includes(rule) ? '\n\n' + required : '')
  }]
  return 'Saved the proposal.'
}

function serverForApp() {
  return createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.setHeader('content-type','application/json')
        return res.end(JSON.stringify({object:'list',data:[{id:'fixture',object:'model'}]}))
      }
      let body = ''
      for await (const part of req) body += part
      const answer = model(JSON.parse(body).messages)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id:'fixture',object:'chat.completion.chunk',created:0,model:'fixture',
        choices:[{index:0,delta,finish_reason}] })}\n\n`)
      if (Array.isArray(answer)) {
        chunk({ role:'assistant', tool_calls:[{ index:0,type:'function',id:'call-' + answer[0],function:{name:answer[0],arguments:JSON.stringify(answer[1])} }] },null)
        chunk({},'tool_calls')
      } else { chunk({role:'assistant',content:answer},null); chunk({},'stop') }
      res.end('data: [DONE]\n\n')
    } catch (err) { console.error(err); res.writeHead(500); res.end() }
  })
}

async function stage(mode, profile, baseUrl) {
  const { app } = require('electron')
  app.setPath('userData',profile)
  delete process.env.ELECTRON_RENDERER_URL
  app.once('browser-window-created', (_event, window) => window.webContents.once('did-finish-load', async () => {
    const js = (source) => window.webContents.executeJavaScript(source)
    const invoke = (channel,args) => js(`window.faibots.invoke(${JSON.stringify(channel)},${JSON.stringify(args)})`)
    const click = async (text,tag='button') => wait(() => js(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(tag)})].find(e=>e.textContent.trim()===${JSON.stringify(text)} && !e.disabled)
      if(b) b.click(); return !!b
    })()`),text)
    try {
      let projectId
      if (mode === 'create') {
        const p = await invoke('providers:save',{kind:'openai-compatible',label:'Disposable fixture',baseUrl,defaultModelId:'fixture',enabled:true})
        const model = { providerId:p.id,modelId:'fixture' }
        const chief = (await invoke('bots:list')).find((b)=>b.isPrimary)
        await invoke('bots:update',{id:chief.id,patch:{model}})
        await invoke('bots:create',{name:'Editor',handle:'editor',model})
        await invoke('settings:update',{workspaceRoot:join(profile,'workspaces')})
        projectId = (await invoke('projects:create',{name})).id
        for (const [index,body] of ['The first team plans a workshop.','A separate team plans a design review.'].entries()) {
          if (index) {
            const { library } = await invoke('content:project',{projectId})
            await invoke('content:select',{projectId,itemId:library[0].itemId,selected:false})
          }
          const path = join(profile,`notes-${index}.md`)
          writeFileSync(path,body)
          await invoke('projects:attach-notes',{projectId,paths:[path]})
          await invoke('projects:start-mission',{projectId})
          await wait(async () => (await invoke('improvement:list',{projectId})).cases.length === index+1,'reviewed baseline')
        }
        writeFileSync(join(profile,profileKey),JSON.stringify({projectId}))
        // The baselines were prepared via IPC. Reload once so the sidebar reads the project list.
        const reloaded = new Promise((done) => window.webContents.once('did-finish-load',done))
        window.webContents.reload()
        await reloaded
      } else ({projectId} = JSON.parse(readFileSync(join(profile,profileKey),'utf8')))
      await click(name)
      await wait(() => js(`(() => {const el=[...document.querySelectorAll('summary')].find(e=>e.textContent.includes('Project instructions'));if(el&&!el.parentElement.open)el.click();return !!el})()`),'project instructions')
      const read = () => invoke('improvement:list',{projectId})
      if (mode === 'create') {
        const [heldout,matched] = (await read()).cases
        await js(`(() => { const details=[...document.querySelectorAll('details')].find(d=>d.querySelector(':scope > summary')?.textContent.startsWith('Project instructions'));
          const values=${JSON.stringify([rule,required,matched.runId,heldout.runId])};
          const fields=details.querySelectorAll('form textarea,form input,form select');
          fields.forEach((node,i)=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node),'value').set.call(node,values[i]);node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}))})
        })()`)
        await click('Propose correction')
        await click('Approve for trials')
        for (const lane of ['matched','heldout']) {
          await click(`Run ${lane==='heldout'?'held-out':'matched'} trial`)
          await wait(async () => (await read()).trials.some(t=>t.lane===lane && t.observed==='passed'),lane + ' evidence')
        }
        await click('Publish to this project')
        await wait(async () => (await read()).active?.version===1,'active version')
        assert.equal((await read()).cases.length,2)
      } else {
        assert.equal((await read()).active.version,1)
        await click('Roll back version 1')
        await wait(async () => (await read()).active===null,'rollback')
        assert.deepEqual((await read()).history.map((event)=>event.action),['rollback','publish'])
      }
      console.log('Project instructions UI: ' + mode + ' passed')
      app.quit()
    } catch (err) {
      console.error(err)
      console.error(await js('document.body.innerText.slice(0,1600)'))
      app.exit(1)
    }
  }))
  await import(pathToFileURL(join(__dirname,'..','out','main','index.js')).href)
}

async function smoke() {
  assert.equal(process.platform,'win32')
  const profile = mkdtempSync(join(tmpdir(),'faibots-project-skills-'))
  mkdirSync(join(profile,'workspaces'))
  const server = serverForApp()
  await new Promise((ok,no) => { server.once('error',no); server.listen(0,'127.0.0.1',ok) })
  try {
    const url = `http://127.0.0.1:${server.address().port}/v1`
    for (const mode of ['create','reopen']) {
      const child = spawn(process.env.FAIBOTS_SMOKE_ELECTRON || require('electron'),[__filename,mode,profile,url],{stdio:'inherit',timeout:100_000})
      const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
      assert.equal(code,0,mode)
    }
  } finally { server.closeAllConnections(); server.close() }
}
const task = process.versions.electron ? stage(...process.argv.slice(-3)) : smoke()
task.catch((err)=>{console.error(err);process.exitCode=1})
