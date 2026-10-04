import { describe, expect, it } from 'vitest';
import { createAuthorizationService, type AdminRoleLookup } from '../../src/admin/authorization';
import type { AdminRole } from '../../src/admin/roles';

/** Authorization unit tests with a stubbed D1 role lookup (integration
 * coverage over the real `admins` table lives in telegram-admin-flow). */

function stubLookup(activeRoles: Partial<Record<number, AdminRole | 'disabled'>>): AdminRoleLookup {
  return {
    async findActiveRole(telegramUserId: number) {
      const value = activeRoles[telegramUserId];
      if (value === undefined || value === 'disabled') {
        return null;
      }
      return value;
    },
  };
}

describe('createAuthorizationService', () => {
  it('resolves the owner through the bootstrap identity', async () => {
    const service = createAuthorizationService({
      ownerTelegramId: 1000000001,
      lookup: stubLookup({}),
    });
    await expect(service.resolveActor(1000000001)).resolves.toEqual({
      kind: 'authorized',
      role: 'owner',
    });
  });

  it('resolves an active admin from the D1 lookup', async () => {
    const service = createAuthorizationService({
      ownerTelegramId: 1000000001,
      lookup: stubLookup({ 2000000002: 'editor' }),
    });
    await expect(service.resolveActor(2000000002)).resolves.toEqual({
      kind: 'authorized',
      role: 'editor',
    });
  });

  it('leaves disabled admins unauthorized', async () => {
    const service = createAuthorizationService({
      ownerTelegramId: 1000000001,
      lookup: stubLookup({ 2000000003: 'disabled' }),
    });
    await expect(service.resolveActor(2000000003)).resolves.toEqual({ kind: 'unauthorized' });
  });

  it('leaves unknown users unauthorized', async () => {
    const service = createAuthorizationService({
      ownerTelegramId: 1000000001,
      lookup: stubLookup({}),
    });
    await expect(service.resolveActor(2999999999)).resolves.toEqual({ kind: 'unauthorized' });
  });

  it('fails closed for a missing sender identity', async () => {
    const service = createAuthorizationService({
      ownerTelegramId: 1000000001,
      lookup: stubLookup({}),
    });
    await expect(service.resolveActor(undefined)).resolves.toEqual({ kind: 'unauthorized' });
  });

  it('never resolves the owner when the bootstrap identity is unconfigured', async () => {
    const service = createAuthorizationService({
      ownerTelegramId: undefined,
      lookup: stubLookup({}),
    });
    await expect(service.resolveActor(1000000001)).resolves.toEqual({ kind: 'unauthorized' });
  });

  it('authorizes a D1-stored owner row through the lookup as its role', async () => {
    const service = createAuthorizationService({
      ownerTelegramId: 1000000001,
      lookup: stubLookup({ 3000000004: 'owner' }),
    });
    await expect(service.resolveActor(3000000004)).resolves.toEqual({
      kind: 'authorized',
      role: 'owner',
    });
  });
});
