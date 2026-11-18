// Standalone browser-only fixture. Not imported by the application entry point.
import { createMockBridge } from './src/lib/mock-bridge'
import { useUi } from './src/store/ui'

if (window.faibots) throw new Error('This fixture must never run against an Electron bridge')
const mock = createMockBridge()
let calls = 0
let created = 0
let failures = 0
let pending = []
const render = () => {
  document.getElementById('counts').textContent = `bots:create calls: ${calls} | pending: ${pending.length} | created: ${created} | rejected: ${failures}`
}
window.faibots = {
  on: mock.on,
  invoke(channel, request) {
    if (channel !== 'bots:create') return mock.invoke(channel, request)
    calls++
    return new Promise((resolve, reject) => {
      pending.push({ request, resolve, reject })
      render()
    })
  }
}
document.getElementById('open').onclick = () => useUi.setState({ newBotOpen: true })
document.getElementById('resolve').onclick = async () => {
  const batch = pending
  pending = []
  render()
  for (const item of batch) {
    const bot = await mock.invoke('bots:create', item.request)
    created++
    item.resolve(bot)
    render()
  }
}
document.getElementById('reject').onclick = () => {
  const batch = pending
  pending = []
  for (const item of batch) {
    failures++
    item.reject(new Error('Deterministic fixture rejection; retry is allowed'))
  }
  render()
}
document.getElementById('burst').onclick = () => {
  const input = document.querySelector('input[placeholder="Researcher"]')
  if (!input) throw new Error('Open the real New Bot dialog first')
  for (let index = 0; index < 3; index++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}
render()
await import('./src/main')
