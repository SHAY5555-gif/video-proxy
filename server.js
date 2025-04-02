const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/proxy', async (req, res) => {
    const videoUrl = req.query.url;

    if (!videoUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const response = await fetch(videoUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': '*/*'
            }
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: `Failed to fetch: ${response.statusText}` });
        }

        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
        res.setHeader('Content-Disposition', 'inline');

        response.body.pipe(res);
    } catch (err) {
        console.error('Proxy error:', err);
        res.status(500).json({ error: 'Proxy server error: ' + err.message });
    }
});

app.get('/', (req, res) => {
    res.send('Proxy server is running.');
});

app.listen(PORT, () => {
    console.log(`Proxy server listening on port ${PORT}`);
}); 