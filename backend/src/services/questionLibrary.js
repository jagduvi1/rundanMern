// QuestionLibraryService — pull random library questions into a quiz (port of
// Rundan.Server/Services/QuestionLibraryService.cs).
//
// Pulls random questions from the pre-generated library into an activity,
// filtered by tag and avoiding ones the host already used. Lets a participating
// host run a quiz they didn't author. The candidate filter (per-dimension OR,
// across-dimension AND), the random pick, and the usage-marking reproduce the
// .NET behaviour precisely.

const {
  Activity, Question, QuestionTemplate, QuestionTemplateUsage,
} = require('../models');
const { ActivityType, ActivityStatus } = require('../constants/enums');
const { RuleViolation } = require('../middleware/error');
const { idStr } = require('./serializers');

// In-place Fisher–Yates shuffle (the draw need not be reproducible — mirrors the
// C# `OrderBy(_ => Random.Shared.Next())`).
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Distinct library tags, ordered ascending — feeds the host's tag picker.
 * Mirrors `TagsAsync`. Tags are stored as a lowercase string array on each
 * template; `distinct` flattens the multikey field across the collection.
 * @returns {Promise<string[]>}
 */
async function listTags() {
  const tags = await QuestionTemplate.distinct('tags');
  return tags.filter((t) => typeof t === 'string').sort();
}

/**
 * The candidate filter (reproduce exactly — CandidatesAsync).
 *
 * Unused templates matching the selected tags, where tags are grouped by
 * DIMENSION (the part before ':'). Within a dimension a template needs ANY of the
 * chosen tags (OR); it must satisfy EVERY dimension (AND). An empty `tags` list →
 * no groups → every unused template qualifies.
 *
 * e.g. selecting topic:history, topic:music, age:family →
 *   (topic:history OR topic:music) AND age:family.
 *
 * @param {string[]} tags requested tags (raw; trimmed + lowercased here).
 * @returns {Promise<Array>} matching unused QuestionTemplate docs (lean).
 */
async function candidates(tags = []) {
  const wanted = (tags || [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t.length > 0);

  // Group the wanted tags by dimension (text before the first ':'); each group is
  // a Set of the chosen tags within that dimension.
  const groups = new Map();
  for (const t of wanted) {
    const idx = t.indexOf(':');
    const dim = idx >= 0 ? t.slice(0, idx) : t;
    if (!groups.has(dim)) groups.set(dim, new Set());
    groups.get(dim).add(t);
  }
  const groupSets = [...groups.values()];

  // Used template ids → excluded from candidates.
  const usedIds = await QuestionTemplateUsage.distinct('questionTemplateId');
  const used = new Set(usedIds.map((id) => idStr(id)));

  // Load all templates (with embedded options + tags). The dimension grouping
  // happens in app code (split on ':'), matching the C#; a DB-side $and-of-$in
  // would be an equivalent optimisation but is intentionally kept identical here.
  const all = await QuestionTemplate.find({}).lean();

  return all.filter((t) => {
    if (used.has(idStr(t._id))) return false;
    const tplTags = t.tags || [];
    // Every dimension group must be satisfied by at least one of the template's
    // tags (AND across groups, OR within a group). No groups → always true.
    return groupSets.every((group) => tplTags.some((tag) => group.has(tag)));
  });
}

/**
 * How many unused templates match the tag filter (AvailableCountAsync).
 * @param {string[]} tags
 * @returns {Promise<number>}
 */
async function availableCount(tags = []) {
  return (await candidates(tags)).length;
}

/**
 * Pull up to `count` random matching library questions into an activity
 * (GenerateIntoAsync). Each picked template is copied into a new Question on the
 * activity (appended in order, options copied) and marked used via a
 * QuestionTemplateUsage row so it isn't picked again.
 *
 * Guards (RuleViolation with the exact .NET messages/status):
 *  - 404 if the activity is missing.
 *  - "Only quiz and tipspromenad activities use questions." if type isn't
 *    Quiz/Tipspromenad.
 *  - "Set the activity back to Draft to add questions." if status != Draft.
 *  - "Ask for at least one question." if count < 1.
 *
 * @param {object} activity a loaded Activity Mongoose doc (uses _id/type/status).
 * @param {object} opts
 * @param {number} [opts.count=10] how many to add.
 * @param {string[]} [opts.tags=[]] tag filter.
 * @returns {Promise<{added:number, available:number}>} how many were added and
 *   how many matching candidates remain afterwards.
 */
async function generate(activity, { count = 10, tags = [] } = {}) {
  if (!activity) {
    throw new RuleViolation('Activity not found.', 404);
  }
  if (activity.type !== ActivityType.Quiz && activity.type !== ActivityType.Tipspromenad) {
    throw new RuleViolation('Only quiz and tipspromenad activities use questions.');
  }
  if (activity.status !== ActivityStatus.Draft) {
    throw new RuleViolation('Set the activity back to Draft to add questions.');
  }
  if (count < 1) {
    throw new RuleViolation('Ask for at least one question.');
  }

  const matching = await candidates(tags);
  const available = matching.length;

  // Random order, take N.
  const picked = shuffle(matching.slice()).slice(0, count);

  // Append after the activity's current highest question order.
  const maxQ = await Question.findOne({ activityId: activity._id })
    .sort({ order: -1 })
    .select('order')
    .lean();
  let nextOrder = (maxQ ? maxQ.order : 0) + 1;
  const now = new Date();

  for (const template of picked) {
    const options = (template.options || [])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((o) => ({ order: o.order, text: o.text, isCorrect: o.isCorrect }));

    // eslint-disable-next-line no-await-in-loop
    await Question.create({
      activityId: activity._id,
      order: nextOrder,
      text: template.text,
      kind: template.kind,
      points: template.points,
      acceptedFreeTextAnswer: template.acceptedFreeTextAnswer ?? null,
      options,
    });
    nextOrder += 1;

    // Mark the template used so it isn't picked again (loose ref, unique).
    // eslint-disable-next-line no-await-in-loop
    await QuestionTemplateUsage.create({ questionTemplateId: template._id, usedUtc: now });
  }

  return { added: picked.length, available: available - picked.length };
}

/**
 * Delete every usage row, re-enabling all library templates (ResetUsageAsync).
 * @returns {Promise<number>} how many usage rows were cleared.
 */
async function resetUsage() {
  const res = await QuestionTemplateUsage.deleteMany({});
  return res.deletedCount || 0;
}

module.exports = {
  listTags,
  availableCount,
  generate,
  resetUsage,
  // Exposed for tests / reuse.
  candidates,
};
