require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { authenticateSocket } = require('./middleware/auth');
const { setupSocket } = require('./socket/handler');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Ensure upload directories exist
const uploadDirs = [
  path.join(__dirname, 'public/uploads'),
  path.join(__dirname, 'public/uploads/avatars'),
  path.join(__dirname, 'public/uploads/voice'),
  path.join(__dirname, 'public/uploads/groups')
];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io authentication
io.use(authenticateSocket);
setupSocket(io);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/chat', require('./routes/chat'));

// Serve the app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'app.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('ChatWave running on http://localhost:' + PORT);
});
