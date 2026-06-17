// Cascade-delete helpers — MongoDB has no referential cascade, so every EF
// `OnDelete(Cascade)` from rundan is replicated here in application code.
// Embedded subdocs (courts/mapCities/memoryCards/options/members) are deleted
// automatically with their parent. The SetNull case (ScoreEntry.userId on User
// delete) and loose bracket refs are handled explicitly.
const {
  Event, Activity, Participant, Question, Answer, ScoreEntry, BracketMatch,
  ActivityPhoto, EventMember, EventViewer, Slap, ChatMessage, PushSubscription, User, Account,
  HitsterGame, Invite, ImpostureVote,
} = require('../models');
const { deleteUploads } = require('../config/paths');

// Gather an activity's uploaded-file URLs (its image + every photo on its wall) so
// they can be unlinked from disk when the activity/event is deleted — Mongo only
// drops the DB rows, the original .NET also removed the files (StoragePaths).
async function activityUploadUrls(activityId) {
  const [activity, photos] = await Promise.all([
    Activity.findById(activityId).select('imageUrl').lean(),
    ActivityPhoto.find({ activityId }).select('url').lean(),
  ]);
  const urls = [];
  if (activity && activity.imageUrl) urls.push(activity.imageUrl);
  for (const p of photos) if (p.url) urls.push(p.url);
  return urls;
}

async function deleteQuestionCascade(questionId) {
  await Answer.deleteMany({ questionId });
  await Question.deleteOne({ _id: questionId });
}

async function deleteParticipantCascade(participantId) {
  await Answer.deleteMany({ participantId });
  await ScoreEntry.deleteMany({ participantId });
  // Imposture: drop the player's votes (as voter or votee) and remove them from any
  // live round's impostor set, so the tally doesn't count a ghost or keep a missing
  // impostor "in play".
  await ImpostureVote.deleteMany({
    $or: [{ voterParticipantId: participantId }, { votedParticipantId: participantId }],
  });
  await Activity.updateMany(
    { 'impostureRound.impostorIds': participantId },
    { $pull: { 'impostureRound.impostorIds': participantId } },
  );
  // Loose bracket refs (no FK) — null them so deleted players don't dangle.
  await BracketMatch.updateMany({ participantAId: participantId }, { $set: { participantAId: null } });
  await BracketMatch.updateMany({ participantBId: participantId }, { $set: { participantBId: null } });
  await BracketMatch.updateMany({ winnerParticipantId: participantId }, { $set: { winnerParticipantId: null } });
  await Participant.deleteOne({ _id: participantId });
}

// Delete all of an activity's child rows (but not the activity itself).
async function deleteActivityChildren(activityId) {
  const questionIds = await Question.find({ activityId }).distinct('_id');
  const participantIds = await Participant.find({ activityId }).distinct('_id');
  if (questionIds.length) await Answer.deleteMany({ questionId: { $in: questionIds } });
  if (participantIds.length) await Answer.deleteMany({ participantId: { $in: participantIds } });
  await Promise.all([
    Question.deleteMany({ activityId }),
    Participant.deleteMany({ activityId }),
    ScoreEntry.deleteMany({ activityId }),
    BracketMatch.deleteMany({ activityId }),
    ActivityPhoto.deleteMany({ activityId }),
    Slap.deleteMany({ activityId }),
    HitsterGame.deleteMany({ activityId }),
    ImpostureVote.deleteMany({ activityId }),
  ]);
}

// Unlink uploaded files, but ONLY those that NO surviving row still references.
// A library activity and its event copy share the same imageUrl string, so
// deleting one must not unlink the file the other still shows; this also blocks a
// host who points their own activity at someone else's /uploads/<file> and then
// deletes it — the victim's row still references it, so it's skipped.
async function unlinkUnreferencedUploads(urls) {
  const unique = [...new Set((urls || []).filter(Boolean))];
  const toDelete = [];
  for (const url of unique) {
    // eslint-disable-next-line no-await-in-loop
    const stillUsed = (await Activity.exists({ imageUrl: url }))
      // eslint-disable-next-line no-await-in-loop
      || (await ActivityPhoto.exists({ url }));
    if (!stillUsed) toDelete.push(url);
  }
  await deleteUploads(toDelete);
}

