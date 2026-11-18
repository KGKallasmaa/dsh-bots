import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KEEP_ASKS, NEED_ID_RE, clampNeedTitle, createNeeds, needStatus } from '../lib/needs.mjs';
import { stageOf } from '../lib/tickets.mjs';

const dirOf = () => mkdtempSync(join(tmpdir(), 'bots-needs-'));
const T0 = Date.parse('2026-11-18T09:00:00Z');
const task = (id, over = {}) => ({ id, reports: [], startedAt: T0, ...over });
const ended = (outcome, at = T0 + 60_000) => ({ ended: { at, by: 'worker', outcome } });
const report = (status, at = T0 + 1000) => ({ reports: [{ at, status, text: `${status} report` }] });

test('a need\'s status comes from its tasks: waiting for the person first, then working, then how they ended', () => {
  const need = { id: 'n12345678' };
  const s = (tasks) => needStatus(need, tasks, stageOf);
  assert.equal(s([task('t1', report('question')), task('t2')]).status, 'waiting');
  assert.deepEqual(s([task('t1', report('question')), task('t2')]).waiting, ['t1']);
  // A blocked report nobody answered: the person must unblock it.
  assert.equal(s([task('t1', report('blocked'))]).status, 'waiting');
  // Answered since: back to work.
  assert.equal(s([task('t1', { ...report('question'), lastHumanAt: T0 + 2000 })]).status, 'working');
  assert.equal(s([task('t1', { startedAt: 0 })]).status, 'working', 'queued is working to the person');
  const mixed = s([task('t1', ended('done')), task('t2', ended('failed')), task('t3')]);
  assert.deepEqual([mixed.status, mixed.done, mixed.total, mixed.failed], ['working', 1, 3, 1]);
  const settled = s([task('t1', ended('done', T0 + 5000)), task('t2', ended('failed', T0 + 9000))]);
  assert.deepEqual([settled.status, settled.endedAt], ['done', T0 + 9000], 'one result in is done; the failure is counted');
  assert.equal(s([task('t1', ended('failed')), task('t2', ended('stopped'))]).status, 'failed');
  assert.equal(s([task('t1', ended('stopped'))]).status, 'stopped');
  assert.equal(s([task('t1', { stalledAt: T0 + 5000 })]).stalled, 1);
  // Dropped by the person, whatever its tasks say.
  assert.equal(needStatus({ ...need, closed: { at: T0, by: 'user' } }, [task('t1')], stageOf).status, 'stopped');
  // Its tasks pruned: the last status it was seen with.
  const gone = needStatus({ ...need, snapshot: { status: 'done', done: 2, total: 2 } }, [], stageOf);
  assert.deepEqual([gone.status, gone.done, gone.total], ['done', 2, 2]);
  assert.equal(needStatus(need, [], stageOf).status, 'working');
});

test('needs are created, take tasks and the person\'s words, and persist', () => {
  const dir = dirOf();
  let now = T0;
  const needs = createNeeds(dir, { now: () => now });
  const n = needs.create({ title: '  A comparison of   Q3 competitor pricing ', botId: 'b-atlas', origin: { threadKey: 'panel:s1', via: 'panel', bogus: 1 }, asks: [{ id: 'p1', at: T0, text: 'Compare Q3 pricing of our competitors' }], tickets: ['t1'] });
  assert.match(n.id, NEED_ID_RE);
  assert.equal(n.title, 'A comparison of Q3 competitor pricing');
  assert.deepEqual(n.origin, { threadKey: 'panel:s1', via: 'panel' });
  assert.equal(needs.byTicket('t1').id, n.id);
  now += 1000;
  needs.addTicket(n.id, 't2', [{ id: 'p1', at: T0, text: 'Compare Q3 pricing of our competitors' }, { id: 'p2', at: now, text: 'and Europe too' }]);
  assert.deepEqual(needs.get(n.id).tickets, ['t1', 't2']);
  assert.deepEqual(needs.get(n.id).asks.map((a) => a.id), ['p1', 'p2'], 'the same message is kept once');
  assert.equal(needs.get(n.id).updatedAt, now);
  // A file the next process reads.
  const again = createNeeds(dir);
  assert.equal(again.get(n.id).title, n.title);
  assert.equal(again.byTicket('t2').id, n.id);
  assert.equal(statSync(join(dir, 'needs.json')).mode & 0o777, 0o600);
  // Titles are one line, clipped.
  assert.equal([...clampNeedTitle('x'.repeat(200))].length, 80);
  assert.throws(() => needs.create({ title: '   ' }), /title/);
});

