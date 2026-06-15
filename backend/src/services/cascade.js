// Cascade-delete helpers — MongoDB has no referential cascade, so every EF
// `OnDelete(Cascade)` from rundan is replicated here in application code.
// Embedded subdocs (courts/mapCities/memoryCards/options/members) are deleted
// automatically with their parent. The SetNull case (ScoreEntry.userId on User
// delete) and loose bracket refs are handled explicitly.
const {
  Event, Activity, Participant, Question, Answer, ScoreEntry, BracketMatch,
  ActivityPhoto, EventMember, EventViewer, Slap, ChatMessage, PushSubscription, User, Account,
  HitsterGame,
} = require('../models');

async function deleteQuestionCascade(questionId) {
  await Answer.deleteMany({ questionId });
  await Question.deleteOne({ _id: questionId });
}

async function deleteParticipantCascade(participantId) {
  await Answer.deleteMany({ participantId });
  await ScoreEntry.deleteMany({ participantId });
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
  ]);
}

async function deleteActivityCascade(activityId) {
  await deleteActivityChildren(activityId);
  await Activity.deleteOne({ _id: activityId });
}

async function deleteEventCascade(eventId) {
  const activityIds = await Activity.find({ eventId }).distinct('_id');
  // eslint-disable-next-line no-restricted-syntax
  for (const aid of activityIds) {
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
  ]);
  await Event.deleteOne({ _id: eventId });
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

module.exports = {
  deleteQuestionCascade,
  deleteParticipantCascade,
  deleteActivityChildren,
  deleteActivityCascade,
  deleteEventCascade,
  deleteUserCascade,
};
