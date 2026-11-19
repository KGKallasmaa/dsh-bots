import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CARD_REF_RE, cleanDir, cleanKey, createProjects, PROJECT_ID_RE, suggestKey } from '../lib/projects.mjs';

const dirOf = () => mkdtempSync(join(tmpdir(), 'bots-projects-'));

test('a key is cleaned to capitals and digits, and suggested from a name', () => {
  assert.equal(cleanKey(' web-2 '), 'WEB2');
  assert.equal(cleanKey('2fast'), 'FAST', 'a key starts with a letter');
  assert.equal(cleanKey('abcdefgh'), 'ABCDEF');
  assert.equal(suggestKey('One-person company'), 'OPC');
  assert.equal(suggestKey('Website'), 'WEB');
  assert.equal(suggestKey('内容工作室'), 'NRGZS');
  assert.equal(suggestKey('One-person company', ['OPC']), 'OPC2');
  assert.equal(suggestKey('X'), 'XPR');
  assert.equal(suggestKey('!!'), 'PRJ');
  assert.match('OPC-12', CARD_REF_RE);
  assert.doesNotMatch('OPC-0', CARD_REF_RE);
  assert.doesNotMatch('opc-12', CARD_REF_RE);
});

test('a folder is a full path to a folder that exists; ~ is the home folder', () => {
  const home = dirOf();
  mkdirSync(join(home, 'code', 'app'), { recursive: true });
  writeFileSync(join(home, 'note.txt'), 'x');
  assert.equal(cleanDir('~/code/app/', home), join(home, 'code', 'app'));
  assert.equal(cleanDir('', home), '');
  assert.throws(() => cleanDir('code/app', home), /must be a full path/);
  assert.throws(() => cleanDir('~/nope', home), /there is no folder/);
  assert.throws(() => cleanDir('~/note.txt', home), /is a file, not a folder/);
  assert.throws(() => cleanDir('/', home), /cannot be the whole disk/);
});

test('projects are created with a suggested key, numbered cards, checked fields, and persist', () => {
  const dir = dirOf();
  const home = dirOf();
  let now = 1000;
  const projects = createProjects(dir, { now: () => now, home });
  const p = projects.create({ name: '  One-person   company ', brief: 'Ship weekly.', dir: home });
  assert.match(p.id, PROJECT_ID_RE);
  assert.deepEqual([p.key, p.name, p.brief, p.dir, p.last], ['OPC', 'One-person company', 'Ship weekly.', home, 0]);
  assert.throws(() => projects.create({ name: 'Other', key: 'opc' }), /the key OPC is taken/);
  assert.throws(() => projects.create({ name: 'Other', key: '1' }), /a project key is 2–6 capital letters/);
  assert.throws(() => projects.create({ name: '  ' }), /a project needs a name/);
  assert.throws(() => projects.create({ name: 'Other', dir: join(home, 'missing') }), /there is no folder/);
  assert.equal(projects.get('opc').id, p.id, 'found by key in any case');
  assert.equal(projects.get(p.id).key, 'OPC');
  assert.equal(projects.take(p.id), 1);
  assert.equal(projects.take('OPC'), 2);
  now = 2000;
  const web = projects.update(p.id, { key: 'web', dir: '' });
  assert.deepEqual([web.key, web.dir, web.updatedAt, web.name], ['WEB', '', 2000, 'One-person company']);
  const second = projects.create({ name: 'Research desk' });
  assert.equal(second.key, 'RD');
  assert.deepEqual(projects.list().map((x) => x.key), ['RD', 'WEB']);
  // Read back by the next process; numbers go on where they were.
  const again = createProjects(dir, { home });
  assert.equal(again.get('WEB').last, 2);
  assert.equal(again.take('WEB'), 3);
  assert.equal(statSync(join(dir, 'projects.json')).mode & 0o777, 0o600);
  assert.equal(again.remove('RD').id, second.id);
  assert.equal(again.get('RD'), undefined);
});

test('a projects file that is not JSON is set aside, and the next write starts afresh', () => {
  const dir = dirOf();
  writeFileSync(join(dir, 'projects.json'), '{oops');
  const projects = createProjects(dir);
  assert.deepEqual(projects.list(), []);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('projects.json.corrupt-')));
  projects.create({ name: 'Fresh' });
  assert.equal(createProjects(dir).list().length, 1);
});
