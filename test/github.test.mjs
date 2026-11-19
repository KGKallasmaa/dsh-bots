import assert from 'node:assert/strict';
import test from 'node:test';

import { MARKER, TOKEN_REJECTED, VOUCHED, createConnector, kind, reposOf } from '../lib/channels/github.mjs';

const T0 = Date.parse('2026-11-19T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const res = (status, body, headers = {}) => ({ status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });

/** A GitHub REST stand-in: answers by path; records every call. `issues` and `comments` per repo. */
function fakeGitHub({ user = { id: 9, login: 'acme-bots', name: 'Acme bots' }, repos = ['acme/site'], collaborators = ['kada'], token = 'ghp_good' } = {}) {
  const calls = [];
  const state = { issues: {}, comments: {}, events: {}, posted: [], etags: 0 };
  const api = {
    calls,
    state,
    fetchImpl: async (url, init) => {
      const u = new URL(url);
      const path = u.pathname.replace(/^\//, '');
      const call = { method: init.method, path, query: Object.fromEntries(u.searchParams), headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
      calls.push(call);
      if (init.headers.authorization !== `Bearer ${token}`) return res(401, { message: 'Bad credentials' });
      if (path === 'user') return res(200, user);
      let m = /^repos\/([^/]+\/[^/]+)$/.exec(path);
      if (m) return repos.includes(m[1]) ? res(200, { full_name: m[1] }) : res(404, { message: 'Not Found' });
      m = /^repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)$/.exec(path);
      if (m) return collaborators.includes(m[2]) ? res(204, null) : res(404, { message: 'Not a collaborator' });
      m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events$/.exec(path);
      if (m) return res(200, state.events[`${m[1]}#${m[2]}`] ?? []);
      m = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
      if (m && init.method === 'POST') {
        state.posted.push({ repo: m[1], number: Number(m[2]), body: call.body.body });
        return res(201, { id: 5000 + state.posted.length });
      }
      m = /^repos\/([^/]+\/[^/]+)\/issues\/comments$/.exec(path);
      if (m) {
        const since = Date.parse(call.query.since);
        const list = (state.comments[m[1]] ?? []).filter((c) => Date.parse(c.updated_at) >= since);
        const etag = `"c${list.map((c) => c.id).join('-')}"`;
        if (init.headers['if-none-match'] === etag) return res(304, null);
        return res(200, list, { etag });
      }
      m = /^repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
      if (m) {
        const since = Date.parse(call.query.since);
        const list = (state.issues[m[1]] ?? []).filter((i) => Date.parse(i.updated_at) >= since && i.labels.some((l) => l.name === call.query.labels));
        const etag = `"i${list.map((i) => `${i.number}@${i.updated_at}`).join('-')}"`;
        if (init.headers['if-none-match'] === etag) return res(304, null);
        return res(200, list, { etag });
      }
      return res(404, { message: 'Not Found' });
    },
  };
  return api;
}
const issue = (number, over = {}) => ({ id: 1000 + number, number, title: `Issue ${number}`, body: `Body of ${number}`, html_url: `https://github.com/acme/site/issues/${number}`, user: { login: 'kada' }, author_association: 'OWNER', labels: [{ name: 'bots' }], updated_at: iso(T0 + 60_000), ...over });
const comment = (id, number, over = {}) => ({ id, body: `Comment ${id}`, user: { login: 'kada' }, author_association: 'OWNER', issue_url: `https://api.github.com/repos/acme/site/issues/${number}`, created_at: iso(T0 + 120_000), updated_at: iso(T0 + 120_000), ...over });

function connector(api, { now: start = T0, memoStart = {}, ...extra } = {}) {
  const seen = { messages: [], statuses: [], memo: memoStart };
  let clock = start;
  const c = createConnector({
    token: 'ghp_good',
    values: { repos: 'acme/site', label: 'bots' },
    fetchImpl: api.fetchImpl,
    apiBase: 'https://api.github.test/',
    onMessage: (m) => seen.messages.push(m),
    onStatus: (s) => seen.statuses.push(s),
    log: () => {},
    memo: { read: () => JSON.parse(JSON.stringify(seen.memo)), write: (m) => (seen.memo = JSON.parse(JSON.stringify(m))) },
    now: () => clock,
    loop: false,
    ...extra,
  });
  return { c, seen, tick: (ms) => (clock += ms) };
}

test('module contract: kind, vouching, the marker; repositories from text', () => {
  assert.equal(kind, 'github');
  assert.equal(VOUCHED, true);
  assert.equal(MARKER, '<!-- dsh-bots -->');
  assert.deepEqual(reposOf(' acme/site, https://github.com/acme/api.git\nnot a repo, acme/site '), ['acme/site', 'acme/api']);
});

test('start checks the token and every repository, and looks from now on', async () => {
  const api = fakeGitHub();
  const { c, seen } = connector(api);
  assert.deepEqual(await c.start(), { id: '9', username: 'acme-bots', name: 'Acme bots' });
  assert.deepEqual(seen.memo.repos['acme/site'], { since: iso(T0), comments: iso(T0), lastComment: 0, issues: [] });
  const bad = connector(fakeGitHub({ token: 'other' }));
  await assert.rejects(bad.c.start(), (e) => e.message === TOKEN_REJECTED && e.fatal === true);
  const hidden = connector(fakeGitHub({ repos: [] }));
  await assert.rejects(hidden.c.start(), /this token cannot see acme\/site/);
  const none = connector(api, { values: { repos: 'nope' } });
  await assert.rejects(none.c.start(), /name the repositories to watch/);
});

test('a labelled issue arrives once, trusted by its author or by who labelled it; others arrive untrusted', async () => {
  const api = fakeGitHub();
  const { c, seen } = connector(api);
  await c.start();
  api.state.issues['acme/site'] = [
    issue(12),
    // A stranger's issue a collaborator labelled.
    issue(13, { user: { login: 'stranger' }, author_association: 'NONE' }),
    // A stranger's issue an issue form labelled.
    issue(14, { user: { login: 'drive-by' }, author_association: 'NONE' }),
    // Pull requests are left out.
    issue(15, { pull_request: {} }),
  ];
  api.state.events['acme/site#13'] = [{ event: 'labeled', label: { name: 'bots' }, actor: { login: 'kada' } }];
  api.state.events['acme/site#14'] = [{ event: 'labeled', label: { name: 'bots' }, actor: { login: 'drive-by' } }];
  await c.pollNow();
  assert.deepEqual(
    seen.messages.map((m) => [m.threadId, m.userId, m.trusted, m.messageId]),
    [
      ['12', 'kada', true, 'i1012'],
      ['13', 'kada', true, 'i1013'],
      ['14', 'drive-by', false, 'i1014'],
    ],
  );
  assert.deepEqual(seen.messages[0].issue, { repo: 'acme/site', number: 12, title: 'Issue 12', body: 'Body of 12', url: 'https://github.com/acme/site/issues/12', author: 'kada' });
  assert.equal(seen.messages[0].text, '#12 Issue 12\n\nBody of 12');
  assert.equal(seen.messages[1].issue.labeledBy, 'kada');
  // A long issue reaches the bot cut, with its address; the card keeps the whole body.
  api.state.issues['acme/site'].push(issue(16, { body: 'x'.repeat(9000), updated_at: iso(T0 + 90_000) }));
  await c.pollNow();
  const long = seen.messages.at(-1);
  assert.equal(long.issue.body.length, 9000);
  assert.match(long.text, /\n\n\[… cut here; the whole of it: https:\/\/github\.com\/acme\/site\/issues\/16\]$/);
  assert.ok(long.text.length < 8100);
  seen.messages.pop();
  // The next polls: nothing new (the same issues); once the cursor rests, an unchanged answer is a 304 on its ETag.
  await c.pollNow();
  await c.pollNow();
  assert.equal(seen.messages.length, 3);
  assert.ok(api.calls.some((x) => x.path === 'repos/acme/site/issues' && x.headers['if-none-match']));
  assert.deepEqual(seen.memo.repos['acme/site'].issues, [12, 13, 14, 16]);
  assert.equal(seen.memo.repos['acme/site'].since, iso(T0 + 90_000));
});

test('comments on issues that arrived come through, never the bot\'s own; edited old ones do not come again', async () => {
  const api = fakeGitHub();
  const { c, seen } = connector(api);
  await c.start();
  api.state.issues['acme/site'] = [issue(12)];
  await c.pollNow();
  api.state.comments['acme/site'] = [
    comment(201, 12),
    comment(202, 12, { user: { login: 'acme-bots' } }),
    comment(203, 12, { user: { login: 'someone' }, body: `Done.\n\n${MARKER}` }),
    comment(204, 99),
    comment(205, 12, { user: { login: 'passer' }, author_association: 'NONE' }),
  ];
  await c.pollNow();
  assert.deepEqual(
    seen.messages.slice(1).map((m) => [m.messageId, m.userId, m.trusted, m.threadId, m.text]),
    [
      ['c201', 'kada', true, '12', 'Comment 201'],
      ['c205', 'passer', false, '12', 'Comment 205'],
    ],
  );
  // Comment 201 edited later: same id, not a new message.
  api.state.comments['acme/site'] = [comment(201, 12, { updated_at: iso(T0 + 300_000), body: 'Edited' })];
  await c.pollNow();
  assert.equal(seen.messages.length, 3);
  assert.equal(seen.memo.repos['acme/site'].lastComment, 205);
});

test('the cursors survive a restart: what was seen is not passed on again', async () => {
  const api = fakeGitHub();
  const first = connector(api);
  await first.c.start();
  api.state.issues['acme/site'] = [issue(12)];
  await first.c.pollNow();
  await first.c.stop();
  const second = connector(api, { memoStart: first.seen.memo, now: T0 + 3_600_000 });
  await second.c.start();
  await second.c.pollNow();
  assert.equal(second.seen.messages.length, 0);
  // While it was off, a new labelled issue came: it is caught up.
  api.state.issues['acme/site'].push(issue(13, { updated_at: iso(T0 + 1_800_000) }));
  await second.c.pollNow();
  assert.deepEqual(second.seen.messages.map((m) => m.threadId), ['13']);
});

test('send posts a comment on the issue with the marker; without an issue it refuses', async () => {
  const api = fakeGitHub();
  const { c } = connector(api);
  await c.start();
  assert.deepEqual(await c.send('acme/site', 'Fixed in #14.', { threadId: '12' }), { ids: ['5001'] });
  assert.deepEqual(api.state.posted, [{ repo: 'acme/site', number: 12, body: `Fixed in #14.\n\n${MARKER}` }]);
  await assert.rejects(c.send('acme/site', 'hello'), /a GitHub reply goes to an issue/);
});
