import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DBManager } from '../src/db-manager.js';

function fakeDb() {
  const db = { calls: [], result: { changes: 1 }, firstValue: null, allValue: { results: [] } };
  db.prepare = vi.fn((sql) => {
    const statement = {
      bind: vi.fn((...args) => { db.calls.push({ sql, args }); return statement; }),
      run: vi.fn(async () => db.result),
      first: vi.fn(async () => db.firstValue),
      all: vi.fn(async () => db.allValue)
    };
    return statement;
  });
  return db;
}

describe('DBManager', () => {
  let db, manager;
  beforeEach(() => { db = fakeDb(); manager = new DBManager(db); });

  it('creates all schema tables', async () => {
    await manager.ensureSchema();
    expect(db.prepare).toHaveBeenCalledTimes(7);
    expect(db.calls).toHaveLength(0);
  });
  it('adds subscriptions and handles duplicate/errors', async () => {
    expect(await manager.addSubscription('u', 'r', 's')).toBe(true);
    expect(db.calls[0]).toMatchObject({
      sql: 'INSERT INTO subscriptions (user_id, rss_url, site_name) VALUES (?, ?, ?)',
      args: ['u', 'r', 's']
    });
    db.prepare.mockImplementationOnce(() => { throw new Error('UNIQUE constraint failed'); });
    expect(await manager.addSubscription('u', 'r', 's')).toBe(false);
    db.prepare.mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(manager.addSubscription('u', 'r', 's')).rejects.toThrow('boom');
  });
  it('upserts and manages push targets', async () => {
    db.firstValue = { id: 3, status: 'paused' };
    expect(await manager.upsertPushTarget({ ownerUserId: 'u', chatId: 'c', chatType: 'group', title: '', username: '' })).toEqual({ id: 3, status: 'paused' });
    db.firstValue = null; db.result = { lastRowId: 9 };
    expect(await manager.upsertPushTarget({ ownerUserId: 'u', chatId: 'c', chatType: 'group' })).toEqual({ id: 9, status: 'active' });
    db.allValue = { results: [{ chat_id: 'c' }] };
    expect(await manager.listPushTargets('u')).toEqual([{ chat_id: 'c' }]);
    db.allValue = {}; expect(await manager.listBindings('u')).toEqual([]);
    expect(await manager.listBindingsForSubscription('u', 'r')).toEqual([]);
    db.result = { changes: 1 }; expect(await manager.setPushTargetStatus('u', 'c', 'active')).toBe(true);
    db.result = { changes: 0 }; expect(await manager.deletePushTarget('u', 'c')).toBe(false);
  });
  it('binds and unbinds subscriptions', async () => {
    expect(await manager.bindSubscriptionTargets('u', 'r', ['a', 'b'])).toBe(2);
    db.prepare.mockImplementationOnce(() => { throw new Error('UNIQUE constraint failed'); });
    expect(await manager.bindSubscriptionTargets('u', 'r', ['a'])).toBe(0);
    db.prepare.mockImplementationOnce(() => { throw new Error('other'); });
    await expect(manager.bindSubscriptionTargets('u', 'r', ['a'])).rejects.toThrow('other');
    db.result = { changes: 0 }; expect(await manager.unbindSubscription('u', 'r')).toBe(0);
  });
  it('handles push records and failure records', async () => {
    db.firstValue = { id: 1 }; expect(await manager.hasPushedToChat('r', 'g', 'c')).toBe(true);
    expect(await manager.savePushRecord('r', 'g', 'c')).toBe(true);
    db.prepare.mockImplementationOnce(() => { throw new Error('UNIQUE constraint failed'); });
    expect(await manager.savePushRecord('r', 'g', 'c')).toBe(false);
    db.firstValue = { failure_count: 2 }; await manager.recordFailure('r', 'err');
    db.firstValue = null; await manager.recordFailure('r', 'err');
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); await manager.recordFailure('r', 'err');
    db.allValue = { results: [{ rss_url: 'r' }] }; expect(await manager.getFailedSubscriptions()).toEqual([{ rss_url: 'r' }]);
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); expect(await manager.getFailedSubscriptions()).toEqual([]);
    await manager.clearFailureRecord('r');
  });
  it('queries subscriptions and RSS items', async () => {
    db.firstValue = { id: 1 }; expect(await manager.checkSubscriptionExists('u', 'r')).toBe(true);
    db.allValue = { results: [{ rss_url: 'r' }] };
    expect(await manager.getUserSubscriptions('u')).toHaveLength(1);
    expect(await manager.getAllSubscriptions()).toHaveLength(1);
    expect(await manager.getSubscribersByRssUrl('r')).toHaveLength(1);
    expect(await manager.checkItemExists('r', 'g')).toBe(true);
    await manager.saveRSSItem('r', { guid: 'g', title: 't' });
    db.prepare.mockImplementationOnce(() => { throw new Error('UNIQUE constraint failed'); }); await manager.saveRSSItem('r', { guid: 'g', title: 't' });
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); await expect(manager.saveRSSItem('r', { guid: 'g', title: 't' })).rejects.toThrow('bad');
  });
  it('cleans up, aggregates stats, and manages push modes', async () => {
    db.result = { changes: 4 }; expect(await manager.cleanupOldItems(7)).toBe(4);
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); expect(await manager.cleanupOldItems()).toBe(0);
    db.firstValue = { count: 2 }; expect(await manager.getStats()).toEqual({ subscriptions: 2, items: 2, users: 2 });
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); expect(await manager.getStats()).toEqual({ subscriptions: 0, items: 0, users: 0 });
    db.firstValue = { push_mode: 'private' }; expect(await manager.getUserPushMode('u')).toBe('private');
    db.firstValue = null; expect(await manager.getUserPushMode('u')).toBe('smart');
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); expect(await manager.getUserPushMode('u')).toBe('smart');
    expect(await manager.setUserPushMode('u', 'both')).toBe(true);
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); expect(await manager.setUserPushMode('u', 'both')).toBe(false);
    db.allValue = { results: [{ push_mode: 'smart', count: 1 }] }; expect(await manager.getPushModeStats()).toEqual([{ push_mode: 'smart', count: 1 }]);
    db.prepare.mockImplementationOnce(() => { throw new Error('bad'); }); expect(await manager.getPushModeStats()).toEqual([]);
  });
});
