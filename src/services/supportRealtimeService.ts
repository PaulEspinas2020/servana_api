import { emitToProvider } from '../provider.realtime';

export const emitSupportCaseUpdated = (providerUid: string, caseId: string, reason: string): void => {
  emitToProvider(providerUid, 'support:case-updated', {
    caseId,
    reason,
    occurredAt: new Date().toISOString(),
  });
};
