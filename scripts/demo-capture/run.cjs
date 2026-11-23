// Record the built faibots window on a Windows desktop.
// The stand-in server, Electron, and ffmpeg all stay local to this job.

const { spawn, spawnSync } = require('node:child_process')
const { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { startStandIn } = require('./stand-in-server.cjs')

const root = resolve(__dirname, '..', '..')
const outDir = process.env.DEMO_OUT || join(root, 'demo-out')
const profile = process.env.DEMO_PROFILE || join(process.env.RUNNER_TEMP || tmpdir(), 'faibots-demo-data')
const drive = join(__dirname, 'drive.cjs')
const capturePath = join(outDir, 'capture.mp4')
const demoPath = join(outDir, 'demo.mp4')

function log(line) {
  console.log(`[capture] ${line}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function ffmpegBin() {
  const bin = process.env.FFMPEG || 'ffmpeg'
  if (process.env.FFMPEG && !existsSync(bin)) throw new Error(`ffmpeg was not found at ${bin}`)
  return bin
}

function ffprobeBin() {
  if (process.env.FFPROBE && existsSync(process.env.FFPROBE)) return process.env.FFPROBE
  const ffmpeg = ffmpegBin()
  const sibling = join(resolve(ffmpeg, '..'), 'ffprobe.exe')
  if (existsSync(sibling)) return sibling
  return 'ffprobe'
}

function runTool(bin, args) {
  const result = spawnSync(bin, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status})\n${result.stdout || ''}\n${result.stderr || ''}`)
  }
  return result.stdout || ''
}

function pngSize(file) {
  const buf = readFileSync(file)
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function durationSeconds(file) {
  const bin = ffprobeBin()
  const output = runTool(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).trim()
  const value = Number(output)
  if (!Number.isFinite(value)) throw new Error(`Could not read the duration of ${file}: ${output}`)
  return value
}

function dumpLog(name) {
  const file = join(outDir, name)
  if (!existsSync(file)) {
    log(`${name} was not created`)
    return
  }
  const text = readFileSync(file, 'utf8')
  log(`--- ${name} ---\n${text.slice(-6000)}`)
}

async function waitForReady(stop) {
  const readyPath = join(outDir, 'ready.json')
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    if (stop.closed) throw new Error(`The app exited with code ${stop.code} before it was ready.`)
    if (existsSync(readyPath)) {
      const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
      if (ready.ok === false) throw new Error(ready.error || 'The app failed before the recording started.')
      return
    }
    await sleep(200)
  }
  throw new Error('The app did not become ready. See demo-out/electron.log.')
}

function startRecorder(bin) {
  const args = [
    '-y',
    '-f', 'gdigrab',
    '-framerate', '30',
    '-draw_mouse', '0',
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '16',
    '-pix_fmt', 'yuv420p',
    '-g', '15',
    '-an',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    capturePath
  ]
  log(`ffmpeg ${args.join(' ')}`)
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const logPath = join(outDir, 'ffmpeg.log')
  const write = (chunk) => {
    try { appendFileSync(logPath, chunk) } catch { /* keep recording */ }
  }
  child.stdout.on('data', write)
  child.stderr.on('data', write)
  return child
}

function stopRecorder(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      resolve()
    }, 8000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.stdin.write('q\n') } catch { child.kill() }
  })
}

function proofTime(shot) {
  const proof = typeof shot.proof === 'number' ? shot.proof : shot.end - 1
  const lower = shot.start + 0.2
  const upper = Math.max(lower, shot.end - 0.3)
  return Math.max(0, Math.min(Math.max(proof, lower), upper))
}

function extractFrames(bin) {
  const shots = JSON.parse(readFileSync(join(outDir, 'shots.json'), 'utf8'))
  for (const shot of shots) {
    const at = proofTime(shot).toFixed(3)
    const file = join(outDir, `shot-${shot.n}.png`)
    log(`frame shot ${shot.n} at ${at}s`)
    runTool(bin, ['-y', '-i', demoPath, '-ss', at, '-frames:v', '1', file])
    if (!existsSync(file)) throw new Error(`Missing frame ${file}`)
  }
}

