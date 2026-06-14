const mongoose = require('mongoose');

// Friendships between Accounts. Two-row symmetric pattern: when A and B become
// friends we insert {account:A, friend:B} AND {account:B, friend:A}, so "all
// friends of X" is a single find({ account: X }). Removing deletes both rows.
const friendshipSchema = new mongoose.Schema({
  account: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  friend: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
  addedAt: { type: Date, default: Date.now },
});

friendshipSchema.index({ account: 1, friend: 1 }, { unique: true });

module.exports = mongoose.model('Friendship', friendshipSchema);
