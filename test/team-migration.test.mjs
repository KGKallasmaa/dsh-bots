import assert from 'node:assert/strict';
import test from 'node:test';
import { planTeamMigration } from '../lib/team-migration.mjs';
import { TEAMS } from '../lib/teams.mjs';
import { TEAMS_0_11 } from '../lib/teams-0.11.mjs';

const was = (team, handle) => TEAMS_0_11[team][handle];
const now = (team, handle) => TEAMS.find((t) => t.id === team).bots.find((b) => b.handle === handle);
// The dispatcher's routine, or one the one-person company's lead took over in 0.16 (the dispatcher's until it joins).
const desk = (team, title) => {
  const t = TEAMS.find((x) => x.id === team);
  return [...(t.desk ?? []), ...(t.bots.find((b) => b.key === t.lead)?.tasks ?? [])].find((x) => x.title.en === title);
};
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

// --- Bots 0.15: teams hired with 0.11.1–0.14 get the lead their template names ------------------

import { planLeadMigration } from '../lib/team-migration.mjs';
import { TEAMS_0_14 } from '../lib/teams-0.14.mjs';

const team = (id) => TEAMS.find((t) => t.id === id);
const hired = (id, teamId, handle, lang, extra = {}) => {
  const b = team(teamId).bots.find((x) => x.handle === handle);
  const old = TEAMS_0_14[teamId]?.bots?.[handle];
  return { id, team: teamId, handle, role: 'bot', persona: (old ?? b).persona[lang], bio: (old ?? b).bio[lang], ...extra };
};

test('0.15: a team hired without a lead gets the one its template names, and the texts 0.15 changed, once', () => {
  const bots = [
    { id: 'a', handle: 'atlas', role: 'primary' },
    hired('b', 'dev', 'builder', 'zh'),
    hired('t', 'dev', 'tester', 'zh'),
    hired('f', 'opc', 'forge', 'en'),
    hired('q', 'content', 'quill', 'en', { persona: 'My own words.' }),
  ];
  const plan0 = TEAMS_0_14.content.desk[0];
  const entries = [
    { id: 's1', botId: 'a', title: plan0.title.en, prompt: plan0.prompt.en },
    { id: 's2', botId: 'a', title: plan0.title.zh, prompt: 'Edited by the person.' },
  ];
  const plan = planLeadMigration({ bots, entries, deskId: 'a', giveLeads: true });
  const builder = team('dev').bots.find((x) => x.handle === 'builder');
  // Builder leads the squad and reads as 0.15; Quill leads the studio, its edited persona kept; the company has no lead.
  assert.deepEqual(plan.bots, [
    { id: 'b', patch: { lead: true, persona: builder.persona.zh, bio: builder.bio.zh } },
    { id: 'q', patch: { lead: true } },
  ]);
  assert.deepEqual(plan.edits, [{ id: 's1', prompt: team('content').desk[0].prompt.en }]);
  // Once given, a lead taken away stays away; texts already brought over change nothing.
  const after = bots.map((b) => (b.id === 'b' ? { ...b, persona: builder.persona.zh, bio: builder.bio.zh } : b));
  assert.deepEqual(planLeadMigration({ bots: after, entries: [], deskId: 'a', giveLeads: false }), { bots: [], edits: [] });
  // A team that has a lead already keeps it, whoever it is.
  assert.deepEqual(planLeadMigration({ bots: [hired('b', 'dev', 'builder', 'en', { persona: builder.persona.en, bio: builder.bio.en }), hired('t', 'dev', 'tester', 'en', { lead: true })], entries: [], deskId: null, giveLeads: true }), { bots: [], edits: [] });
});

// --- Bots 0.16: names, and the routines a new lead takes over -----------------------------------

import { deskTasksOfLead } from '../lib/team-migration.mjs';

test('0.16: Quill and Memo take their new names where they still read as hired', () => {
  const bots = [
    { id: 'q', team: 'content', handle: 'quill', role: 'bot', name: 'Quill 写手', lead: true },
    { id: 'm', team: 'research', handle: 'memo', role: 'bot', name: 'Memo', lead: true },
    { id: 'm2', team: 'research', handle: 'memo2', role: 'bot', name: 'Memo 撰稿人' },
    { id: 'x', team: 'research', handle: 'memo', role: 'bot', name: '我的 Memo' },
  ];
  const plan = planLeadMigration({ bots, entries: [], deskId: null, giveLeads: false });
  assert.deepEqual(plan.bots, [{ id: 'q', patch: { name: 'Quill 主编' } }]);
  const renamed = bots.map((b) => (b.id === 'q' ? { ...b, name: 'Quill 主编' } : b));
  assert.deepEqual(planLeadMigration({ bots: renamed, entries: [], deskId: null, giveLeads: false }).bots, []);
  assert.equal(team('research').bots[0].name.zh, 'Memo 主笔');
});

test('0.16: the dispatcher\'s routines the company\'s lead runs now, still as hired, in either language', () => {
  const tasks = team('opc').bots.find((b) => b.key === team('opc').lead).tasks;
  const entries = [
    { id: 'a', title: tasks[0].title.zh, prompt: tasks[0].prompt.zh },
    { id: 'b', title: tasks[1].title.en, prompt: tasks[1].prompt.en },
    { id: 'c', title: tasks[2].title.en, prompt: 'Market pulse, my way.' },
    { id: 'd', title: team('opc').desk[0].title.en, prompt: team('opc').desk[0].prompt.en },
  ];
  assert.deepEqual(deskTasksOfLead('opc', entries), ['a', 'b']);
  assert.deepEqual(deskTasksOfLead('dev', entries), []);
});

test('0.16: a 0.11.0 member routine the company\'s lead runs now still goes to the dispatcher first', () => {
  const plan = planTeamMigration({ bots: [bot('d', 'opc', 'atlas', 'en'), bot('h', 'opc', 'harbor', 'en')], entries: [entry('i', 'h', 'opc', 'harbor', 0, 'en')], deskId: 'd', deskText });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.title]), [['i', 'Inbox sweep']]);
});
