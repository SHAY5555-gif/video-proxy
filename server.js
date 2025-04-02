const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const { setTimeout } = require('timers/promises');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const FormData = require('form-data'); // Add form-data package for multipart forms

const app = express();
const PORT = process.env.PORT || 3000;

// Add basic rate limiting
const requestCounts = {};
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests per minute per IP

// Add API key for ElevenLabs at the top of the file with other constants
const ELEVENLABS_API_KEY = "sk_3cc5eba36a57dc0b8652796ce6c3a6f28277c977e93070da";

// Create a temporary directory for audio files if it doesn't exist
const TEMP_DIR = path.join(os.tmpdir(), 'youtube-proxy-audio');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Add cleanup function to periodically remove old temporary files
setInterval(() => {
    try {
        const currentTime = Date.now();
        const files = fs.readdirSync(TEMP_DIR);
        
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            const stats = fs.statSync(filePath);
            
            // Delete files older than 1 hour
            if (currentTime - stats.mtimeMs > 60 * 60 * 1000) {
                fs.unlinkSync(filePath);
                console.log(`Deleted old temporary file: ${filePath}`);
            }
        }
    } catch (err) {
        console.error('Error cleaning up temporary files:', err);
    }
}, 15 * 60 * 1000); // Check every 15 minutes

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

// Add request logging middleware to see all incoming requests
app.use((req, res, next) => {
    const method = req.method;
    const url = req.url;
    const contentType = req.get('Content-Type') || 'none';
    console.log(`[REQUEST] ${method} ${url} (Content-Type: ${contentType})`);
    
    // Log query parameters if present
    if (Object.keys(req.query).length > 0) {
        console.log(`[REQUEST QUERY] ${JSON.stringify(req.query)}`);
    }
    
    // Log user agent
    const userAgent = req.get('User-Agent') || 'unknown';
    console.log(`[REQUEST AGENT] ${userAgent.substring(0, 100)}${userAgent.length > 100 ? '...' : ''}`);
    
    // Continue to next middleware
    next();
});

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

