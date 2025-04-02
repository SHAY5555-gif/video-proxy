const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { setTimeout } = require('timers/promises');

const app = express();
const PORT = process.env.PORT || 3000;

// Add basic rate limiting
const requestCounts = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute per IP

// Clear rate limit counts every minute
setInterval(() => {
    console.log('Clearing rate limit counts');
    Object.keys(requestCounts).forEach(ip => {
        requestCounts[ip] = 0;
    });
}, RATE_LIMIT_WINDOW);

// Rate limiting middleware
function rateLimiter(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    requestCounts[ip] = (requestCounts[ip] || 0) + 1;
    
    if (requestCounts[ip] > RATE_LIMIT_MAX) {
        console.log(`Rate limit exceeded for IP: ${ip}`);
        return res.status(429).json({ 
            error: 'Too many requests. Please try again later.',
            retryAfter: Math.floor(RATE_LIMIT_WINDOW / 1000)
        });
    }
    
    next();
}

app.use(cors());
app.use(rateLimiter);

// Fetch with retries
async function fetchWithRetries(url, options, maxRetries = 3) {
    let lastError;
    let retryDelay = 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Attempt ${attempt}/${maxRetries} for URL: ${url.substring(0, 100)}...`);
            
            const response = await fetch(url, options);
            
            // If we hit a rate limit, wait and retry
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after');
                const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : retryDelay;
                console.log(`Rate limited by source. Waiting ${waitTime}ms before retry`);
                await setTimeout(waitTime);
                
                // Increase retry delay for next attempt
                retryDelay *= 2;
                continue;
            }
            
            return response;
        } catch (err) {
            lastError = err;
            console.error(`Fetch attempt ${attempt} failed:`, err.message);
            
            if (attempt < maxRetries) {
                console.log(`Waiting ${retryDelay}ms before retry...`);
                await setTimeout(retryDelay);
                retryDelay *= 2; // Exponential backoff
            }
        }
    }
    
    throw lastError || new Error('Failed to fetch after multiple attempts');
}

app.get('/proxy', async (req, res) => {
    const videoUrl = req.query.url;
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0';

    if (!videoUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    console.log(`Processing request for: ${videoUrl.substring(0, 100)}...`);

    try {
        const fetchOptions = {
            headers: {
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Accept-Encoding': 'identity',  // Important for YouTube
                'Connection': 'keep-alive',
                'Range': 'bytes=0-', // Support range requests
                'Referer': 'https://www.youtube.com/' // Try adding referer
            }
        };
        
        // Use our enhanced fetch with retries
        const response = await fetchWithRetries(videoUrl, fetchOptions);

        if (!response.ok) {
            console.error(`Error response: ${response.status} ${response.statusText}`);
            return res.status(response.status).json({ error: `Failed to fetch: ${response.statusText}` });
        }

        // Copy all response headers to our response
        for (const [key, value] of response.headers.entries()) {
            // Skip headers that might cause issues
            if (!['content-encoding', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) {
                res.setHeader(key, value);
            }
        }
        
        // Ensure we set the correct content type
        const contentType = response.headers.get('content-type');
        if (contentType) {
            res.setHeader('Content-Type', contentType);
        } else {
            res.setHeader('Content-Type', 'application/octet-stream');
        }
        
        // Optional: support partial content for larger files
        res.setHeader('Accept-Ranges', 'bytes');
        
        // Pipe the response body to the client
        response.body.pipe(res);
        
        // Log success with limited URL (for privacy/security)
        const urlPreview = videoUrl.length > 60 ? 
            `${videoUrl.substring(0, 30)}...${videoUrl.substring(videoUrl.length - 30)}` : 
            videoUrl;
        console.log(`Successfully proxied: ${urlPreview}`);
        
    } catch (err) {
        console.error('Proxy error:', err);
        
        // Send appropriate error based on the error type
        if (err.code === 'ENOTFOUND') {
            return res.status(404).json({ error: 'Resource not found or host unreachable' });
        } else if (err.type === 'request-timeout' || err.name === 'AbortError') {
            return res.status(504).json({ error: 'Request timeout' });
        } else if (err.message.includes('429')) {
            return res.status(429).json({ 
                error: 'Too Many Requests from source API',
                retryAfter: 60 // Suggest retry after 1 minute
            });
        } else {
            res.status(500).json({ error: `Proxy server error: ${err.message}` });
        }
    }
});

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Video Proxy Server</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; line-height: 1.6; }
                    h1 { color: #333; }
                    .container { max-width: 800px; margin: 0 auto; }
                    code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
                    .note { background: #fff8dc; padding: 10px; border-left: 4px solid #ffeb3b; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>Video Proxy Server</h1>
                    <p>This proxy server is running and ready to handle requests.</p>
                    
                    <h2>Usage:</h2>
                    <p>Send requests to <code>/proxy?url=YOUR_VIDEO_URL</code></p>
                    
                    <div class="note">
                        <p><strong>Note:</strong> Rate limiting is enabled. Maximum ${RATE_LIMIT_MAX} requests per IP address per ${RATE_LIMIT_WINDOW/1000} seconds.</p>
                        <p>This server is intended for educational purposes only.</p>
                    </div>
                </div>
            </body>
        </html>
    `);
});

// Custom 404 handler
app.use((req, res) => {
    res.status(404).send('Resource not found');
});

app.listen(PORT, () => {
    console.log(`Proxy server listening on port ${PORT}`);
}); 