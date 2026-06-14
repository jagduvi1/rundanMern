// Barrel export for all Mongoose models. Importing this once ensures every
// schema is registered with Mongoose (so refs/populate resolve regardless of
// import order in routes/services).
module.exports = {
  Account: require('./Account'),
  Token: require('./Token'),
  Friendship: require('./Friendship'),
  User: require('./User'),
  Event: require('./Event'),
  EventMember: require('./EventMember'),
  Activity: require('./Activity'),
  Participant: require('./Participant'),
  Question: require('./Question'),
  Answer: require('./Answer'),
  ScoreEntry: require('./ScoreEntry'),
  BracketMatch: require('./BracketMatch'),
  EventViewer: require('./EventViewer'),
  Slap: require('./Slap'),
  ChatMessage: require('./ChatMessage'),
  ActivityPhoto: require('./ActivityPhoto'),
  PushSubscription: require('./PushSubscription'),
  SpotifyConnection: require('./SpotifyConnection'),
  AppSetting: require('./AppSetting'),
  QuestionTemplate: require('./QuestionTemplate'),
  QuestionTemplateUsage: require('./QuestionTemplateUsage'),
};
