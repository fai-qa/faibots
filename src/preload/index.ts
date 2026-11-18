import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type InvokeChannel,
  type FaiBotsBridge
} from '@shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

const bridge: FaiBotsBridge = {
  invoke(channel: InvokeChannel, req: unknown) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`))
    return ipcRenderer.invoke(channel, req)
  },
  on(channel: EventChannel, listener: (payload: unknown) => void) {
    if (!eventAllowed.has(channel)) throw new Error(`Blocked IPC event: ${channel}`)
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
} as FaiBotsBridge

contextBridge.exposeInMainWorld('faibots', bridge)
