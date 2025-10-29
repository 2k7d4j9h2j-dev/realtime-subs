import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// 1) Ephemeres Token für Realtime erzeugen (vom Browser aufgerufen)
app.post('/session', async (req, res) => {
  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Modell für Realtime; kann je nach Verfügbarkeit abweichen
        model: 'gpt-4o-realtime-preview',
        // Ziel: Deutsch erkennen & EN ausgeben (Systemprompt hilft)
        voice: null, // wir wollen Text, keine Audio-Antwort
        modalities: ["text","audio","transcription"],
        instructions: "You are a live subtitle/translation agent. Recognize German speech and output English text subtitles. Keep outputs concise.",
        // Optional: automatische Turn-Detection / VAD
        turn_detection: { type: "server_vad" }
      })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('Session error:', data);
      return res.status(500).json({ error: data });
    }
    res.json(data); // enthält ephemeral client_secret etc.
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// 2) WebSocket-Bus für Untertitel (Publisher = streamit, Viewer = getit)
const server = app.listen(process.env.PORT || 3000, () => {
  console.log('Server listening on', server.address().port);
});
const wss = new WebSocketServer({ server, path: '/ws/subs' });

const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('message', (msg) => {
    // Einfaches Broadcast-Protokoll: {type:"partial"|"final", text:"..."}
    for (const c of clients) {
      if (c !== ws && c.readyState === 1) {
        c.send(msg);
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});
