# ChatWave - Real-Time Chat Platform

A real-time messaging platform where each user gets a unique 8-digit Chat Number for instant connections.

## Features

### Core
- **Unique Chat Numbers** - Auto-generated 8-digit number at signup
- **1-on-1 Messaging** - Start a private chat using someone's chat number
- **Group Chats** - Create groups and add members by chat numbers
- **Real-Time** - Instant messaging via Socket.io
- **Responsive Design** - Works on desktop and mobile
- **Secure** - JWT + bcrypt authentication

### Communication
- **File Sharing** - Send images and files (up to 10MB)
- **Voice Notes** - Record and send voice messages in-browser
- **Message Replies** - Reply/quote specific messages (like WhatsApp)
- **Emoji Reactions** - React to any message with emoji
- **Delete Messages** - Unsend messages you sent

### Social
- **Push Notifications** - Browser notifications for new messages
- **Online Status** - Green dot when someone's online
- **Last Seen Timestamps** - "last seen 5 min ago" style
- **Read Receipts** - Sent/Read status on your messages
- **Typing Indicators** - See when someone is typing
- **Profile Pictures** - Upload and display avatars
- **Block/Unblock Users** - Block someone from messaging you
- **Pinned Messages** - Pin important messages in any chat
- **Message Search** - Search across all your conversations

## Tech Stack

- **Backend:** Node.js, Express, Socket.io
- **Database:** SQLite (via better-sqlite3)
- **Auth:** JWT + bcrypt
- **Frontend:** Vanilla HTML/CSS/JS
- **File Upload:** Multer
- **Voice:** MediaRecorder API (WebM)

## Setup

1. Install dependencies:
   ```bash
   cd chat-platform
   npm install
   ```

2. Start the server:
   ```bash
   npm start
   ```
   Or with auto-reload:
   ```bash
   npm run dev
   ```

3. Open http://localhost:3000 in your browser

## How It Works

1. **Sign Up** - Create an account and receive your unique chat number
2. **Share Your Number** - Give your chat number to friends
3. **Start Chatting** - Enter someone's number to message them
4. **Create Groups** - Add multiple chat numbers to start a group
5. **Right-click messages** - Reply, React, Pin, or Delete

## Login Options

You can log in with your:
- Username
- Email
- Chat Number

## File Structure

```
chat-platform/
|-- server.js              - Entry point
|-- database.js            - SQLite schema
|-- package.json
|-- .env
|-- middleware/
|   |-- auth.js            - JWT auth (HTTP + Socket)
|-- routes/
|   |-- auth.js            - Register/Login/Avatar
|   |-- chat.js            - Conversations/Messages/Search/Reactions/Pins/Block
|-- socket/
|   |-- handler.js         - Real-time events
|-- public/
|   |-- css/
|   |   |-- auth.css       - Login page styles
|   |   |-- app.css        - Chat UI styles
|   |-- js/
|   |   |-- auth.js        - Login/Register logic
|   |   |-- app.js         - Full chat client
|   |-- uploads/
|       |-- avatars/       - Profile pictures
|       |-- voice/         - Voice notes
|-- views/
    |-- index.html         - Login/Register page
    |-- app.html           - Chat interface
```
