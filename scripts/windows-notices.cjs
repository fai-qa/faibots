// Stage readable notices for NSIS and verify the files actually embedded in the installer.
const { execFileSync } = require('node:child_process')
const { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve, sep } = require('node:path')
const manifest = require('./windows-notices.json')

const source = resolve(__dirname, '..')
const unpdf = 'node_modules/unpdf'

function contents(file) {
  const bytes = readFileSync(file)
  if (!bytes.length) throw new Error(`Empty distribution notice: ${file}`)
  return bytes
}

function expectedNotices() {
  const notices = new Map()
  for (const [name, file] of Object.entries(manifest.files)) {
    notices.set(join('licenses', name), contents(join(source, file)))
  }
  const [firstLine] = contents(join(source, manifest.proComponent)).toString('utf8').split(/\r?\n/, 1)
  if (!firstLine.startsWith('// affectUI Pro')) throw new Error('Missing affectUI Pro notice in the integrated component.')
  notices.set(join('licenses', 'THIRD_PARTY_LICENSES', 'affectui-Pro.txt'), Buffer.from(firstLine.slice(3) + '\n'))
  for (const name of manifest.pdfFiles) {
    notices.set(join('resources', 'app.asar.unpacked', unpdf, name), contents(join(source, unpdf, name)))
  }
  return notices
}

function verify(folder, notices) {
  for (const [name, expected] of notices) {
    if (!contents(join(folder, name)).equals(expected)) throw new Error(`Incorrect distribution notice: ${name}`)
  }
}

module.exports = function afterPack({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'win32') return
  const notices = expectedNotices()
  for (const [name, bytes] of notices) {
    // electron-builder already copies unpdf's licenses through asarUnpack.
    if (!name.startsWith('licenses')) continue
    const file = join(appOutDir, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
  }
  verify(appOutDir, notices)
}

if (require.main === module) {
  const [installer, sevenZip = '7z'] = process.argv.slice(2)
  if (!installer) throw new Error('Pass the path to the built Windows x64 NSIS installer.')
  const temp = mkdtempSync(join(tmpdir(), 'faibots-installer-notices-'))
  try {
    const notices = expectedNotices()
    const archive = join(temp, 'app-64.7z')
    const fd = openSync(archive, 'wx')
    try {
      execFileSync(sevenZip, ['e', '-so', resolve(installer), '$PLUGINSDIR/app-64.7z'], { stdio: ['ignore', fd, 'pipe'] })
    } finally {
      closeSync(fd)
    }
    const names = [...notices.keys()].map(name => name.split(sep).join('/'))
    execFileSync('tar.exe', ['-xf', archive, '-C', temp, ...names])
    verify(temp, notices)
    console.log(`Verified ${notices.size} license and notice files in the Windows installer.`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
