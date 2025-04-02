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

// Add a YouTube-specific fetch helper
async function fetchFromYouTube(url, options, maxRetries = 3) {
    // YouTube-specific error fix: Sometimes YouTube needs a proper referer and origin
    const youtubeOptions = {
        ...options,
        headers: {
            ...options.headers,
            'Referer': 'https://www.youtube.com/',
            'Origin': 'https://www.youtube.com'
        },
        // Set a timeout of 15 seconds for the fetch operation
        timeout: 15000 // 15 second timeout before aborting
    };

    let lastError;
    let retryDelay = 1000;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`YouTube fetch attempt ${attempt}/${maxRetries} for: ${url.substring(0, 60)}...`);
            
            // Check if URL has expired parameters
            const urlObj = new URL(url);
            if (urlObj.hostname.includes('googlevideo.com')) {
                // Parse 'expire' parameter if it exists
                const expire = urlObj.searchParams.get('expire');
                if (expire) {
                    const expireTimestamp = parseInt(expire, 10) * 1000; // Convert to milliseconds
                    const currentTime = Date.now();
                    
                    if (expireTimestamp < currentTime) {
                        console.error('URL has expired:', { 
                            expired: new Date(expireTimestamp).toISOString(),
                            now: new Date(currentTime).toISOString(),
                            diff: Math.round((currentTime - expireTimestamp) / 1000 / 60) + ' minutes ago'
                        });
                        throw new Error('YouTube URL has expired. Request a fresh URL.');
                    } else {
                        // Log expiration time
                        console.log(`URL will expire in ${Math.round((expireTimestamp - currentTime) / 1000 / 60)} minutes`);
                    }
                }
            }
            
            const response = await fetch(url, youtubeOptions);
            
            if (response.status === 429) {
                console.warn(`Rate limited by YouTube (429). Waiting ${retryDelay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay *= 2; // Exponential backoff
                continue;
            }
            
            if (!response.ok) {
                throw new Error(`YouTube responded with ${response.status} ${response.statusText}`);
            }
            
            return response;
        } catch (err) {
            lastError = err;
            console.error(`YouTube fetch attempt ${attempt} failed:`, err.message);
            
            if (attempt < maxRetries) {
                console.log(`Waiting ${retryDelay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                retryDelay *= 2; // Exponential backoff
            }
        }
    }
    
    throw lastError || new Error('Failed to fetch from YouTube after multiple attempts');
}

// Add maximum file size check for streaming
const MAX_FILE_SIZE = 25 * 1024 * 1024; // Limit to 25MB for Render free tier
let totalBytesStreamed = 0;