// Add YouTube info API integration with ZM.io.vn
app.get('/youtube-info', async (req, res) => {
    const videoId = req.query.id;
    const videoUrl = req.query.url;
    
    // We need either video ID or full URL
    if (!videoId && !videoUrl) {
        return res.status(400).json({ 
            error: 'Missing required parameter: id or url',
            example: '/youtube-info?id=VIDEOID or /youtube-info?url=https://www.youtube.com/watch?v=VIDEOID'
        });
    }

    // Create a request ID for tracking
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    try {
        // Construct the YouTube URL if only ID was provided
        let fullUrl = videoUrl;
        if (!fullUrl && videoId) {
            fullUrl = `https://www.youtube.com/watch?v=${videoId}`;
        }
        
        console.log(`[${requestId}] Fetching video info from ZM API for: ${fullUrl}`);
        
        // ZM API configuration
        const zmApiKey = "hBsrDies"; // API key as in content.js
        const zmApiUrl = 'https://api.zm.io.vn/v1/social/autolink';
        
        // Make request to ZM API
        const zmOptions = {
            method: 'POST',
            headers: {
                'apikey': zmApiKey, 
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url: fullUrl })
        };
        
        // Fetch with retries
        let zmResponse;
        let retryCount = 0;
        const maxRetries = 3;
        let delay = 1000;
        
        while (retryCount < maxRetries) {
            try {
                console.log(`[${requestId}] ZM API request attempt ${retryCount + 1}`);
                zmResponse = await fetch(zmApiUrl, zmOptions);
                
                if (zmResponse.ok) {
                    break; // Success
                } else if (zmResponse.status === 429) {
                    // Rate limited
                    console.log(`[${requestId}] ZM API rate limited, retrying in ${delay}ms`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2; // Exponential backoff
                    retryCount++;
                } else {
                    // Other error
                    const errorText = await zmResponse.text();
                    throw new Error(`ZM API error: ${zmResponse.status} ${zmResponse.statusText}. Body: ${errorText}`);
                }
            } catch (err) {
                if (retryCount < maxRetries - 1) {
                    console.log(`[${requestId}] ZM API request failed, retrying: ${err.message}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    delay *= 2;
                    retryCount++;
                } else {
                    throw err;
                }
            }
        }
        
        if (!zmResponse || !zmResponse.ok) {
            throw new Error('Failed to get response from ZM API after multiple attempts');
        }
        
        // Parse the ZM API response
        const zmData = await zmResponse.json();
        
        if (!zmData || !zmData.medias || !Array.isArray(zmData.medias)) {
            throw new Error('Invalid data format received from ZM API');
        }
        
        console.log(`[${requestId}] ZM API responded with ${zmData.medias.length} media options`);
        
        // Process and organize the media formats
        const processedData = {
            title: zmData.title || "",
            thumbnail: zmData.thumbnail || "",
            duration: zmData.duration || 0,
            source: "zm.io.vn",
            formats: {
                video: [],
                audio: []
            },
            // Include some recommended formats for convenience
            recommended: {
                video: null,
                audio: null,
                combined: null
            }
        };
        
        // Process media options and categorize them
        zmData.medias.forEach(media => {
            // Create a clean format object
            const format = {
                url: media.url,
                quality: media.quality || media.label || "Unknown",
                formatId: media.formatId || "unknown",
                type: media.type || (media.quality && media.quality.includes('audio') ? 'audio' : 'video'),
                ext: media.ext || "mp4",
                size: media.size || null,
                bitrate: media.bitrate || null
            };
            
            // Categorize as audio or video
            if (format.type === 'audio' || format.quality.toLowerCase().includes('audio')) {
                processedData.formats.audio.push(format);
                // Use first audio or lowest bitrate audio as recommended
                if (!processedData.recommended.audio || 
                    (format.bitrate && 
                     processedData.recommended.audio.bitrate && 
                     format.bitrate < processedData.recommended.audio.bitrate)) {
                    processedData.recommended.audio = format;
                }
            } else {
                processedData.formats.video.push(format);
                // Track a decent quality video for recommendation
                if (format.formatId === '18' || format.quality.includes('360p')) {
                    processedData.recommended.combined = format;
                }
                // Use medium quality as recommended video
                if (!processedData.recommended.video && (
                    format.quality.includes('720p') ||
                    format.quality.includes('480p'))) {
                    processedData.recommended.video = format;
                }
            }
        });
        
        // Ensure we have recommendations
        if (!processedData.recommended.video && processedData.formats.video.length > 0) {
            processedData.recommended.video = processedData.formats.video[0];
        }
        if (!processedData.recommended.audio && processedData.formats.audio.length > 0) {
            processedData.recommended.audio = processedData.formats.audio[0];
        }
        if (!processedData.recommended.combined) {
            processedData.recommended.combined = processedData.recommended.video || processedData.recommended.audio;
        }
        
        // Return processed data
        res.json({
            success: true,
            data: processedData
        });
        
    } catch (error) {
        console.error(`[${requestId}] Error fetching video info:`, error);
        res.status(500).json({
            success: false,
            error: `Failed to get video information: ${error.message}`
        });
    }
});

// Improve the download endpoint with better error handling and fallbacks
app.get('/download', async (req, res) => {
    const videoId = req.query.id;
    const format = req.query.format || 'combined'; // 'video', 'audio', or 'combined'
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    if (!videoId) {
        return res.status(400).json({ 
            success: false,
            error: 'חסר פרמטר חובה: id (מזהה סרטון)',
            example: '/download?id=YOUTUBE_VIDEO_ID&format=audio|video|combined'
        });
    }
    
    try {
        console.log(`[${requestId}] Download request for video ID: ${videoId}, format: ${format}`);
        
        // First fetch the video info using our own API
        const infoUrl = `http${req.secure ? 's' : ''}://${req.headers.host}/youtube-info?id=${videoId}`;
        console.log(`[${requestId}] Fetching video info from: ${infoUrl}`);
        
        const infoResponse = await fetch(infoUrl);
        
        if (!infoResponse.ok) {
            const errorText = await infoResponse.text();
            console.error(`[${requestId}] Error fetching video info: ${infoResponse.status} ${errorText}`);
            throw new Error(`שגיאה בקבלת מידע על הסרטון: ${infoResponse.status}. ${errorText}`);
        }
        
        const infoData = await infoResponse.json();
        
        if (!infoData.success || !infoData.data) {
            console.error(`[${requestId}] Invalid response from youtube-info:`, infoData);
            throw new Error('תגובה לא תקפה מנקודת הקצה של מידע הסרטון');
        }
        
        // Try to find a working format with fallbacks - simplified approach without validation
        let downloadUrl;
        let filename;
        let size = 'unknown';
        let qualityInfo = '';
        let formatDescription = format;
        let fallbackMessage = '';
        
        // Track all attempts to report to user
        const attemptedFormats = [];
        
        // Attempt to get URL for the requested format - simplified
        const tryFormat = (formatType, formatIndex = 0) => {
            const desc = formatType + (formatIndex > 0 ? ` (alternative ${formatIndex})` : '');
            attemptedFormats.push(desc);
            
            console.log(`[${requestId}] Trying format: ${desc}`);
            
            let url = null;
            let fmtInfo = null;
            
            // Attempt primary format first
            if (formatIndex === 0) {
                if (formatType === 'audio' && infoData.data.recommended && infoData.data.recommended.audio) {
                    url = infoData.data.recommended.audio.url;
                    fmtInfo = infoData.data.recommended.audio;
                } else if (formatType === 'video' && infoData.data.recommended && infoData.data.recommended.video) {
                    url = infoData.data.recommended.video.url;
                    fmtInfo = infoData.data.recommended.video;
                } else if (formatType === 'combined' && infoData.data.recommended && infoData.data.recommended.combined) {
                    url = infoData.data.recommended.combined.url;
                    fmtInfo = infoData.data.recommended.combined;
                }
            } 
            // Try alternative formats from the formats array
            else {
                if (formatType === 'audio' && infoData.data.formats && infoData.data.formats.audio) {
                    const alternativeIndex = formatIndex - 1;
                    if (alternativeIndex < infoData.data.formats.audio.length) {
                        fmtInfo = infoData.data.formats.audio[alternativeIndex];
                        url = fmtInfo.url;
                    }
                } else if (formatType === 'video' && infoData.data.formats && infoData.data.formats.video) {
                    const alternativeIndex = formatIndex - 1;
                    if (alternativeIndex < infoData.data.formats.video.length) {
                        fmtInfo = infoData.data.formats.video[alternativeIndex];
                        url = fmtInfo.url;
                    }
                }
            }
            
            if (!url) {
                console.log(`[${requestId}] No URL found for format: ${desc}`);
                return null;
            }
            
            return {
                url,
                formatInfo: fmtInfo,
                description: desc
            };
        };
        
        // First try the explicitly requested format
        let result = tryFormat(format);
        
        // If the primary format fails, try alternatives
        if (!result) {
            console.log(`[${requestId}] Primary format '${format}' failed, trying alternatives...`);
            fallbackMessage = `הפורמט המבוקש (${format}) לא היה זמין. `;
            
            // If the requested format is 'combined', try 'video' then 'audio'
            if (format === 'combined') {
                fallbackMessage += 'מנסה פורמט וידאו...';
                result = tryFormat('video');
                
                if (!result) {
                    fallbackMessage += ' מנסה פורמט אודיו בלבד...';
                    result = tryFormat('audio');
                }
            } 
            // If requested format is 'video', try alternatives from the formats.video array
            else if (format === 'video') {
                const videoFormatCount = infoData.data.formats && infoData.data.formats.video ? 
                                        infoData.data.formats.video.length : 0;
                
                for (let i = 1; i <= Math.min(videoFormatCount, 3) && !result; i++) {
                    fallbackMessage += ` מנסה פורמט וידאו חלופי ${i}...`;
                    result = tryFormat('video', i);
                }
                
                // If all video formats fail, try combined then audio
                if (!result) {
                    fallbackMessage += ' מנסה פורמט משולב...';
                    result = tryFormat('combined');
                    
                    if (!result) {
                        fallbackMessage += ' מנסה פורמט אודיו בלבד...';
                        result = tryFormat('audio');
                    }
                }
            }
            // If requested format is 'audio', try alternatives from the formats.audio array
            else if (format === 'audio') {
                const audioFormatCount = infoData.data.formats && infoData.data.formats.audio ? 
                                        infoData.data.formats.audio.length : 0;
                
                for (let i = 1; i <= Math.min(audioFormatCount, 3) && !result; i++) {
                    fallbackMessage += ` מנסה פורמט אודיו חלופי ${i}...`;
                    result = tryFormat('audio', i);
                }
                
                // If all audio formats fail, try combined then video
                if (!result) {
                    fallbackMessage += ' מנסה פורמט משולב...';
                    result = tryFormat('combined');
                    
                    if (!result) {
                        fallbackMessage += ' מנסה פורמט וידאו...';
                        result = tryFormat('video');
                    }
                }
            }
        }
        
        // If we still don't have a valid URL, throw an error
        if (!result) {
            console.error(`[${requestId}] All format attempts failed. Attempted: ${attemptedFormats.join(', ')}`);
            throw new Error(`כל נסיונות ההורדה נכשלו. ניסינו: ${attemptedFormats.join(', ')}`);
        }
        
        // We have a working URL, proceed with download
        downloadUrl = result.url;
        const formatInfo = result.formatInfo || {};
        formatDescription = result.description;
        
        // Set up filename and other info
        const ext = formatInfo.ext || (formatDescription.includes('audio') ? 'mp3' : 'mp4');
        let filenameBase = infoData.data.title || videoId;
        
        // Add format suffix if using a fallback format
        if (fallbackMessage) {
            filenameBase += ` (${formatDescription})`;
        }
        
        filename = `${filenameBase}.${ext}`;
        
        // Get size and quality info if available
        if (formatInfo.size) {
            size = formatFileSize(formatInfo.size);
        }
        if (formatInfo.quality) {
            qualityInfo = formatInfo.quality;
        }
        
        // Clean filename
        filename = filename.replace(/[<>:"/\\|?*]+/g, '_');
        
        // Check if URL might be expired
        if (downloadUrl.includes('expire=')) {
            try {
                const urlObj = new URL(downloadUrl);
                const expire = urlObj.searchParams.get('expire');
                
                if (expire) {
                    const expireTimestamp = parseInt(expire, 10) * 1000; // Convert to milliseconds
                    const currentTime = Date.now();
                    
                    if (expireTimestamp < currentTime) {
                        console.error(`[${requestId}] YouTube URL has expired at ${new Date(expireTimestamp).toISOString()} (${Math.round((currentTime - expireTimestamp) / 1000 / 60)} minutes ago)`);
                        throw new Error('כתובת ההורדה פגת תוקף. אנא רענן את הדף ונסה שוב');
                    }
                }
            } catch (urlError) {
                if (urlError.message.includes('כתובת ההורדה פגת תוקף')) {
                    throw urlError; // Re-throw our custom error
                }
                // Otherwise continue with the download attempt
            }
        }
        
        // Log download details
        console.log(`[${requestId}] Download details:
            Title: ${infoData.data.title || 'Unknown'}
            Format requested: ${format}
            Format used: ${formatDescription}
            Fallback used: ${fallbackMessage ? 'Yes' : 'No'}
            Filename: ${filename}
            Size: ${size}
            Quality: ${qualityInfo}
            URL length: ${downloadUrl.length} chars
            Expires: ${downloadUrl.includes('expire=') ? 'Yes (YouTube time-limited URL)' : 'No'}
        `);
        
        // Set up client response
        const htmlResponse = fallbackMessage ? `
            <html>
                <head>
                    <title>הורדה בפורמט חלופי</title>
                    <meta charset="UTF-8">
                    <meta http-equiv="refresh" content="3;url=${downloadUrl}">
                    <style>
                        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f0f0f0; text-align: center; direction: rtl; }
                        .container { max-width: 700px; margin: 100px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        h1 { color: #c00; margin-top: 0; }
                        .success-icon { font-size: 48px; color: #4CAF50; margin-bottom: 20px; }
                        .download-btn { display: inline-block; margin-top: 20px; padding: 12px 25px; background: #c00; color: white; text-decoration: none; border-radius: 4px; font-size: 16px; }
                        .download-btn:hover { background: #900; }
                        .info { background: #e8f5e9; padding: 15px; border-radius: 4px; margin: 20px 0; text-align: right; }
                        .progress { height: 5px; background: #f0f0f0; border-radius: 5px; margin: 20px 0; overflow: hidden; }
                        .progress-bar { height: 100%; width: 0; background: #c00; animation: progress 3s linear forwards; }
                        @keyframes progress { to { width: 100%; } }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="success-icon">✓</div>
                        <h1>הורדה מתחילה בעוד 3 שניות...</h1>
                        <div class="progress"><div class="progress-bar"></div></div>
                        <div class="info">
                            <p><strong>הפורמט המקורי לא היה זמין.</strong> ${fallbackMessage}</p>
                            <p><strong>משתמש בפורמט:</strong> ${formatDescription}</p>
                            <p><strong>שם קובץ:</strong> ${filename}</p>
                            <p><strong>גודל:</strong> ${size}</p>
                            <p><strong>איכות:</strong> ${qualityInfo || 'לא צוין'}</p>
                        </div>
                        <p>אם ההורדה לא מתחילה אוטומטית, לחץ על הכפתור:</p>
                        <a href="${downloadUrl}" class="download-btn">התחל הורדה</a>
                    </div>
                    <script>
                        setTimeout(function() {
                            window.location.href = "${downloadUrl}";
                        }, 3000);
                    </script>
                </body>
            </html>
        ` : null;
        
        // If using a fallback format, show info page with auto-redirect
        if (htmlResponse) {
            res.send(htmlResponse);
        } else {
            // Otherwise, regular download with Content-Disposition header
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
            res.redirect(302, downloadUrl);
        }
    } catch (error) {
        console.error(`[${requestId}] Download error:`, error);
        
        // Return a user-friendly HTML error page
        res.status(500).send(`
            <html>
                <head>
                    <title>שגיאת הורדה</title>
                    <meta charset="UTF-8">
                    <style>
                        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f0f0f0; text-align: right; direction: rtl; }
                        .container { max-width: 600px; margin: 100px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                        h1 { color: #c00; margin-top: 0; }
                        .back-btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #c00; color: white; text-decoration: none; border-radius: 4px; }
                        .back-btn:hover { background: #900; }
                        .retry-btn { display: inline-block; margin-top: 20px; margin-right: 10px; padding: 10px 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 4px; }
                        .retry-btn:hover { background: #0b7dda; }
                        .error-details { background: #ffe6e6; padding: 15px; border-radius: 4px; margin-top: 20px; }
                        code { background: #f8f8f8; padding: 2px 5px; border-radius: 3px; font-family: monospace; direction: ltr; display: inline-block; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>שגיאה בהורדת הסרטון</h1>
                        <p>${error.message || 'שגיאה לא ידועה התרחשה בעת ניסיון להוריד את הסרטון'}</p>
                        
                        <div class="error-details">
                            <p><strong>מזהה סרטון:</strong> <code>${videoId}</code></p>
                            <p><strong>פורמט שנבחר:</strong> ${format}</p>
                            <p><strong>מזהה בקשה:</strong> <code>${requestId}</code></p>
                            <p><strong>זמן השגיאה:</strong> ${new Date().toLocaleString('he-IL')}</p>
                        </div>
                        
                        <p>אפשר לנסות שוב עם פורמט אחר:</p>
                        <a href="/download?id=${videoId}&format=${format === 'audio' ? 'video' : 'audio'}" class="retry-btn">
                            נסה ב${format === 'audio' ? 'וידאו' : 'אודיו בלבד'}
                        </a>
                        <a href="/" class="back-btn">חזרה לדף הראשי</a>
                    </div>
                </body>
            </html>
        `);
    }
});

// Helper function to format file size
function formatFileSize(bytes) {
    if (!bytes || isNaN(bytes)) return 'Unknown';
    
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 Bytes';
    
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    if (i === 0) return bytes + ' ' + sizes[i];
    
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

// Fix missing rate limit cleanup function that was accidentally removed
// Clear rate limit counts every minute
setInterval(() => {
    console.log('Clearing rate limit counts');
    Object.keys(requestCounts).forEach(ip => {
        requestCounts[ip] = 0;
    });
}, RATE_LIMIT_WINDOW);

// Update the main page HTML to add a transcription option
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>YouTube Downloader & Transcriber</title>
                <style>
                    :root {
                        --primary-color: #c00;
                        --secondary-color: #222;
                        --accent-color: #f1f1f1;
                        --text-color: #333;
                        --light-text: #fff;
                        --border-radius: 6px;
                    }
                    
                    body {
                        font-family: 'Segoe UI', Roboto, Arial, sans-serif;
                        margin: 0;
                        padding: 0;
                        background-color: #f9f9f9;
                        color: var(--text-color);
                        line-height: 1.6;
                    }
                    
                    .header {
                        background-color: var(--primary-color);
                        color: var(--light-text);
                        text-align: center;
                        padding: 2rem 1rem;
                        margin-bottom: 2rem;
                    }
                    
                    .header h1 {
                        margin: 0;
                        font-size: 2.5rem;
                    }
                    
                    .container {
                        max-width: 800px;
                        margin: 0 auto;
                        padding: 0 1rem;
                    }
                    
                    .tab-container {
                        margin-bottom: 1rem;
                    }
                    
                    .tab-buttons {
                        display: flex;
                        border-bottom: 1px solid #ddd;
                        margin-bottom: 20px;
                    }
                    
                    .tab-button {
                        background-color: #f1f1f1;
                        border: none;
                        outline: none;
                        cursor: pointer;
                        padding: 12px 20px;
                        transition: background-color 0.3s;
                        font-weight: 600;
                        border-radius: 6px 6px 0 0;
                        margin-left: 5px;
                    }
                    
                    .tab-button:hover {
                        background-color: #ddd;
                    }
                    
                    .tab-button.active {
                        background-color: var(--primary-color);
                        color: white;
                    }
                    
                    .tab-content {
                        display: none;
                        animation: fadeIn 0.5s;
                    }
                    
                    .tab-content.active {
                        display: block;
                    }
                    
                    @keyframes fadeIn {
                        from { opacity: 0; }
                        to { opacity: 1; }
                    }
                    
                    .download-card {
                        background-color: white;
                        border-radius: var(--border-radius);
                        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
                        padding: 2rem;
                        margin-bottom: 2rem;
                    }
                    
                    .form-group {
                        margin-bottom: 1.5rem;
                    }
                    
                    label {
                        display: block;
                        margin-bottom: 0.5rem;
                        font-weight: 600;
                    }
                    
                    .input-url {
                        width: 100%;
                        padding: 0.75rem;
                        border: 1px solid #ddd;
                        border-radius: var(--border-radius);
                        font-size: 1rem;
                        direction: ltr;
                    }
                    
                    .radio-group {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 1rem;
                        margin-top: 0.5rem;
                    }
                    
                    .radio-option {
                        display: flex;
                        align-items: center;
                        background-color: var(--accent-color);
                        padding: 0.75rem 1rem;
                        border-radius: var(--border-radius);
                        cursor: pointer;
                        transition: background-color 0.2s;
                    }
                    
                    .radio-option:hover {
                        background-color: #e5e5e5;
                    }
                    
                    .radio-option input {
                        margin-right: 0.5rem;
                    }
                    
                    .submit-btn {
                        background-color: var(--primary-color);
                        color: white;
                        border: none;
                        padding: 0.75rem 2rem;
                        font-size: 1rem;
                        border-radius: var(--border-radius);
                        cursor: pointer;
                        transition: background-color 0.2s;
                        display: inline-block;
                        text-decoration: none;
                        text-align: center;
                    }
                    
                    .submit-btn:hover {
                        background-color: #900;
                    }
                    
                    .endpoints {
                        margin-top: 3rem;
                    }
                    
                    .endpoint {
                        background-color: white;
                        border-radius: var(--border-radius);
                        padding: 1.5rem;
                        margin-bottom: 1rem;
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                    }
                    
                    .method {
                        color: var(--primary-color);
                        font-weight: bold;
                        margin-right: 0.5rem;
                    }
                    
                    code {
                        background-color: var(--accent-color);
                        padding: 0.2rem 0.4rem;
                        border-radius: 3px;
                        font-family: 'Courier New', monospace;
                    }
                    
                    .note {
                        background-color: #feffdc;
                        border-left: 4px solid #ffeb3b;
                        padding: 1rem;
                        margin-top: 2rem;
                    }
                    
                    .preview {
                        display: none;
                        margin-top: 1.5rem;
                        border-top: 1px solid #eee;
                        padding-top: 1.5rem;
                    }
                    
                    .preview.active {
                        display: block;
                    }
                    
                    .video-info {
                        display: flex;
                        gap: 1rem;
                        margin-bottom: 1rem;
                    }
                    
                    .thumbnail {
                        width: 120px;
                        min-width: 120px;
                        border-radius: var(--border-radius);
                    }
                    
                    .error-message {
                        color: var(--primary-color);
                        background-color: rgba(255, 0, 0, 0.1);
                        padding: 1rem;
                        border-radius: var(--border-radius);
                        margin-top: 1rem;
                        display: none;
                    }
                    
                    .loading {
                        text-align: center;
                        padding: 2rem;
                        display: none;
                    }
                    
                    .spinner {
                        border: 4px solid rgba(0, 0, 0, 0.1);
                        border-radius: 50%;
                        border-top: 4px solid var(--primary-color);
                        width: 40px;
                        height: 40px;
                        animation: spin 1s linear infinite;
                        margin: 0 auto 1rem;
                    }
                    
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                    
                    .format-buttons {
                        display: flex;
                        gap: 10px;
                        margin-top: 20px;
                    }
                    
                    .format-button {
                        background-color: #2196F3;
                        color: white;
                        border: none;
                        padding: 8px 15px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 0.9rem;
                        transition: background-color 0.2s;
                    }
                    
                    .format-button:hover {
                        background-color: #0b7dda;
                    }
                    
                    .format-button.srt {
                        background-color: #4CAF50;
                    }
                    
                    .format-button.srt:hover {
                        background-color: #3e8e41;
                    }
                    
                    .format-button.txt {
                        background-color: #ff9800;
                    }
                    
                    .format-button.txt:hover {
                        background-color: #e68a00;
                    }
                    
                    .transcript-preview {
                        display: none;
                        margin-top: 20px;
                        background: #f8f8f8;
                        padding: 15px;
                        border-radius: 5px;
                        max-height: 200px;
                        overflow-y: auto;
                        font-family: Arial, sans-serif;
                        white-space: pre-wrap;
                        direction: ltr;
                        text-align: left;
                    }
                    
                    /* Responsive adjustments */
                    @media (max-width: 600px) {
                        .header h1 {
                            font-size: 2rem;
                        }
                        
                        .radio-group {
                            flex-direction: column;
                            gap: 0.5rem;
                        }
                        
                        .tab-buttons {
                            flex-direction: column;
                        }
                        
                        .tab-button {
                            border-radius: 0;
                            margin-left: 0;
                            margin-bottom: 2px;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>YouTube Downloader & Transcriber</h1>
                </div>
                
                <div class="container">
                    <div class="tab-container">
                        <div class="tab-buttons">
                            <button class="tab-button active" data-tab="download">הורדת וידאו</button>
                            <button class="tab-button" data-tab="transcribe">תמלול אודיו</button>
                        </div>
                        
                        <div class="tab-content active" id="download-tab">
                            <div class="download-card">
                                <form id="download-form" action="/process" method="GET">
                                    <div class="form-group">
                                        <label for="download-url">הדבק כתובת סרטון YouTube:</label>
                                        <input type="text" id="download-url" name="url" class="input-url" 
                                            placeholder="https://www.youtube.com/watch?v=..." required 
                                            dir="ltr">
                                    </div>
                                    
                                    <div class="form-group">
                                        <label>בחר פורמט להורדה:</label>
                                        <div class="radio-group">
                                            <label class="radio-option">
                                                <input type="radio" name="format" value="audio" checked>
                                                אודיו בלבד (MP3)
                                            </label>
                                            <label class="radio-option">
                                                <input type="radio" name="format" value="video">
                                                וידאו איכות גבוהה (MP4)
                                            </label>
                                            <label class="radio-option">
                                                <input type="radio" name="format" value="combined">
                                                וידאו + אודיו (MP4)
                                            </label>
                                        </div>
                                    </div>
                                    
                                    <button type="submit" class="submit-btn">הורד עכשיו</button>
                                </form>
                                
                                <div class="error-message" id="download-error-box"></div>
                                
                                <div class="loading" id="download-loading">
                                    <div class="spinner"></div>
                                    <p>מאתר פורמטים זמינים...</p>
                                </div>
                                
                                <div class="preview" id="download-preview">
                                    <h3>פרטי הסרטון:</h3>
                                    <div class="video-info">
                                        <img id="download-thumbnail" class="thumbnail" src="" alt="תמונה ממוזערת">
                                        <div>
                                            <h4 id="download-video-title"></h4>
                                            <p id="download-video-duration"></p>
                                        </div>
                                    </div>
                                    <a id="download-btn" class="submit-btn">התחל הורדה</a>
                                </div>
                            </div>
                        </div>
                        
                        <div class="tab-content" id="transcribe-tab">
                            <div class="download-card">
                                <form id="transcribe-form">
                                    <div class="form-group">
                                        <label for="transcribe-url">הדבק כתובת סרטון YouTube לתמלול:</label>
                                        <input type="text" id="transcribe-url" name="url" class="input-url" 
                                            placeholder="https://www.youtube.com/watch?v=..." required 
                                            dir="ltr">
                                    </div>
                                    
                                    <div class="form-group">
                                        <label>בחר פורמט לתמלול:</label>
                                        <div class="radio-group">
                                            <label class="radio-option">
                                                <input type="radio" name="transcribe-format" value="json" checked>
                                                JSON (כולל חותמות זמן)
                                            </label>
                                            <label class="radio-option">
                                                <input type="radio" name="transcribe-format" value="srt">
                                                SRT (כתוביות)
                                            </label>
                                            <label class="radio-option">
                                                <input type="radio" name="transcribe-format" value="txt">
                                                טקסט בלבד (TXT)
                                            </label>
                                        </div>
                                    </div>
                                    
                                    <button type="submit" class="submit-btn">תמלל עכשיו</button>
                                </form>
                                
                                <div class="error-message" id="transcribe-error-box"></div>
                                
                                <div class="loading" id="transcribe-loading">
                                    <div class="spinner"></div>
                                    <p>מבצע תמלול... תהליך זה עשוי להימשך מספר דקות</p>
                                </div>
                                
                                <div class="preview" id="transcribe-preview">
                                    <h3>תוצאות התמלול:</h3>
                                    <div class="video-info">
                                        <img id="transcribe-thumbnail" class="thumbnail" src="" alt="תמונה ממוזערת">
                                        <div>
                                            <h4 id="transcribe-video-title"></h4>
                                            <p id="transcribe-video-duration"></p>
                                        </div>
                                    </div>
                                    
                                    <div class="format-buttons">
                                        <a id="transcribe-json-btn" href="#" class="format-button json">הורד JSON</a>
                                        <a id="transcribe-srt-btn" href="#" class="format-button srt">הורד SRT</a>
                                        <a id="transcribe-txt-btn" href="#" class="format-button txt">הורד טקסט</a>
                                    </div>
                                    
                                    <div class="transcript-preview" id="transcript-text"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    
                    <div class="endpoints">
                        <h2>ממשקי API זמינים:</h2>
                        
                        <div class="endpoint">
                            <span class="method">GET</span>
                            <code>/youtube-info?id=YOUTUBE_VIDEO_ID</code>
                            <p>מחזיר פרטים על כל הפורמטים הזמינים לסרטון YouTube.</p>
                        </div>
                        
                        <div class="endpoint">
                            <span class="method">GET</span>
                            <code>/download?id=YOUTUBE_VIDEO_ID&format=audio|video|combined</code>
                            <p>מוריד סרטון YouTube בפורמט הנבחר.</p>
                        </div>
                        
                        <div class="endpoint">
                            <span class="method">GET</span>
                            <code>/transcribe?id=YOUTUBE_VIDEO_ID&format=json|srt|txt</code>
                            <p>מתמלל סרטון YouTube ומחזיר את התמלול בפורמט המבוקש.</p>
                        </div>
                        
                        <div class="endpoint">
                            <span class="method">GET</span>
                            <code>/proxy?url=URL</code>
                            <p>פרוקסי כללי להורדת קבצים.</p>
                        </div>
                    </div>
                    
                    <div class="note">
                        <p><strong>הערות:</strong></p>
                        <p>1. הגבלת קצב בתוקף. מקסימום ${RATE_LIMIT_MAX} בקשות לכל כתובת IP בכל ${RATE_LIMIT_WINDOW/1000} שניות.</p>
                        <p>2. תמלול עשוי להימשך מספר דקות, בהתאם לאורך הסרטון.</p>
                        <p>3. שרת זה נועד למטרות לימודיות בלבד.</p>
                    </div>
                </div>
                
                <script>
                    document.addEventListener('DOMContentLoaded', function() {
                        // Tab switching functionality
                        const tabButtons = document.querySelectorAll('.tab-button');
                        const tabContents = document.querySelectorAll('.tab-content');
                        
                        tabButtons.forEach(button => {
                            button.addEventListener('click', function() {
                                const tabId = this.getAttribute('data-tab');
                                
                                // Deactivate all tabs
                                tabButtons.forEach(btn => btn.classList.remove('active'));
                                tabContents.forEach(content => content.classList.remove('active'));
                                
                                // Activate the clicked tab
                                this.classList.add('active');
                                document.getElementById(tabId + '-tab').classList.add('active');
                            });
                        });
                        
                        // Download form functionality (similar to existing code)
                        const downloadForm = document.getElementById('download-form');
                        const downloadUrlInput = document.getElementById('download-url');
                        const downloadErrorBox = document.getElementById('download-error-box');
                        const downloadLoading = document.getElementById('download-loading');
                        const downloadPreview = document.getElementById('download-preview');
                        const downloadThumbnail = document.getElementById('download-thumbnail');
                        const downloadVideoTitle = document.getElementById('download-video-title');
                        const downloadVideoDuration = document.getElementById('download-video-duration');
                        const downloadBtn = document.getElementById('download-btn');
                        
                        downloadForm.addEventListener('submit', async function(e) {
                            e.preventDefault();
                            
                            // Hide any previous errors and preview
                            downloadErrorBox.style.display = 'none';
                            downloadPreview.classList.remove('active');
                            
                            const url = downloadUrlInput.value.trim();
                            if (!url) {
                                showError(downloadErrorBox, 'נא להזין כתובת YouTube תקפה');
                                return;
                            }
                            
                            // Extract video ID from URL
                            let videoId;
                            try {
                                videoId = extractVideoId(url);
                            } catch (error) {
                                showError(downloadErrorBox, error.message);
                                return;
                            }
                            
                            if (!videoId) {
                                showError(downloadErrorBox, 'לא ניתן לחלץ את מזהה הסרטון מהכתובת. נא לוודא שזוהי כתובת YouTube תקפה.');
                                return;
                            }
                            
                            // Show loading indicator
                            downloadLoading.style.display = 'block';
                            
                            try {
                                // Get video info
                                const response = await fetch(\`/youtube-info?id=\${videoId}\`);
                                if (!response.ok) {
                                    throw new Error(\`שגיאה בקבלת מידע על הסרטון: \${response.status} \${response.statusText}\`);
                                }
                                
                                const data = await response.json();
                                if (!data.success) {
                                    throw new Error(data.error || 'שגיאה לא ידועה בקבלת מידע על הסרטון');
                                }
                                
                                // Hide loading and show preview
                                downloadLoading.style.display = 'none';
                                
                                // Update preview with video info
                                downloadThumbnail.src = data.data.thumbnail || 'https://via.placeholder.com/120x68.png?text=No+Thumbnail';
                                downloadVideoTitle.textContent = data.data.title || 'סרטון ללא כותרת';
                                
                                // Format duration in seconds to MM:SS
                                const durationSeconds = data.data.duration || 0;
                                const minutes = Math.floor(durationSeconds / 60);
                                const seconds = Math.floor(durationSeconds % 60);
                                downloadVideoDuration.textContent = \`אורך: \${minutes}:\${seconds < 10 ? '0' : ''}\${seconds}\`;
                                
                                // Update download button
                                const format = document.querySelector('input[name="format"]:checked').value;
                                downloadBtn.href = \`/download?id=\${videoId}&format=\${format}\`;
                                
                                // Show preview
                                downloadPreview.classList.add('active');
                                
                            } catch (error) {
                                downloadLoading.style.display = 'none';
                                showError(downloadErrorBox, error.message);
                            }
                        });
                        
                        // Update download link when format changes
                        document.querySelectorAll('input[name="format"]').forEach(radio => {
                            radio.addEventListener('change', function() {
                                if (downloadPreview.classList.contains('active')) {
                                    const videoId = extractVideoId(downloadUrlInput.value);
                                    const format = document.querySelector('input[name="format"]:checked').value;
                                    downloadBtn.href = \`/download?id=\${videoId}&format=\${format}\`;
                                }
                            });
                        });
                        
                        // Transcribe form functionality
                        const transcribeForm = document.getElementById('transcribe-form');
                        const transcribeUrlInput = document.getElementById('transcribe-url');
                        const transcribeErrorBox = document.getElementById('transcribe-error-box');
                        const transcribeLoading = document.getElementById('transcribe-loading');
                        const transcribePreview = document.getElementById('transcribe-preview');
                        const transcribeThumbnail = document.getElementById('transcribe-thumbnail');
                        const transcribeVideoTitle = document.getElementById('transcribe-video-title');
                        const transcribeVideoDuration = document.getElementById('transcribe-video-duration');
                        const jsonBtn = document.getElementById('transcribe-json-btn');
                        const srtBtn = document.getElementById('transcribe-srt-btn');
                        const txtBtn = document.getElementById('transcribe-txt-btn');
                        const transcriptText = document.getElementById('transcript-text');
                        
                        transcribeForm.addEventListener('submit', async function(e) {
                            e.preventDefault();
                            
                            // Hide any previous errors and preview
                            transcribeErrorBox.style.display = 'none';
                            transcribePreview.classList.remove('active');
                            transcriptText.style.display = 'none';
                            
                            const url = transcribeUrlInput.value.trim();
                            if (!url) {
                                showError(transcribeErrorBox, 'נא להזין כתובת YouTube תקפה');
                                return;
                            }
                            
                            // Extract video ID from URL
                            let videoId;
                            try {
                                videoId = extractVideoId(url);
                            } catch (error) {
                                showError(transcribeErrorBox, error.message);
                                return;
                            }
                            
                            if (!videoId) {
                                showError(transcribeErrorBox, 'לא ניתן לחלץ את מזהה הסרטון מהכתובת. נא לוודא שזוהי כתובת YouTube תקפה.');
                                return;
                            }
                            
                            // Show loading indicator
                            transcribeLoading.style.display = 'block';
                            
                            try {
                                // First get video info for metadata
                                const infoResponse = await fetch(\`/youtube-info?id=\${videoId}\`);
                                if (!infoResponse.ok) {
                                    throw new Error(\`שגיאה בקבלת מידע על הסרטון: \${infoResponse.status} \${infoResponse.statusText}\`);
                                }
                                
                                const infoData = await infoResponse.json();
                                if (!infoData.success) {
                                    throw new Error(infoData.error || 'שגיאה לא ידועה בקבלת מידע על הסרטון');
                                }
                                
                                // Get selected format
                                const format = document.querySelector('input[name="transcribe-format"]:checked').value;
                                
                                // Call transcribe endpoint
                                const transcribeResponse = await fetch(\`/transcribe?id=\${videoId}&format=\${format}\`);
                                
                                if (!transcribeResponse.ok) {
                                    let errorMessage = \`שגיאה בתמלול: \${transcribeResponse.status} \${transcribeResponse.statusText}\`;
                                    try {
                                        const errorData = await transcribeResponse.json();
                                        if (errorData.error) {
                                            errorMessage = errorData.error;
                                        }
                                    } catch (e) {
                                        // If we can't parse the error, use the default message
                                    }
                                    throw new Error(errorMessage);
                                }
                                
                                // For txt and srt formats, we get back the raw content
                                if (format === 'txt' || format === 'srt') {
                                    const textData = await transcribeResponse.text();
                                    
                                    // Hide loading and show preview
                                    transcribeLoading.style.display = 'none';
                                    
                                    // Update preview with video info
                                    transcribeThumbnail.src = infoData.data.thumbnail || 'https://via.placeholder.com/120x68.png?text=No+Thumbnail';
                                    transcribeVideoTitle.textContent = infoData.data.title || 'סרטון ללא כותרת';
                                    
                                    // Format duration in seconds to MM:SS
                                    const durationSeconds = infoData.data.duration || 0;
                                    const minutes = Math.floor(durationSeconds / 60);
                                    const seconds = Math.floor(durationSeconds % 60);
                                    transcribeVideoDuration.textContent = \`אורך: \${minutes}:\${seconds < 10 ? '0' : ''}\${seconds}\`;
                                    
                                    // Show transcript preview
                                    transcriptText.textContent = textData.substring(0, 500) + (textData.length > 500 ? '...' : '');
                                    transcriptText.style.display = 'block';
                                    
                                    // Update download buttons
                                    jsonBtn.href = \`/transcribe?id=\${videoId}&format=json\`;
                                    srtBtn.href = \`/transcribe?id=\${videoId}&format=srt\`;
                                    txtBtn.href = \`/transcribe?id=\${videoId}&format=txt\`;
                                    
                                    // Show preview
                                    transcribePreview.classList.add('active');
                                } else {
                                    // For JSON format, we get back a JSON object
                                    const jsonData = await transcribeResponse.json();
                                    
                                    if (!jsonData.success) {
                                        throw new Error(jsonData.error || 'שגיאה לא ידועה בתמלול');
                                    }
                                    
                                    // Hide loading and show preview
                                    transcribeLoading.style.display = 'none';
                                    
                                    // Check if we have the traditional format (format=json) or the all format (format=all)
                                    const transcriptData = jsonData.data.formats ? jsonData.data.formats.txt : jsonData.data.transcript.text;
                                    
                                    // Update preview with video info
                                    transcribeThumbnail.src = infoData.data.thumbnail || 'https://via.placeholder.com/120x68.png?text=No+Thumbnail';
                                    transcribeVideoTitle.textContent = infoData.data.title || 'סרטון ללא כותרת';
                                    
                                    // Format duration in seconds to MM:SS
                                    const durationSeconds = infoData.data.duration || 0;
                                    const minutes = Math.floor(durationSeconds / 60);
                                    const seconds = Math.floor(durationSeconds % 60);
                                    transcribeVideoDuration.textContent = \`אורך: \${minutes}:\${seconds < 10 ? '0' : ''}\${seconds}\`;
                                    
                                    // Show transcript preview
                                    transcriptText.textContent = typeof transcriptData === 'string' ? 
                                        (transcriptData.substring(0, 500) + (transcriptData.length > 500 ? '...' : '')) : 
                                        'תמלול התקבל בהצלחה. לחץ על אחד מהכפתורים למטה כדי להוריד את התמלול בפורמט הרצוי.';
                                    transcriptText.style.display = 'block';
                                    
                                    // Update download buttons
                                    jsonBtn.href = \`/transcribe?id=\${videoId}&format=json\`;
                                    srtBtn.href = \`/transcribe?id=\${videoId}&format=srt\`;
                                    txtBtn.href = \`/transcribe?id=\${videoId}&format=txt\`;
                                    
                                    // Show preview
                                    transcribePreview.classList.add('active');
                                }
                                
                            } catch (error) {
                                transcribeLoading.style.display = 'none';
                                showError(transcribeErrorBox, error.message);
                            }
                        });
                        
                        // Helper function to show error messages
                        function showError(errorElement, message) {
                            errorElement.textContent = message;
                            errorElement.style.display = 'block';
                        }
                        
                        // Extract video ID from various YouTube URL formats
                        function extractVideoId(url) {
                            let videoId = null;
                            
                            // Check for standard youtube.com/watch?v= format
                            const watchRegex = /youtube\\.com\\/watch\\?v=([^&]+)/;
                            const watchMatch = url.match(watchRegex);
                            if (watchMatch) {
                                videoId = watchMatch[1];
                            }
                            
                            // Check for youtu.be/ format
                            const shortRegex = /youtu\\.be\\/([^?&]+)/;
                            const shortMatch = url.match(shortRegex);
                            if (shortMatch) {
                                videoId = shortMatch[1];
                            }
                            
                            // Check for youtube.com/v/ format
                            const vRegex = /youtube\\.com\\/v\\/([^?&]+)/;
                            const vMatch = url.match(vRegex);
                            if (vMatch) {
                                videoId = vMatch[1];
                            }
                            
                            // Check for youtube.com/embed/ format
                            const embedRegex = /youtube\\.com\\/embed\\/([^?&]+)/;
                            const embedMatch = url.match(embedRegex);
                            if (embedMatch) {
                                videoId = embedMatch[1];
                            }
                            
                            if (!videoId) {
                                throw new Error('פורמט URL לא נתמך. נא להשתמש בכתובת סטנדרטית של YouTube.');
                            }
                            
                            return videoId;
                        }
                    });
                </script>
            </body>
        </html>
    `);
});

// Custom 404 handler
app.use((req, res) => {
    console.log(`[404] No handler found for ${req.method} ${req.url}`);
    res.status(404).send(`
        <html>
            <head>
                <title>404 - Not Found</title>
                <meta charset="UTF-8">
                <style>
                    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 40px; padding: 0; background: #f0f0f0; }
                    h1 { color: #c00; font-size: 32px; }
                    .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    code { background: #f8f8f8; padding: 2px 6px; border-radius: 3px; font-family: monospace; border: 1px solid #ddd; }
                    .available-routes { margin-top: 20px; background: #f8f8f8; padding: 20px; border-radius: 8px; }
                    ul { padding-left: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>404 - Not Found</h1>
                    <p>The requested resource <code>${req.url}</code> was not found on this server.</p>
                    
                    <div class="available-routes">
                        <h2>Available Routes</h2>
                        <ul>
                            <li><code>GET /</code> - Home page</li>
                            <li><code>GET /proxy?url=URL</code> - Proxy endpoint</li>
                            <li><code>GET /youtube-info?id=VIDEO_ID</code> - Get video formats</li>
                            <li><code>GET /download?id=VIDEO_ID&format=audio|video|combined</code> - Download video</li>
                            <li><code>GET /transcribe?id=VIDEO_ID&format=json|srt|txt</code> - Transcribe video</li>
                            <li><code>GET /health</code> - Health check</li>
                            <li><code>GET /test-proxy?url=URL</code> - Test proxy</li>
                        </ul>
                    </div>
                </div>
            </body>
        </html>
    `);
});

// Default port listener
app.listen(PORT, () => {
    console.log('----------------------------------------------------');
    console.log(`Proxy server STARTED and listening on port ${PORT}`);
    console.log('Available routes:');
    console.log('  - GET /                                      Home page');
    console.log('  - GET /proxy?url=URL                         Proxy endpoint');
    console.log('  - GET /youtube-info?id=VIDEO_ID              Get video formats');
    console.log('  - GET /download?id=VIDEO_ID&format=FORMAT    Download video');
    console.log('  - GET /transcribe?id=VIDEO_ID&format=FORMAT  Transcribe video');
    console.log('  - GET /health                                Health check');
    console.log('  - GET /test-proxy?url=URL                    Test proxy');
    console.log('----------------------------------------------------');
});

// Add health check endpoint to verify server is running
app.get('/health', (req, res) => {
    console.log('Health check performed');
    return res.status(200).json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        endpoints: ['/proxy', '/youtube-info', '/transcribe', '/download']
    });
});

// Add debug endpoint to test proxy functionality
app.get('/test-proxy', async (req, res) => {
    const testUrl = req.query.url || 'https://www.google.com/favicon.ico';
    const requestId = Date.now().toString(36);
    
    console.log(`[${requestId}] Testing proxy with URL: ${testUrl}`);
    
    try {
        const proxyUrl = `http${req.secure ? 's' : ''}://${req.headers.host}/proxy?url=${encodeURIComponent(testUrl)}`;
        console.log(`[${requestId}] Constructed proxy URL: ${proxyUrl}`);
        
        const response = await fetch(proxyUrl);
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Proxy test failed: ${response.status} ${response.statusText}. Body: ${errorText}`);
        }
        
        const data = await response.buffer();
        
        res.json({
            success: true,
            url: testUrl,
            proxyUrl: proxyUrl,
            status: response.status,
            contentType: response.headers.get('content-type'),
            contentLength: data.length,
            message: `Successfully proxied ${data.length} bytes`
        });
    } catch (error) {
        console.error(`[${requestId}] Test proxy error:`, error);
        res.status(500).json({
            success: false,
            error: `Test failed: ${error.message}`
        });
    }
});

// Add transcribe endpoint that downloads audio and then transcribes it
app.get('/transcribe', async (req, res) => {
    const videoId = req.query.id;
    const format = req.query.format || 'json'; // 'json', 'srt', or 'txt'
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    if (!videoId) {
        return res.status(400).json({ 
            success: false,
            error: 'חסר פרמטר חובה: id (מזהה סרטון)',
            example: '/transcribe?id=YOUTUBE_VIDEO_ID&format=json|srt|txt'
        });
    }
    
    console.log(`[${requestId}] Transcription request for video ID: ${videoId}, format: ${format}`);
    
    try {
        // 1. Get video information using youtube-info endpoint
        const infoUrl = `http${req.secure ? 's' : ''}://${req.headers.host}/youtube-info?id=${videoId}`;
        console.log(`[${requestId}] Fetching video info from: ${infoUrl}`);
        
        const infoResponse = await fetch(infoUrl);
        if (!infoResponse.ok) {
            const errorText = await infoResponse.text();
            throw new Error(`שגיאה בקבלת מידע על הסרטון: ${infoResponse.status}. ${errorText}`);
        }
        
        const infoData = await infoResponse.json();
        if (!infoData.success || !infoData.data) {
            throw new Error('תגובה לא תקפה מנקודת הקצה של מידע הסרטון');
        }
        
        console.log(`[${requestId}] Successfully got video info. Looking for best audio format...`);
        
        // 2. Find the best audio format for transcription
        let audioUrl = null;
        let formatInfo = null;
        
        // Prefer audio-only formats first
        if (infoData.data.formats && infoData.data.formats.audio && infoData.data.formats.audio.length > 0) {
            // Get the first audio format (usually best quality)
            formatInfo = infoData.data.formats.audio[0];
            audioUrl = formatInfo.url;
            console.log(`[${requestId}] Selected audio-only format: ${formatInfo.quality || 'Unknown quality'}`);
        } 
        // Fallback to recommended audio
        else if (infoData.data.recommended && infoData.data.recommended.audio) {
            formatInfo = infoData.data.recommended.audio;
            audioUrl = formatInfo.url;
            console.log(`[${requestId}] Selected recommended audio format: ${formatInfo.quality || 'Unknown quality'}`);
        }
        // Fallback to combined format (will extract audio)
        else if (infoData.data.recommended && infoData.data.recommended.combined) {
            formatInfo = infoData.data.recommended.combined;
            audioUrl = formatInfo.url;
            console.log(`[${requestId}] No audio format found, using combined format: ${formatInfo.quality || 'Unknown quality'}`);
        }
        // Last resort: try any available format
        else if (infoData.data.formats && infoData.data.formats.video && infoData.data.formats.video.length > 0) {
            formatInfo = infoData.data.formats.video[0];
            audioUrl = formatInfo.url;
            console.log(`[${requestId}] No audio format found, using first available video format: ${formatInfo.quality || 'Unknown quality'}`);
        }
        
        if (!audioUrl) {
            throw new Error('לא נמצא פורמט אודיו מתאים לתמלול');
        }
        
        console.log(`[${requestId}] Audio URL found, now downloading to server...`);
        
        // 3. Download the audio file to the server
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) {
            throw new Error(`שגיאה בהורדת קובץ האודיו: ${audioResponse.status} ${audioResponse.statusText}`);
        }
        
        // Convert to buffer/blob
        const audioBuffer = await audioResponse.arrayBuffer();
        const audioBlob = Buffer.from(audioBuffer);
        
        // Save to a temporary file if needed
        const tempFileName = path.join(TEMP_DIR, `${videoId}_${Date.now()}.mp3`);
        fs.writeFileSync(tempFileName, audioBlob);
        console.log(`[${requestId}] Audio saved to temporary file: ${tempFileName} (${audioBlob.length} bytes)`);
        
        // 4. Prepare the form data for ElevenLabs API
        const formData = new FormData();
        // For Node.js form-data, we need to use the file path 
        formData.append('file', fs.createReadStream(tempFileName));
        formData.append('model_id', 'scribe_v1'); // ElevenLabs model
        formData.append('timestamps_granularity', 'word');
        formData.append('language', ''); // Auto-detect language
        
        // 5. Send to ElevenLabs for transcription
        console.log(`[${requestId}] Sending audio to ElevenLabs for transcription`);
        
        // Try ElevenLabs API with retries
        let transcriptionData;
        let apiRetries = 2; // Fewer retries for API to avoid excessive costs
        let apiDelay = 2000; // Start with 2 seconds
        let apiSuccess = false;
        
        for (let attempt = 1; attempt <= apiRetries + 1; attempt++) {
            try {
                console.log(`[${requestId}] ElevenLabs API attempt ${attempt}/${apiRetries + 1}`);
                
                const { response, data } = await sendMultipartFormRequest('https://api.elevenlabs.io/v1/speech-to-text', formData, {
                    'xi-api-key': ELEVENLABS_API_KEY
                });
                
                if (response.statusCode !== 200) {
                    // Log the error in more detail
                    console.error(`[${requestId}] ElevenLabs API error - status: ${response.statusCode}`);
                    const errorText = typeof data === 'string' ? data : JSON.stringify(data);
                    console.error(`[${requestId}] ElevenLabs error response: ${errorText}`);
                    throw new Error(`ElevenLabs API error: ${response.statusCode} ${response.statusMessage}`);
                }
                
                transcriptionData = data;
                apiSuccess = true;
                break; // Exit retry loop on success
            } catch (apiError) {
                console.error(`[${requestId}] ElevenLabs API attempt ${attempt} failed:`, apiError);
                
                if (attempt < apiRetries + 1) {
                    console.log(`[${requestId}] Waiting ${apiDelay}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, apiDelay));
                    apiDelay *= 2; // Exponential backoff
                } else {
                    throw new Error(`כל נסיונות התמלול נכשלו: ${apiError.message}`);
                }
            }
        }
        
        if (!apiSuccess || !transcriptionData) {
            throw new Error('שגיאה בתמלול - לא התקבלו נתונים מ-ElevenLabs');
        }
        
        console.log(`[${requestId}] Transcription successful, converting to requested format: ${format}`);
        
        // 6. Delete temporary file
        try {
            fs.unlinkSync(tempFileName);
            console.log(`[${requestId}] Removed temporary file ${tempFileName}`);
        } catch (deleteError) {
            console.warn(`[${requestId}] Could not delete temporary file: ${deleteError.message}`);
        }
        
        // 7. Process the transcription data based on the requested format
        if (format === 'json') {
            // Return raw JSON data from ElevenLabs
            res.json({
                success: true,
                data: {
                    videoId: videoId,
                    title: infoData.data.title || '',
                    duration: infoData.data.duration || 0,
                    transcript: transcriptionData,
                    language: transcriptionData.language || 'unknown'
                }
            });
        } else if (format === 'srt') {
            // Convert to SRT format
            let srtContent = "";
            let counter = 1;
            
            if (transcriptionData.words && Array.isArray(transcriptionData.words)) {
                // Group words into sentences or smaller chunks
                const chunks = [];
                let currentChunk = [];
                let currentDuration = 0;
                const MAX_CHUNK_DURATION = 5; // Max 5 seconds per subtitle
                
                for (const word of transcriptionData.words) {
                    currentChunk.push(word);
                    currentDuration = word.end - (currentChunk[0]?.start || 0);
                    
                    // If chunk is long enough or we hit punctuation, create a new chunk
                    if (currentDuration >= MAX_CHUNK_DURATION || 
                        word.text.match(/[.!?]$/) || 
                        currentChunk.length >= 15) {
                        
                        chunks.push([...currentChunk]);
                        currentChunk = [];
                        currentDuration = 0;
                    }
                }
                
                // Add any remaining words
                if (currentChunk.length > 0) {
                    chunks.push(currentChunk);
                }
                
                // Convert chunks to SRT
                for (const chunk of chunks) {
                    if (chunk.length > 0) {
                        const startTime = chunk[0].start;
                        const endTime = chunk[chunk.length - 1].end;
                        
                        const startSrt = formatSrtTime(startTime);
                        const endSrt = formatSrtTime(endTime);
                        
                        const text = chunk.map(w => w.text).join(' ')
                            .replace(/ ([.,!?:;])/g, '$1'); // Fix spacing before punctuation
                        
                        srtContent += `${counter}\n`;
                        srtContent += `${startSrt} --> ${endSrt}\n`;
                        srtContent += `${text}\n\n`;
                        
                        counter++;
                    }
                }
            }
            
            // Set content type to text and send SRT format
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="${videoId}.srt"`);
            res.send(srtContent);
        } else if (format === 'txt') {
            // Convert to plain text format - just the text
            let plainText = "";
            
            if (transcriptionData.text) {
                // If ElevenLabs provides full text, use it
                plainText = transcriptionData.text;
            } else if (transcriptionData.words && Array.isArray(transcriptionData.words)) {
                // Otherwise combine all words
                plainText = transcriptionData.words.map(w => w.text).join(' ')
                    .replace(/ ([.,!?:;])/g, '$1'); // Fix spacing before punctuation
            }
            
            // Set content type to text and send TXT format
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', `attachment; filename="${videoId}.txt"`);
            res.send(plainText);
        } else {
            throw new Error(`פורמט לא נתמך: ${format}. יש להשתמש ב-json, srt, או txt.`);
        }
        
    } catch (error) {
        console.error(`[${requestId}] Transcription error:`, error);
        
        // Return user-friendly error message
        res.status(500).json({
            success: false,
            error: `שגיאה בתמלול: ${error.message}`,
            requestId: requestId
        });
    }
});

// Helper function to format seconds to SRT time format (HH:MM:SS,mmm)
function formatSrtTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

// Helper function to send multipart form request
async function sendMultipartFormRequest(url, formData, headers = {}) {
    return new Promise((resolve, reject) => {
        // Get the form headers and add our custom headers
        const formHeaders = formData.getHeaders();
        const combinedHeaders = { ...formHeaders, ...headers };
        
        // Get the form data as a readable stream
        const dataStream = formData;
        
        // Parse the URL
        const parsedUrl = new URL(url);
        
        // Prepare the request options
        const options = {
            method: 'POST',
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            headers: combinedHeaders
        };
        
        // Choose http or https module based on the URL
        const httpModule = parsedUrl.protocol === 'https:' ? https : http;
        
        // Make the request
        const req = httpModule.request(options, (res) => {
            const chunks = [];
            
            res.on('data', (chunk) => {
                chunks.push(chunk);
            });
            
            res.on('end', () => {
                const responseBody = Buffer.concat(chunks).toString();
                let data;
                
                // Try to parse as JSON if possible
                try {
                    data = JSON.parse(responseBody);
                } catch (e) {
                    data = responseBody; // Otherwise keep as string
                }
                
                resolve({ response: res, data });
            });
        });
        
        req.on('error', (error) => {
            reject(error);
        });
        
        // Pipe the form data to the request
        formData.pipe(req);
    });
}