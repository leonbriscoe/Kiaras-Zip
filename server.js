require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');

// Import models
const User = require('./models/User');
const Progress = require('./models/Progress');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-token';
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/zipdb';

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log(' Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// API: Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'missing' });
    }

    // Check if any users exist (first user can register freely)
    const userCount = await User.countDocuments();
    if (userCount > 0) {
      // Check if this user already exists
      const existingUser = await User.findOne({ username: username.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({ error: 'exists' });
      }
      
    }

    const user = new User({ username, password });
    await user.save();
    console.log(` User registered: ${username}`);
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// API: Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'missing' });
    }

    const user = await User.findOne({ username: username.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'not_found' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'wrong_password' });
    }

    console.log(` User logged in: ${username}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// API: Submit progress
app.post('/api/progress', async (req, res) => {
  try {
    const { username, id, elapsed, n, numbersCount } = req.body || {};
    if (!username || typeof id === 'undefined' || typeof elapsed === 'undefined') {
      return res.status(400).json({ error: 'missing' });
    }

    // Upsert: update if exists, insert if not
    await Progress.findOneAndUpdate(
      { username: username.toLowerCase(), puzzleId: id },
      {
        username: username.toLowerCase(),
        puzzleId: id,
        timeMs: Number(elapsed),
        gridSize: n || null,
        numbersCount: numbersCount || null
      },
      { upsert: true, new: true }
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('Progress save error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// API: Get all progress (for rankings)
app.get('/api/progress', async (req, res) => {
  try {
    const progressDocs = await Progress.find();
    
    // Transform to same format as before
    const result = {};
    for (const doc of progressDocs) {
      if (!result[doc.username]) {
        result[doc.username] = { times: {} };
      }
      result[doc.username].times[doc.puzzleId] = {
        ms: doc.timeMs,
        n: doc.gridSize,
        numbersCount: doc.numbersCount
      };
    }
    
    return res.json(result);
  } catch (err) {
    console.error('Progress fetch error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// API: Get specific user's progress
app.get('/api/progress/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();
    const progressDocs = await Progress.find({ username });
    
    // Transform to localStorage format
    const result = {
      opened: {},
      completed: {},
      times: {},
      startTimes: {}
    };
    
    for (const doc of progressDocs) {
      result.completed[doc.puzzleId] = true;
      result.opened[doc.puzzleId] = true;
      result.times[doc.puzzleId] = doc.timeMs;
    }
    
    return res.json(result);
  } catch (err) {
    console.error('User progress fetch error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});


// Admin: List users (protected)
app.get('/api/users', async (req, res) => {
  const token = req.header('x-admin-token');
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const users = await User.find().select('username createdAt');
    return res.json(users);
  } catch (err) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Admin: Delete user (protected)
app.delete('/api/users/:username', async (req, res) => {
  const token = req.header('x-admin-token');
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const result = await User.deleteOne({ username: req.params.username.toLowerCase() });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    // Also delete their progress
    await Progress.deleteMany({ username: req.params.username.toLowerCase() });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'server_error' });
  }
});

// Redirect root to login page
app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// Serve static files
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(` MongoDB: ${MONGODB_URI}`);
});