const mongoose = require('mongoose');

// Single connection helper, mirroring the Glosan template. The whole app shares
// one Mongo connection; on failure we exit so the orchestrator (Docker/PM2)
// restarts us rather than serving a broken app.
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/rundan');
    console.log('MongoDB connected');
  } catch (error) {
    console.error('MongoDB connection error:', error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
