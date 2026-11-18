import type { FaiBotsBridge } from '../shared/ipc'

declare global {
  interface Window {
    faibots: FaiBotsBridge
  }
}

export {}
