import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import FormData from 'form-data';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Multer für File-Upload (Audio im Memory)
const upload = multer({ storage: multer.memoryStorage() });

// WebSocket-Bus für Untertitel
const server = app.listen(process.env.PORT || 3000, () => {
  console.log('🚀 Server listening on', server.address().port);
});

const wss = new WebSocketServer({ server, path: '/ws/subs' });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('📡 WebSocket-Client verbunden. Gesamt:', clients.size);
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('❌ Client disconnected. Verbleibend:', clients.size);
  });
  
  ws.on('error', (err) => {
    console.error('❌ WebSocket Error:', err);
  });
});

// Broadcast-Funktion
function broadcastSubtitle(payload) {
  const msg = JSON.stringify(payload);
  let count = 0;
  
  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
      count++;
    }
  }
  
  console.log(`📤 Broadcast an ${count} Client(s):`, payload.type, payload.text);
}

// POST /transcribe - Hauptendpoint für Audio → Transkription → Übersetzung
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Keine Audio-Datei erhalten' });
    }
    
    console.log(`📨 Audio empfangen: ${(req.file.size / 1024).toFixed(1)} KB`);
    
    // Prüfe API-Key
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY nicht gesetzt' });
    }
    
    // 1) Whisper API für deutsche Transkription
    console.log('🎤 Sende an Whisper API...');
    const germanText = await transcribeWithWhisper(req.file.buffer);
    
    if (!germanText || germanText.trim() === '') {
      console.log('⚠️ Keine Sprache erkannt');
      return res.json({ german: '', english: '' });
    }
    
    console.log(`🇩🇪 Transkribiert: "${germanText}"`);
    
    // Broadcast deutsche Transkription
    broadcastSubtitle({
      type: 'partial',
      text: `[🇩🇪] ${germanText}`
    });
    
    // 2) GPT-4 für Übersetzung DE → EN
    console.log('🔄 Übersetze nach Englisch...');
    const englishText = await translateToEnglish(germanText);
    
    console.log(`🇬🇧 Übersetzt: "${englishText}"`);
    
    // Broadcast englische Übersetzung
    broadcastSubtitle({
      type: 'final',
      text: englishText
    });
    
    // Response an Client
    res.json({
      german: germanText,
      english: englishText
    });
    
  } catch (error) {
    console.error('❌ Fehler in /transcribe:', error);
    res.status(500).json({ 
      error: error.message,
      details: error.stack
    });
  }
});

// Whisper API Integration
async function transcribeWithWhisper(audioBuffer) {
  try {
    const formData = new FormData();
    
    // Audio-Buffer als File anhängen
    formData.append('file', audioBuffer, {
      filename: 'audio.webm',
      contentType: 'audio/webm'
    });
    
    formData.append('model', 'whisper-1');
    formData.append('language', 'de'); // Deutsch
    formData.append('response_format', 'json');
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        ...formData.getHeaders()
      },
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whisper API Error (${response.status}): ${errorText}`);
    }
    
    const result = await response.json();
    return result.text || '';
    
  } catch (error) {
    console.error('❌ Whisper API Fehler:', error);
    throw error;
  }
}

// GPT-4 Translation
async function translateToEnglish(germanText) {
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini', // Schneller und günstiger für einfache Übersetzungen
        messages: [
          {
            role: 'system',
            content: 'You are a professional German-to-English translator. Translate the given German text to natural, fluent English. Only output the translation, nothing else. Preserve the tone and style of the original.'
          },
          {
            role: 'user',
            content: germanText
          }
        ],
        temperature: 0.3, // Niedrig für konsistente Übersetzungen
        max_tokens: 500
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Translation API Error (${response.status}): ${errorText}`);
    }
    
    const result = await response.json();
    return result.choices[0].message.content.trim();
    
  } catch (error) {
    console.error('❌ Translation API Fehler:', error);
    throw error;
  }
}