async function deleteActivityCascade(activityId) {
  const files = await activityUploadUrls(activityId);
  await deleteActivityChildren(activityId);
  await Activity.deleteOne({ _id: activityId });
  await unlinkUnreferencedUploads(files); // unlink files no other row still uses
}

async function deleteEventCascade(eventId) {
  const activityIds = await Activity.find({ eventId }).distinct('_id');
  // Gather every uploaded file (event image + each activity's image + photos)
  // BEFORE the rows are deleted, then unlink them after the cascade.
  const event = await Event.findById(eventId).select('imageUrl').lean();
  const files = [];
  if (event && event.imageUrl) files.push(event.imageUrl);
  // eslint-disable-next-line no-restricted-syntax
  for (const aid of activityIds) {
    // eslint-disable-next-line no-await-in-loop
    files.push(...await activityUploadUrls(aid));
    // eslint-disable-next-line no-await-in-loop
    await deleteActivityChildren(aid);
  }
  await Promise.all([
    Activity.deleteMany({ eventId }),
    EventMember.deleteMany({ eventId }),
    EventViewer.deleteMany({ eventId }),
    Slap.deleteMany({ eventId }),
    ChatMessage.deleteMany({ eventId }),
    PushSubscription.deleteMany({ eventId }),
    Invite.deleteMany({ eventId }),
  ]);
  await Event.deleteOne({ _id: eventId });
  await unlinkUnreferencedUploads(files);
}

// Deleting a roster user: remove their event memberships, pull them out of any
// team participant's members array, and SetNull their score-entry attribution
// (keep the entries). Slap user ids are loose and left as-is.
async function deleteUserCascade(userId) {
  await EventMember.deleteMany({ userId });
  await Participant.updateMany({ 'members.userId': userId }, { $pull: { members: { userId } } });
  await ScoreEntry.updateMany({ userId }, { $set: { userId: null } });
  // Unlink any account that pointed at this roster identity (avoids a dangling
  // account.userId that would break "play as me").
  await Account.updateMany({ userId }, { $set: { userId: null } });
  await User.deleteOne({ _id: userId });
}

// Deleting an Account (login). Detach its per-event identities and invite refs, and
// pull its co-admin grants. Does NOT delete the roster Users it owns (those are
// people, kept) nor its Events — a null Event.owner would be manageable only by a
// super-admin (see canManageEvent), so we REFUSE deletion while the account still
// owns any event; a real delete route must force handover first.
// NOTE: there is no account-deletion route yet — this is written ready. When one is
// built, also audit SpotifyConnection.ownerId (not imported here) which would dangle.
async function deleteAccountCascade(accountId) {
  if (await Event.exists({ owner: accountId })) {
    throw new Error('Account still owns events — transfer or delete them first.');
  }
  await EventMember.updateMany({ accountId }, { $set: { accountId: null } });
  await Invite.updateMany({ invitedBy: accountId }, { $set: { invitedBy: null } });
  await Invite.updateMany({ acceptedBy: accountId }, { $set: { acceptedBy: null } });
  await Event.updateMany({ admins: accountId }, { $pull: { admins: accountId } });
  // Roster people this account owned become unowned (the per-owner unique index
  // exempts null owners); reassignment is a future product decision.
  await User.updateMany({ owner: accountId }, { $set: { owner: null } });
  await Account.deleteOne({ _id: accountId });
}

module.exports = {
  deleteQuestionCascade,
  deleteParticipantCascade,
  deleteActivityChildren,
  deleteActivityCascade,
  deleteEventCascade,
  deleteUserCascade,
  deleteAccountCascade,
};
