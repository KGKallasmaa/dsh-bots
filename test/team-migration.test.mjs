import assert from 'node:assert/strict';
import test from 'node:test';
import { planTeamMigration } from '../lib/team-migration.mjs';
import { TEAMS } from '../lib/teams.mjs';
import { TEAMS_0_11 } from '../lib/teams-0.11.mjs';

const was = (team, handle) => TEAMS_0_11[team][handle];
const now = (team, handle) => TEAMS.find((t) => t.id === team).bots.find((b) => b.handle === handle);
const desk = (team, title) => TEAMS.find((t) => t.id === team).desk.find((t) => t.title.en === title);
const deskText = (lang) => ({ persona: `desk persona ${lang}`, bio: `desk bio ${lang}` });
const bot = (id, team, handle, lang, extra = {}) => ({ id, team, handle, persona: was(team, handle).persona[lang], bio: was(team, handle).bio[lang], skills: [], apps: [], ...extra });
const entry = (id, botId, team, handle, i, lang, extra = {}) => ({ id, botId, title: was(team, handle).tasks[i].title[lang], prompt: was(team, handle).tasks[i].prompt[lang], timing: { kind: 'daily', daily: { time: '09:00:00', time_zone: 'UTC' } }, ...extra });

test('a lead that is the dispatcher becomes the front desk: its text, its lead skills, its routine', () => {
  const plan = planTeamMigration({
    bots: [bot('a', 'opc', 'atlas', 'zh', { name: 'Atlas 幕僚长', skills: [{ name: 'deep-research', source: 'dsh' }, { name: 'morning', source: 'dsh' }, { name: 'mine', source: 'own' }] })],
    entries: [entry('s1', 'a', 'opc', 'atlas', 0, 'zh'), entry('s2', 'a', 'opc', 'atlas', 1, 'zh')],
    deskId: 'a',
    deskText,
  });
  // Its own skill stays; the name is the person's to keep.
  assert.deepEqual(plan.bots, [{ id: 'a', patch: { persona: 'desk persona zh', bio: 'desk bio zh', skills: [{ name: 'mine', source: 'own' }] } }]);
  assert.deepEqual(plan.edits, [
    { id: 's1', prompt: desk('opc', 'Morning brief').prompt.zh },
    { id: 's2', prompt: desk('opc', 'Weekly review').prompt.zh },
  ]);
  assert.deepEqual([plan.moves, plan.drops], [[], []]);
});

test('a lead app on the dispatcher is turned off, its keys kept', () => {
  const github = { id: 'g', template: 'github', enabled: true, values: { token: 'x' } };
  const plan = planTeamMigration({ bots: [bot('l', 'dev', 'lead', 'en', { apps: [github], skills: [{ name: 'minimalist-coding', source: 'dsh' }] })], entries: [], deskId: 'l', deskText });
  assert.deepEqual(plan.bots[0].patch, { persona: 'desk persona en', bio: 'desk bio en', skills: [], apps: [{ ...github, enabled: false }] });
});

test('members read as the current template; edited text, a lead that is not the dispatcher, and your own bots stay', () => {
  const plan = planTeamMigration({
    bots: [
      bot('d', 'opc', 'atlas', 'en', { handle: 'atlas', team: undefined, persona: 'Calm.' }), // the dispatcher, no team
      bot('f', 'opc', 'forge', 'en'),
      bot('e', 'opc', 'echo', 'zh', { persona: '我改过的人设' }),
      bot('b', 'dev', 'builder', 'zh'),
      bot('l', 'dev', 'lead', 'en'), // a lead that is not the dispatcher: the panel offers to remove it
      { id: 'x', handle: 'forge', persona: was('opc', 'forge').persona.en, bio: '', skills: [], apps: [] }, // no team: not hired
    ],
    entries: [],
    deskId: 'd',
    deskText,
  });
  assert.deepEqual(plan.bots, [
    { id: 'f', patch: { persona: now('opc', 'forge').persona.en } },
    { id: 'e', patch: { bio: now('opc', 'echo').bio.zh } },
    { id: 'b', patch: { persona: now('dev', 'builder').persona.zh, bio: now('dev', 'builder').bio.zh } },
  ]);
});

test('a member\'s routine moves to the dispatcher with its timing, unless the dispatcher has it; edited tasks stay', () => {
  const weekly = { kind: 'weekly', weekly: { time: '07:45:00', time_zone: 'Asia/Shanghai', weekdays: [1, 3] } };
  const plan = planTeamMigration({
    bots: [bot('d', 'opc', 'atlas', 'en'), bot('e', 'opc', 'echo', 'en'), bot('h', 'opc', 'harbor', 'zh'), bot('g', 'opc', 'ledger', 'en'), bot('ed', 'content', 'editor', 'en')],
    entries: [
      entry('m', 'e', 'opc', 'echo', 0, 'en', { timing: weekly }),
      entry('i', 'h', 'opc', 'harbor', 0, 'zh'),
      { id: 'have', botId: 'd', title: '收件箱巡检', prompt: 'mine', timing: {} },
      entry('n', 'g', 'opc', 'ledger', 0, 'en', { prompt: 'Weekly numbers, my way.' }),
      entry('p', 'ed', 'content', 'editor', 0, 'en'), // from a lead that is not the dispatcher: the routine survives removing it
    ],
    deskId: 'd',
    deskText,
  });
  assert.deepEqual(plan.moves, [
    { id: 'm', title: 'Market pulse', prompt: desk('opc', 'Market pulse').prompt.en, timing: weekly },
    { id: 'p', title: 'Plan this week', prompt: TEAMS.find((t) => t.id === 'content').desk[0].prompt.en, timing: entry('p', 'ed', 'content', 'editor', 0, 'en').timing },
  ]);
  assert.deepEqual(plan.drops, ['i']);
  assert.deepEqual(plan.edits, [], 'the edited task and the dispatcher\'s own are left alone');
});

test('what was brought over is not brought again', () => {
  const bots = [bot('d', 'opc', 'atlas', 'en'), bot('f', 'opc', 'forge', 'en')];
  const entries = [entry('s', 'd', 'opc', 'atlas', 0, 'en')];
  const first = planTeamMigration({ bots, entries, deskId: 'd', deskText });
  const after = bots.map((b) => ({ ...b, ...first.bots.find((x) => x.id === b.id)?.patch }));
  const moved = entries.map((e) => ({ ...e, prompt: first.edits.find((x) => x.id === e.id)?.prompt ?? e.prompt }));
  assert.deepEqual(planTeamMigration({ bots: after, entries: moved, deskId: 'd', deskText }), { bots: [], edits: [], moves: [], drops: [] });
});
