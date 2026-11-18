import { openStore } from '../../src/main/store'
const [path, botId, id, timestamp] = process.argv.slice(2)
const store = openStore(path!, { homeDir: '/unused-test-home' })
process.send?.({ ready: true })
process.once('message', () => {
  const admitted = store.turns.reserveAutomatic({ id: id!, botId: botId!, startedAt: Number(timestamp) })
  process.send?.({ admitted })
  // Parent terminates this process without a completed turn log: the slot must remain charged.
})