// Modify the proxy endpoint to include size limits and better streaming
app.get('/proxy', async (req, res) => {
    const videoUrl = req.query.url;
    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0';
    const startTime = Date.now();

    if (!videoUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    // Check if this is a YouTube website URL rather than a media/CDN URL
    if (videoUrl.includes('youtube.com/watch') || 
        videoUrl.includes('youtu.be/') || 
        videoUrl.match(/youtube\.com\/(shorts|playlist|channel|c\/)/)) {
        
        console.log(`Redirecting user to YouTube URL: ${videoUrl}`);
        return res.redirect(302, videoUrl);
    }

    // Add support for partial content requests (Range header)
    const rangeHeader = req.headers.range;
    let rangeStart = 0;
    let rangeEnd = null;

    if (rangeHeader) {
        const rangeParts = rangeHeader.replace('bytes=', '').split('-');
        rangeStart = parseInt(rangeParts[0], 10) || 0;
        if (rangeParts[1] && rangeParts[1].trim() !== '') {
            rangeEnd = parseInt(rangeParts[1], 10);
        }
    }

    // Reset byte counter for this request
    totalBytesStreamed = 0;

    // Add request ID for tracking
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    console.log(`[${requestId}] Processing request for: ${videoUrl.substring(0, 100)}...`);

    // Set up keepalive checker for the client connection
    const keepAliveInterval = setInterval(() => {
        if (!res.writableEnded) {
            // If connection is still open but taking long, write a comment to keep it alive
            try {
                res.write('\n');
            } catch (err) {
                // If we can't write, the connection is probably already closed
                clearInterval(keepAliveInterval);
            }
        } else {
            clearInterval(keepAliveInterval);
        }
    }, 10000); // Check every 10 seconds

    // Set a timeout for the entire request
    const requestTimeout = setTimeout(() => {
        if (!res.writableEnded) {
            console.error(`[${requestId}] Request timed out after 120 seconds`);
            clearInterval(keepAliveInterval);
            
            // Only attempt to write an error if headers haven't been sent
            if (!res.headersSent) {
                return res.status(504).json({ 
                    error: 'Gateway Timeout', 
                    message: 'Request took too long to complete'
                });
            } else {
                try {
                    res.end();
                } catch (e) {
                    console.error(`[${requestId}] Error ending response after timeout:`, e);
                }
            }
        }
    }, 120000); // 120 second overall timeout

    try {
        // Check if it's a YouTube URL
        const isYouTubeUrl = videoUrl.includes('googlevideo.com') || 
                             videoUrl.includes('youtube.com') || 
                             videoUrl.includes('youtu.be');
        
        console.log(`[${requestId}] URL identified as ${isYouTubeUrl ? 'YouTube' : 'generic'} URL`);
        
        // Modify fetch options to include range if requested
        const fetchOptions = {
            headers: {
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Accept-Encoding': 'identity',  // Important for YouTube
                'Connection': 'keep-alive',
                'Referer': 'https://www.youtube.com/' // Try adding referer
            }
        };

        // Add range header if present in original request
        if (rangeHeader) {
            fetchOptions.headers['Range'] = rangeHeader;
        } else {
            // Default to start from beginning
            fetchOptions.headers['Range'] = 'bytes=0-';
        }
        
        console.log(`[${requestId}] Fetch options:`, JSON.stringify(fetchOptions, null, 2));
        
        // Use YouTube-specific fetch for YouTube URLs, regular fetch otherwise
        const response = isYouTubeUrl
            ? await fetchFromYouTube(videoUrl, fetchOptions)
            : await fetchWithRetries(videoUrl, fetchOptions);

        // Log response details
        console.log(`[${requestId}] Response status: ${response.status}`);
        
        // Check for content length
        const contentLength = response.headers.get('content-length');
        const estimatedSize = contentLength ? parseInt(contentLength, 10) : null;
        
        if (estimatedSize && estimatedSize > MAX_FILE_SIZE) {
            console.warn(`[${requestId}] Content length (${estimatedSize} bytes) exceeds maximum size limit (${MAX_FILE_SIZE} bytes)`);
            clearInterval(keepAliveInterval);
            clearTimeout(requestTimeout);
            return res.status(413).json({
                error: 'Payload Too Large',
                message: `File size (${Math.round(estimatedSize/1024/1024)}MB) exceeds maximum size limit (${Math.round(MAX_FILE_SIZE/1024/1024)}MB)`,
                solution: 'Try a different quality or format'
            });
        }
        
        // Set proper status code for range requests
        if (rangeHeader && response.status === 206) {
            res.status(206);
        }

        // Copy all response headers to our response
        for (const [key, value] of response.headers.entries()) {
            // Skip headers that might cause issues
            if (!['content-encoding', 'content-length', 'connection', 'transfer-encoding'].includes(key.toLowerCase())) {
                try {
                    res.setHeader(key, value);
                } catch (headerErr) {
                    console.error(`Error setting header ${key}: ${headerErr.message}`);
                    // Continue despite header error
                }
            }
        }
        
        // Ensure we set the correct content type
        const contentType = response.headers.get('content-type');
        if (contentType) {
            res.setHeader('Content-Type', contentType);
        } else {
            res.setHeader('Content-Type', 'application/octet-stream');
        }
        
        // Handle streaming with explicit error handling and size limits
        try {
            // Create a transform stream that monitors size
            const { Transform } = require('stream');
            const sizeMonitorStream = new Transform({
                transform(chunk, encoding, callback) {
                    totalBytesStreamed += chunk.length;
                    
                    if (totalBytesStreamed > MAX_FILE_SIZE) {
                        console.warn(`[${requestId}] Size limit exceeded during streaming. Closing connection after ${totalBytesStreamed} bytes`);
                        this.destroy(new Error(`Size limit of ${MAX_FILE_SIZE} bytes exceeded`));
                        return;
                    }
                    
                    // Pass the chunk through
                    this.push(chunk);
                    callback();
                }
            });
            
            // Handle errors on the size monitor stream
            sizeMonitorStream.on('error', (err) => {
                console.error(`[${requestId}] Size monitor stream error:`, err);
                if (!res.writableEnded) {
                    try {
                        res.end();
                    } catch (e) {
                        console.error(`[${requestId}] Error ending response after size monitor error:`, e);
                    }
                }
            });
            
            // Handle errors on the source body stream
            response.body.on('error', (err) => {
                console.error(`[${requestId}] Source stream error:`, err);
                clearInterval(keepAliveInterval);
                clearTimeout(requestTimeout);
                
                if (!res.writableEnded) {
                    try {
                        res.end();
                    } catch (e) {
                        console.error(`[${requestId}] Error ending response after source error:`, e);
                    }
                }
            });
            
            // Handle end of stream
            response.body.on('end', () => {
                console.log(`[${requestId}] Stream completed successfully. Total bytes: ${totalBytesStreamed}`);
                clearInterval(keepAliveInterval);
                clearTimeout(requestTimeout);
            });
            
            // Pipe through the monitor and to the response
            response.body
                .pipe(sizeMonitorStream)
                .pipe(res)
                .on('finish', () => {
                    const duration = Date.now() - startTime;
                    console.log(`[${requestId}] Response finished in ${duration}ms. Total bytes: ${totalBytesStreamed}`);
                    clearInterval(keepAliveInterval);
                    clearTimeout(requestTimeout);
                })
                .on('error', (err) => {
                    console.error(`[${requestId}] Response stream error:`, err);
                    clearInterval(keepAliveInterval);
                    clearTimeout(requestTimeout);
                });
                
            // Log success with limited URL
            const urlPreview = videoUrl.length > 60 ? 
                `${videoUrl.substring(0, 30)}...${videoUrl.substring(videoUrl.length - 30)}` : 
                videoUrl;
            console.log(`[${requestId}] Successfully piping response for: ${urlPreview}`);
            
        } catch (streamSetupErr) {
            console.error(`[${requestId}] Error setting up stream:`, streamSetupErr);
            clearInterval(keepAliveInterval);
            clearTimeout(requestTimeout);
            
            // Only send error if headers have not been sent
            if (!res.headersSent) {
                return res.status(500).json({ error: `Stream setup error: ${streamSetupErr.message}` });
            } else if (!res.writableEnded) {
                try {
                    res.end();
                } catch (e) {
                    console.error(`[${requestId}] Error ending response after stream setup error:`, e);
                }
            }
        }
        
    } catch (err) {
        // Clean up intervals/timeouts on error
        clearInterval(keepAliveInterval);
        clearTimeout(requestTimeout);
        
        console.error(`[${requestId}] Proxy error:`, err);
        console.error(`[${requestId}] Error stack:`, err.stack);
        
        // Provide detailed error information
        const errorDetails = {
            message: err.message,
            type: err.name || 'Unknown',
            code: err.code || 'None',
            timestamp: new Date().toISOString()
        };
        
        // Check for YouTube-specific errors
        if (err.message.includes('URL has expired')) {
            return res.status(410).json({
                error: 'YouTube URL has expired',
                details: errorDetails,
                solution: 'Please refresh the page and try again to get a fresh URL'
            });
        }
        
        // Send appropriate error based on the error type
        if (err.code === 'ENOTFOUND') {
            return res.status(404).json({ 
                error: 'Resource not found or host unreachable',
                details: errorDetails
            });
        } else if (err.type === 'request-timeout' || err.name === 'AbortError') {
            return res.status(504).json({ 
                error: 'Request timeout',
                details: errorDetails
            });
        } else if (err.message.includes('429')) {
            return res.status(429).json({ 
                error: 'Too Many Requests from source API',
                retryAfter: 60, // Suggest retry after 1 minute
                details: errorDetails
            });
        } else if (err.message.includes('403')) {
            return res.status(403).json({ 
                error: 'Resource access forbidden (403)',
                details: errorDetails,
                solution: 'Try using a different video format or quality'
            });
        } else {
            // Log as much detail as possible about the error
            console.error('[${requestId}] Unhandled error details:', {
                message: err.message,
                name: err.name,
                code: err.code,
                errno: err.errno,
                stack: err.stack && err.stack.split('\n')
            });
            
            res.status(500).json({ 
                error: `Proxy server error: ${err.message}`,
                errorType: err.name || 'Unknown',
                errorCode: err.code || 'None',
                timestamp: new Date().toISOString(),
                solution: 'Try refreshing the page to get a fresh URL or try a different video'
            });
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