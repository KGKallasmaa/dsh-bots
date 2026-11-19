/**
 * Bringing teams hired from the 0.3–0.11.0 templates to the current ones (0.11.1), where a team has
 * no lead and its routine belongs to the dispatcher. Only what still reads exactly as it was hired
 * changes, so a persona, bio or scheduled task someone edited is left as it is; anything already
 * brought over no longer matches, so running it again does nothing. Pure: the plan, not its doing.
 *
 * @module @kadaliao/dsh-bots/lib/team-migration
 */

import { TEAMS } from './teams.mjs';
import { TEAMS_0_11 } from './teams-0.11.mjs';

const LANGS = ['en', 'zh'];

/** The language a text is in when it is exactly one of a bilingual pair's texts, else null. */
const langOf = (text, pair) => LANGS.find((l) => pair?.[l] && text === pair[l]) ?? null;

/** Where a 0.11.0 task of `teamId` is now, by its title in `lang`: `{desk: true, prompt}` or `{handle, prompt}`, or null. */
function taskNow(teamId, title, lang) {
  const team = TEAMS.find((t) => t.id === teamId);
  if (!team) return null;
  const desk = (team.desk ?? []).find((t) => t.title[lang] === title);
  if (desk) return { desk: true, prompt: desk.prompt[lang] };
  for (const b of team.bots) {
    const t = (b.tasks ?? []).find((x) => x.title[lang] === title);
    if (t) return { handle: b.handle, prompt: t.prompt[lang] };
  }
  return null;
}

/**
 * The migration plan.
 * @param {{bots: object[], entries: {id: string, botId: string|null, title: string, prompt: string, timing: object}[], deskId: string|null, deskText: (lang: 'en'|'zh') => {persona: string, bio: string}}} input
 *   `entries`: the bots' scheduled tasks; `deskText`: the front desk's persona and bio in a language.
 * @returns {{bots: {id: string, patch: object}[], edits: {id: string, prompt: string}[], moves: {id: string, title: string, prompt: string, timing: object}[], drops: string[]}}
 *   `bots`: patches to save; `edits`: new prompts for tasks that stay where they are; `moves`: tasks
 *   to delete and make again on the dispatcher; `drops`: tasks to delete, the dispatcher already has one by that title.
 */
export function planTeamMigration({ bots, entries, deskId, deskText }) {
  const plan = { bots: [], edits: [], moves: [], drops: [] };
  const deskTitles = new Set(entries.filter((e) => e.botId && e.botId === deskId).map((e) => e.title));
  for (const bot of bots) {
    const was = TEAMS_0_11[bot.team]?.[bot.handle];
    if (!was) continue;
    const isDesk = bot.id === deskId;
    const now = TEAMS.find((t) => t.id === bot.team)?.bots.find((b) => b.handle === bot.handle);
    const patch = {};
    for (const k of ['persona', 'bio']) {
      const lang = langOf(bot[k], was[k]);
      if (!lang) continue;
      // A lead that is the dispatcher reads as the front desk; a member as its current template.
      const text = was.lead ? (isDesk ? deskText(lang)[k] : null) : now?.[k]?.[lang];
      if (text && text !== bot[k]) patch[k] = text;
    }
    // A lead's work skills and apps do not fit the dispatcher (an app is turned off, its keys kept).
    if (was.lead && isDesk) {
      const skills = (bot.skills ?? []).filter((s) => !(s.source === 'dsh' && was.dshSkills.includes(s.name)));
      if (skills.length !== (bot.skills ?? []).length) patch.skills = skills;
      if ((bot.apps ?? []).some((a) => a.enabled && was.apps.includes(a.template))) patch.apps = bot.apps.map((a) => (was.apps.includes(a.template) ? { ...a, enabled: false } : a));
    }
    if (Object.keys(patch).length) plan.bots.push({ id: bot.id, patch });
    for (const e of entries.filter((x) => x.botId === bot.id)) {
      const task = was.tasks.find((t) => langOf(e.title, t.title) && langOf(e.prompt, t.prompt) === langOf(e.title, t.title));
      if (!task) continue;
      const lang = langOf(e.title, task.title);
      const where = taskNow(bot.team, e.title, lang);
      if (!where) continue;
      if (!where.desk || isDesk) {
        if (where.prompt !== e.prompt) plan.edits.push({ id: e.id, prompt: where.prompt });
      } else if (!deskId) continue;
      else if (deskTitles.has(e.title)) plan.drops.push(e.id);
      else {
        plan.moves.push({ id: e.id, title: e.title, prompt: where.prompt, timing: e.timing });
        deskTitles.add(e.title);
      }
    }
  }
  return plan;
}