test('rename, merge and close; merged needs point at the one that took them', () => {
  const needs = createNeeds(dirOf(), { now: () => T0 });
  const a = needs.create({ title: 'Logo ideas', tickets: ['t1'], asks: [{ id: 'm1', at: T0, text: 'logo please' }], auto: true });
  const b = needs.create({ title: 'A new logo', tickets: ['t2'], asks: [{ id: 'm2', at: T0 - 5, text: 'we need a logo' }] });
  assert.equal(needs.rename(a.id, 'Three logo ideas').auto, undefined, 'a named need is no longer automatic');
  const merged = needs.merge(a.id, b.id);
  assert.equal(merged.id, b.id);
  assert.deepEqual(merged.tickets, ['t2', 't1']);
  assert.deepEqual(merged.asks.map((x) => x.id), ['m2', 'm1'], 'in the order they were said');
  assert.equal(needs.get(a.id).id, b.id, 'the old id finds the merged need');
  assert.equal(needs.byTicket('t1').id, b.id);
  assert.deepEqual(needs.list().map((n) => n.id), [b.id]);
  needs.close(b.id, { by: 'user' });
  assert.equal(needs.get(b.id).closed.by, 'user');
  // Work handed out for it again brings it back.
  needs.addTicket(b.id, 't3');
  assert.equal(needs.get(b.id).closed, undefined);
});

test('the person\'s words are capped, the request itself kept; snapshots write only on change; prune keeps open needs', () => {
  const dir = dirOf();
  let now = T0;
  const needs = createNeeds(dir, { now: () => now });
  const n = needs.create({ title: 'Weekly report', asks: [{ id: 'first', at: T0, text: 'the request' }] });
  for (let i = 0; i < 30; i += 1) needs.addAsks(n.id, [{ id: `m${i}`, at: T0 + i, text: `more ${i}` }]);
  const asks = needs.get(n.id).asks;
  assert.equal(asks.length, KEEP_ASKS);
  assert.equal(asks[0].id, 'first');
  assert.equal(asks.at(-1).id, 'm29');
  let writes = 0;
  needs.onChange(() => (writes += 1));
  needs.snapshot(n.id, { status: 'working', done: 0, total: 1, failed: 0, stalled: 0 });
  needs.snapshot(n.id, { status: 'working', done: 0, total: 1, failed: 0, stalled: 0 });
  assert.equal(writes, 1);
  // Prune: the oldest settled go; open ones stay.
  const old = [];
  for (let i = 0; i < 3; i += 1) {
    now += 1000;
    const x = needs.create({ title: `Done ${i}` });
    needs.snapshot(x.id, { status: 'done', done: 1, total: 1, failed: 0, stalled: 0 });
    old.push(x.id);
  }
  assert.equal(needs.prune({ keepSettled: 1 }), 2);
  assert.deepEqual(needs.list().map((x) => x.id).sort(), [n.id, old[2]].sort());
});

test('an unreadable needs file is set aside, not written over', () => {
  const dir = dirOf();
  writeFileSync(join(dir, 'needs.json'), '{nope');
  const needs = createNeeds(dir);
  assert.deepEqual(needs.list(), []);
  needs.create({ title: 'Fresh' });
  assert.ok(readdirSync(dir).some((f) => f.startsWith('needs.json.corrupt-')));
  assert.equal(JSON.parse(readFileSync(join(dir, 'needs.json'), 'utf8')).needs.length, 1);
});
