const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// API endpoint to get the Gemini API key (stored in Railway environment variable)
app.get('/api/key', (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    res.json({ key: apiKey });
  } else {
    res.status(404).json({ error: 'API key not configured' });
  }
});

// Serve static files from public folder
app.use(express.static('public'));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ginissima Shoe Atelier running on port ${PORT}`);
});