function verifyOutputs(wallSeconds) {
  const shotsText = readFileSync(join(outDir, 'shots.txt'), 'utf8').trim().split(/\r?\n/)
  if (shotsText.length !== 5) throw new Error(`shots.txt has ${shotsText.length} lines, expected 5.`)
  shotsText.forEach((line, index) => {
    const match = /^(\d+\.\d) (\d+\.\d)$/.exec(line)
    if (!match) throw new Error(`shots.txt line ${index + 1} is not "start end": ${line}`)
    if (Number(match[2]) <= Number(match[1])) throw new Error(`shot ${index + 1} ends before it starts: ${line}`)
  })
  const size = pngSize(join(outDir, 'group-chat.png'))
  if (size.width !== 1280 || size.height !== 720) {
    throw new Error(`group-chat.png is ${size.width}x${size.height}, expected 1280x720.`)
  }
  const videoSeconds = durationSeconds(demoPath)
  const bytes = statSync(demoPath).size
  log(`demo.mp4 ${bytes} bytes, ${videoSeconds.toFixed(1)}s, wall ${wallSeconds.toFixed(1)}s`)
  if (bytes < 500000) throw new Error(`demo.mp4 is only ${bytes} bytes.`)
  if (videoSeconds + 2 < wallSeconds * 0.8) {
    throw new Error(`The recording is ${videoSeconds.toFixed(1)}s after a ${wallSeconds.toFixed(1)}s demo. ffmpeg did not keep up with the desktop.`)
  }
  for (let n = 1; n <= 5; n += 1) {
    if (!existsSync(join(outDir, `shot-${n}.png`))) throw new Error(`Missing shot-${n}.png`)
  }
  const standInLog = existsSync(join(outDir, 'stand-in.log')) ? readFileSync(join(outDir, 'stand-in.log'), 'utf8') : ''
  if (!standInLog.includes('send_to_agent')) throw new Error('The stand-in never asked another bot.')
  if (!standInLog.includes('-> text')) throw new Error('The stand-in never returned a text reply.')
  const summary = [
    'Demo capture',
    '',
    '```',
    ...shotsText,
    '```',
    '',
    `group-chat.png ${size.width}x${size.height}`,
    `demo.mp4 ${(bytes / 1024 / 1024).toFixed(1)} MiB, ${videoSeconds.toFixed(1)}s`
  ].join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
  log(shotsText.join(' | '))
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The demo capture runs on Windows.')
  const electron = process.env.FAIBOTS_DEMO_ELECTRON
  if (!electron || !existsSync(electron)) throw new Error('Set FAIBOTS_DEMO_ELECTRON to electron.exe.')
  if (!existsSync(join(root, 'out', 'main', 'index.js'))) throw new Error('Build the app with npm run build before recording.')

  rmSync(outDir, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  mkdirSync(profile, { recursive: true })

  const standIn = await startStandIn({ logPath: join(outDir, 'stand-in.log') })
  log(`stand-in ${standIn.baseUrl}`)
  const bin = ffmpegBin()
  let recorder
  let videoStartedAt = 0
  let wallSeconds = 0
  let failure = null
  let killTimer
  try {
    const stop = { closed: false, code: null }
    const child = spawn(electron, [drive, '--', profile, standIn.baseUrl, outDir], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: '',
        ELECTRON_ENABLE_LOGGING: '1'
      }
    })
    const electronLog = join(outDir, 'electron.log')
    const writeElectron = (chunk) => {
      process.stdout.write(chunk)
      try { appendFileSync(electronLog, chunk) } catch { /* keep the app running */ }
    }
    child.stdout.on('data', writeElectron)
    child.stderr.on('data', writeElectron)
    log(`spawned electron pid ${child.pid}`)
    const appDone = new Promise((resolve, reject) => {
      killTimer = setTimeout(() => {
        child.kill()
        reject(new Error('The app ran for more than 8 minutes.'))
      }, 8 * 60 * 1000)
      child.once('error', (error) => {
        clearTimeout(killTimer)
        stop.closed = true
        stop.code = error.message
        resolve(1)
      })
      child.once('close', (code) => {
        clearTimeout(killTimer)
        stop.closed = true
        stop.code = code ?? 1
        resolve(stop.code)
      })
    })

    await waitForReady(stop)
    spawnSync('powershell.exe', ['-NoProfile', '-Command', '(New-Object -ComObject Shell.Application).MinimizeAll()'], { windowsHide: true })
    await sleep(400)
    recorder = startRecorder(bin)
    await sleep(800)
    if (recorder.exitCode !== null) {
      dumpLog('ffmpeg.log')
      throw new Error(`ffmpeg exited with code ${recorder.exitCode} before the demo.`)
    }
    videoStartedAt = Date.now()
    writeFileSync(join(outDir, 'go.json'), JSON.stringify({ videoStartedAt }))
    log('recording')
    const appExit = await appDone
    if (appExit !== 0) throw new Error(`The app exited with code ${appExit}. See demo-out/electron.log.`)
  } catch (error) {
    failure = error
    dumpLog('electron.log')
    dumpLog('ffmpeg.log')
  } finally {
    clearTimeout(killTimer)
    await stopRecorder(recorder)
    if (videoStartedAt) wallSeconds = (Date.now() - videoStartedAt) / 1000
    await standIn.close()
  }

  if (existsSync(capturePath)) {
    try {
      log('remux to demo.mp4')
      runTool(bin, ['-y', '-i', capturePath, '-c', 'copy', '-movflags', '+faststart', demoPath])
      rmSync(capturePath, { force: true })
      if (existsSync(join(outDir, 'shots.json'))) extractFrames(bin)
    } catch (error) {
      if (!failure) failure = error
      else log(error instanceof Error ? error.message : String(error))
    }
  } else if (!failure) {
    failure = new Error('ffmpeg did not write a capture.')
  }

  if (!failure) {
    verifyOutputs(wallSeconds)
    log('capture complete')
  }
  if (failure) throw failure
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error)
  process.exitCode = 1
})
