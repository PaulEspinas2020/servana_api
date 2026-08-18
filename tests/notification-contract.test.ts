import fs from 'fs';
import path from 'path';

import {
  isSafeNotificationKey,
  sanitizeNotificationRoute,
} from '../src/services/notification.service';

describe('notification ownership and safe payload contract', () => {
  it('accepts deterministic safe keys and rejects path/control injection', () => {
    expect(isSafeNotificationKey('support-message:case_1:v2')).toBe(true);
    expect(isSafeNotificationKey('../other-provider')).toBe(false);
    expect(isSafeNotificationKey('bad key')).toBe(false);
    expect(isSafeNotificationKey(`ok\nforged`)).toBe(false);
  });

  it('allowlists route metadata and drops producer-private fields', () => {
    expect(sanitizeNotificationRoute({
      screen: 'SupportCase',
      caseId: 'case-123',
      workerUid: 'must-not-leak',
      internalNote: 'restricted',
      commandsRoute: ['/provider/support'],
      requiresAccessCheck: true,
    })).toEqual({
      screen: 'SupportCase',
      caseId: 'case-123',
      commandsRoute: ['/provider/support'],
      requiresAccessCheck: true,
    });
  });

  it('scopes idempotency conflicts by notification owner', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/notification.service.ts'), 'utf8');
    expect(source).toContain('ON CONFLICT (worker_uid, notification_key) DO NOTHING');
    expect(source).toContain('ON CONFLICT (user_uid, notification_key) DO NOTHING');
    expect(source).not.toContain('ON CONFLICT (notification_key) DO NOTHING');
  });

  it('requires a provider role before joining the provider notification room', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/provider.gateway.ts'), 'utf8');
    expect(source).toContain('if (!isProviderRole(role)) return next(new Error("Unauthorized"))');
  });

  it('keeps provider push registrations device-scoped and owner-exclusive', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/notification.service.ts'), 'utf8');
    expect(source).toContain('provider_notification_device_tokens');
    expect(source).toContain('ON CONFLICT (token) DO UPDATE SET worker_uid = EXCLUDED.worker_uid');
    expect(source).toContain('WHERE worker_uid = $1 AND token = $2');
  });
});
