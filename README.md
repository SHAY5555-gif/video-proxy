# Video Proxy Server

A simple Node.js proxy server to fetch video/audio files and bypass CORS restrictions.

## Usage

Run locally:

```bash
npm install
node server.js
```

Then access:

```
http://localhost:3000/proxy?url=https://example.com/video.mp4
```

## Deploy to Render

1. Push this repo to GitHub
2. Go to [Render](https://render.com)
3. Create a new Web Service
4. Set:
   - Build Command: `npm install`
   - Start Command: `npm start`