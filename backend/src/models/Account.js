const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Host/admin authentication account — the Glosan-style JWT user, kept SEPARATE
// from rundan's roster `User` (which is just a named person who plays). An
// Account is whoever logs in to create/manage events; the global `admin` role
// is the super-admin that replaces rundan's shared admin code. Per-event
// management is granted by ownership on the Event document.
const accountSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    lowercase: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [30, 'Username too long'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    trim: true,
    lowercase: true,
    match: [/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'Please enter a valid email'],
  },
  // Optional friendly name shown in the host UI; defaults to the username.
  displayName: { type: String, trim: true, maxlength: 60, default: '' },
  // Optional — invited players get a PASSWORDLESS account (they log in via magic
  // link) and can later "set a password" to enable normal login.
  password: {
    type: String,
    default: null,
    validate: {
      validator: (v) => v == null || /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/.test(v),
      message:
        'Password must be at least 10 characters and include an uppercase letter, lowercase letter, and number',
    },
  },
  // Links this login to its persistent roster identity (the named person whose
  // scores accumulate across events). Set when an account plays as themselves.
  // Enforced 1:1 by the partial unique index below (one account per roster User).
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Shareable code for the friends feature. Lazy-generated on first request;
  // sparse so the many not-yet-generated accounts don't collide on null.
  friendCode: { type: String, unique: true, sparse: true, index: true },
  // 'admin' = global super-admin (rundan's site host). Everyone can create and
  // own events; admin can manage every event + the danger zone.
  roles: {
    type: [String],
    enum: ['user', 'admin'],
    default: ['user'],
    validate: { validator: (a) => a.length > 0, message: 'Account must have at least one role' },
  },
  // Refresh-token rotation (family + hashed secret), identical to Glosan.
  refreshTokenHash: { type: String, default: null },
  refreshTokenFamily: { type: String, default: null, index: true, sparse: true },
  emailVerified: { type: Boolean, default: false },
  emailVerifiedAt: { type: Date, default: null },
  ageConsent: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

// A roster User belongs to at most one Account. Partial filter so the many
// accounts with no link (userId: null) don't collide — only real ObjectId links
// are constrained to be unique.
accountSchema.index(
  { userId: 1 },
  { name: 'userId_unique', unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }
);

accountSchema.pre('save', async function hashPassword(next) {
  // Skip when unchanged or passwordless (invited accounts).
  if (!this.isModified('password') || this.password == null) return next();
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

accountSchema.methods.hasPassword = function hasPassword() {
  return !!this.password;
};

accountSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false); // passwordless ⇒ magic-link only
  return bcrypt.compare(candidate, this.password);
};

accountSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.refreshTokenHash;
  delete obj.refreshTokenFamily;
  return obj;
};

module.exports = mongoose.model('Account', accountSchema);
