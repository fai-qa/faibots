import type { HandoffReceipt, HandoffRequest } from '@shared/escalations'
import type { Services } from '../contracts'
import type { PlatformStore } from '../store'
import { chiefForHandoff, getHandoffCheckpoint, handoffOptions, prepareHandoff } from '../store/escalations'

export function escalationHandlers(s: Services, store: PlatformStore) {
  async function deliver(receipt: HandoffReceipt) {
    if (receipt.destinationEntryId) return receipt
    const nonce = 'escalation-' + receipt.id
    let entry = store.entries.findByNonce(receipt.chiefChatId, nonce)
    if (!entry) {
      const checkpoint = getHandoffCheckpoint(store, receipt.chiefChatId, { handoffId: receipt.id }, s)[0]
      if (checkpoint?.availability !== 'available') throw new Error(checkpoint?.reason || 'Handoff unavailable.')
      entry = await s.runtime.send({
        conversationId: receipt.chiefChatId,
        clientNonce: nonce,
        attachmentPaths: [],
        mentions: [],
        mentionsEveryone: false,
        text: `Please review my specialist handoff ${receipt.id} using read_handoff and answer me here.`
      })
    }
    store.db
      .prepare('update specialist_escalations set destination_entry=? where id=? and destination_entry is null')
      .run(entry.id, receipt.id)
    return { ...receipt, destinationEntryId: entry.id }
  }
  return {
    'handoff:options': ({ sourceChatId }: { sourceChatId: string }) => handoffOptions(store, sourceChatId),
    'handoff:read': ({ chiefChatId, id }: { chiefChatId: string; id: string }) =>
      getHandoffCheckpoint(store, chiefChatId, { handoffId: id }, s),
    'handoff:resume': async ({ sourceChatId, id }: { sourceChatId: string; id: string }) => {
      const receipt = handoffOptions(store, sourceChatId).receipts.find((r) => r.id === id)
      if (!receipt) throw new Error('No handoff with this ID belongs to this specialist chat.')
      return deliver(receipt)
    },
    'handoff:send': async (req: HandoffRequest) => {
      const chief = chiefForHandoff(store),
        dm = s.runtime.openDm(chief.id)
      return deliver(prepareHandoff(store, req, dm.id, s))
    }
  }
}
