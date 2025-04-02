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

// Improve the download endpoint with better error handling
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
        
        // Select the appropriate format
        let downloadUrl;
        let filename;
        let size = 'unknown';
        let qualityInfo = '';
        
        if (format === 'audio') {
            if (infoData.data.recommended && infoData.data.recommended.audio && infoData.data.recommended.audio.url) {
                downloadUrl = infoData.data.recommended.audio.url;
                const ext = infoData.data.recommended.audio.ext || 'mp3';
                filename = `${infoData.data.title || videoId}_audio.${ext}`;
                
                if (infoData.data.recommended.audio.size) {
                    size = formatFileSize(infoData.data.recommended.audio.size);
                }
                if (infoData.data.recommended.audio.quality) {
                    qualityInfo = infoData.data.recommended.audio.quality;
                }
            } else {
                console.error(`[${requestId}] No audio format available in data:`, infoData);
                throw new Error('לא נמצא פורמט אודיו זמין לסרטון זה');
            }
        } else if (format === 'video') {
            if (infoData.data.recommended && infoData.data.recommended.video && infoData.data.recommended.video.url) {
                downloadUrl = infoData.data.recommended.video.url;
                const ext = infoData.data.recommended.video.ext || 'mp4';
                filename = `${infoData.data.title || videoId}_video.${ext}`;
                
                if (infoData.data.recommended.video.size) {
                    size = formatFileSize(infoData.data.recommended.video.size);
                }
                if (infoData.data.recommended.video.quality) {
                    qualityInfo = infoData.data.recommended.video.quality;
                }
            } else {
                console.error(`[${requestId}] No video format available in data:`, infoData);
                throw new Error('לא נמצא פורמט וידאו זמין לסרטון זה');
            }
        } else { // combined
            if (infoData.data.recommended && infoData.data.recommended.combined && infoData.data.recommended.combined.url) {
                downloadUrl = infoData.data.recommended.combined.url;
                const ext = infoData.data.recommended.combined.ext || 'mp4';
                filename = `${infoData.data.title || videoId}.${ext}`;
                
                if (infoData.data.recommended.combined.size) {
                    size = formatFileSize(infoData.data.recommended.combined.size);
                }
                if (infoData.data.recommended.combined.quality) {
                    qualityInfo = infoData.data.recommended.combined.quality;
                }
            } else {
                console.error(`[${requestId}] No combined format available in data:`, infoData);
                throw new Error('לא נמצא פורמט משולב זמין לסרטון זה');
            }
        }
        
        if (!downloadUrl) {
            console.error(`[${requestId}] Could not find a suitable download URL for format: ${format}`);
            throw new Error(`לא נמצאה כתובת הורדה מתאימה עבור הפורמט: ${format}`);
        }
        
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
        
        // Clean filename
        filename = filename.replace(/[<>:"/\\|?*]+/g, '_');
        
        // Log download details
        console.log(`[${requestId}] Download details:
            Title: ${infoData.data.title || 'Unknown'}
            Format: ${format}
            Filename: ${filename}
            Size: ${size}
            Quality: ${qualityInfo}
            URL length: ${downloadUrl.length} chars
            Expires: ${downloadUrl.includes('expire=') ? 'Yes (YouTube time-limited URL)' : 'No'}
        `);
        
        // Set headers for file download
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        
        console.log(`[${requestId}] Redirecting to download URL for ${format} format`);
        
        // Redirect to the actual file for download
        return res.redirect(302, downloadUrl);
        
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

// Update landing page to include a user-friendly form
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>YouTube Downloader</title>
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
                    
                    /* Responsive adjustments */
                    @media (max-width: 600px) {
                        .header h1 {
                            font-size: 2rem;
                        }
                        
                        .radio-group {
                            flex-direction: column;
                            gap: 0.5rem;
                        }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>YouTube Downloader</h1>
                </div>
                
                <div class="container">
                    <div class="download-card">
                        <form id="download-form" action="/process" method="GET">
                            <div class="form-group">
                                <label for="url">הדבק כתובת סרטון YouTube:</label>
                                <input type="text" id="url" name="url" class="input-url" 
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
                        
                        <div class="error-message" id="error-box"></div>
                        
                        <div class="loading" id="loading">
                            <div class="spinner"></div>
                            <p>מאתר פורמטים זמינים...</p>
                        </div>
                        
                        <div class="preview" id="preview">
                            <h3>פרטי הסרטון:</h3>
                            <div class="video-info">
                                <img id="thumbnail" class="thumbnail" src="" alt="תמונה ממוזערת">
                                <div>
                                    <h4 id="video-title"></h4>
                                    <p id="video-duration"></p>
                                </div>
                            </div>
                            <a id="download-btn" class="submit-btn">התחל הורדה</a>
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
                            <code>/proxy?url=URL</code>
                            <p>פרוקסי כללי להורדת קבצים.</p>
                        </div>
                    </div>
                    
                    <div class="note">
                        <p><strong>הערה:</strong> הגבלת קצב בתוקף. מקסימום ${RATE_LIMIT_MAX} בקשות לכל כתובת IP בכל ${RATE_LIMIT_WINDOW/1000} שניות.</p>
                        <p>שרת זה נועד למטרות לימודיות בלבד.</p>
                    </div>
                </div>
                
                <script>
                    document.addEventListener('DOMContentLoaded', function() {
                        const form = document.getElementById('download-form');
                        const urlInput = document.getElementById('url');
                        const errorBox = document.getElementById('error-box');
                        const loading = document.getElementById('loading');
                        const preview = document.getElementById('preview');
                        const thumbnail = document.getElementById('thumbnail');
                        const videoTitle = document.getElementById('video-title');
                        const videoDuration = document.getElementById('video-duration');
                        const downloadBtn = document.getElementById('download-btn');
                        
                        form.addEventListener('submit', async function(e) {
                            e.preventDefault();
                            
                            // Hide any previous errors and preview
                            errorBox.style.display = 'none';
                            preview.classList.remove('active');
                            
                            const url = urlInput.value.trim();
                            if (!url) {
                                showError('נא להזין כתובת YouTube תקפה');
                                return;
                            }
                            
                            // Extract video ID from URL
                            let videoId;
                            try {
                                videoId = extractVideoId(url);
                            } catch (error) {
                                showError(error.message);
                                return;
                            }
                            
                            if (!videoId) {
                                showError('לא ניתן לחלץ את מזהה הסרטון מהכתובת. נא לוודא שזוהי כתובת YouTube תקפה.');
                                return;
                            }
                            
                            // Show loading indicator
                            loading.style.display = 'block';
                            
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
                                loading.style.display = 'none';
                                
                                // Update preview with video info
                                thumbnail.src = data.data.thumbnail || 'https://via.placeholder.com/120x68.png?text=No+Thumbnail';
                                videoTitle.textContent = data.data.title || 'סרטון ללא כותרת';
                                
                                // Format duration in seconds to MM:SS
                                const durationSeconds = data.data.duration || 0;
                                const minutes = Math.floor(durationSeconds / 60);
                                const seconds = Math.floor(durationSeconds % 60);
                                videoDuration.textContent = \`אורך: \${minutes}:\${seconds < 10 ? '0' : ''}\${seconds}\`;
                                
                                // Update download button
                                const format = document.querySelector('input[name="format"]:checked').value;
                                downloadBtn.href = \`/download?id=\${videoId}&format=\${format}\`;
                                
                                // Show preview
                                preview.classList.add('active');
                                
                            } catch (error) {
                                loading.style.display = 'none';
                                showError(error.message);
                            }
                        });
                        
                        // Update download link when format changes
                        document.querySelectorAll('input[name="format"]').forEach(radio => {
                            radio.addEventListener('change', function() {
                                if (preview.classList.contains('active')) {
                                    const videoId = extractVideoId(urlInput.value);
                                    const format = document.querySelector('input[name="format"]:checked').value;
                                    downloadBtn.href = \`/download?id=\${videoId}&format=\${format}\`;
                                }
                            });
                        });
                        
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
                        
                        function showError(message) {
                            errorBox.textContent = message;
                            errorBox.style.display = 'block';
                        }
                    });
                </script>
            </body>
        </html>
    `);
});

// Custom 404 handler
app.use((req, res) => {
    res.status(404).send('Resource not found');
});

// Add a route to handle form submission
app.get('/process', (req, res) => {
    const url = req.query.url;
    const format = req.query.format || 'combined';
    
    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    
    try {
        // Extract video ID from the URL
        let videoId = null;
        
        // Check for standard youtube.com/watch?v= format
        const watchRegex = /youtube\.com\/watch\?v=([^&]+)/;
        const watchMatch = url.match(watchRegex);
        if (watchMatch) {
            videoId = watchMatch[1];
        }
        
        // Check for youtu.be/ format
        const shortRegex = /youtu\.be\/([^?&]+)/;
        const shortMatch = url.match(shortRegex);
        if (shortMatch) {
            videoId = shortMatch[1];
        }
        
        // Check for youtube.com/v/ format
        const vRegex = /youtube\.com\/v\/([^?&]+)/;
        const vMatch = url.match(vRegex);
        if (vMatch) {
            videoId = vMatch[1];
        }
        
        // Check for youtube.com/embed/ format
        const embedRegex = /youtube\.com\/embed\/([^?&]+)/;
        const embedMatch = url.match(embedRegex);
        if (embedMatch) {
            videoId = embedMatch[1];
        }
        
        if (!videoId) {
            return res.status(400).send(`
                <html>
                    <head>
                        <title>שגיאה - פורמט לא חוקי</title>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 0; background: #f0f0f0; }
                            .container { max-width: 600px; margin: 100px auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                            h1 { color: #c00; margin-top: 0; }
                            .back-btn { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #c00; color: white; text-decoration: none; border-radius: 4px; }
                            .back-btn:hover { background: #900; }
                            .error-details { background: #ffe6e6; padding: 15px; border-radius: 4px; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <h1>פורמט URL לא חוקי</h1>
                            <p>לא ניתן לחלץ את מזהה הסרטון מהכתובת שהוזנה.</p>
                            <div class="error-details">
                                <p><strong>כתובת שהוזנה:</strong> ${url}</p>
                                <p>נא להשתמש בכתובת סטנדרטית של YouTube בפורמט אחד מהבאים:</p>
                                <ul>
                                    <li>https://www.youtube.com/watch?v=VIDEO_ID</li>
                                    <li>https://youtu.be/VIDEO_ID</li>
                                    <li>https://www.youtube.com/embed/VIDEO_ID</li>
                                </ul>
                            </div>
                            <a href="/" class="back-btn">חזרה לדף הראשי</a>
                        </div>
                    </body>
                </html>
            `);
        }
        
        // Redirect to download endpoint with the extracted video ID
        return res.redirect(`/download?id=${videoId}&format=${format}`);
    } catch (error) {
        console.error('Process error:', error);
        return res.status(500).json({ error: `Failed to process URL: ${error.message}` });
    }
});

// Add a YouTube info endpoint that accepts a URL
app.get('/youtube-info-by-url', async (req, res) => {
    const videoUrl = req.query.url;
    
    if (!videoUrl) {
        return res.status(400).json({ 
            error: 'Missing required parameter: url',
            example: '/youtube-info-by-url?url=https://www.youtube.com/watch?v=VIDEOID'
        });
    }
    
    try {
        // Extract video ID from the URL
        let videoId = null;
        
        // Check various YouTube URL formats
        const watchRegex = /youtube\.com\/watch\?v=([^&]+)/;
        const shortRegex = /youtu\.be\/([^?&]+)/;
        const vRegex = /youtube\.com\/v\/([^?&]+)/;
        const embedRegex = /youtube\.com\/embed\/([^?&]+)/;
        
        const watchMatch = videoUrl.match(watchRegex);
        const shortMatch = videoUrl.match(shortRegex);
        const vMatch = videoUrl.match(vRegex);
        const embedMatch = videoUrl.match(embedRegex);
        
        if (watchMatch) videoId = watchMatch[1];
        else if (shortMatch) videoId = shortMatch[1];
        else if (vMatch) videoId = vMatch[1];
        else if (embedMatch) videoId = embedMatch[1];
        
        if (!videoId) {
            return res.status(400).json({ 
                error: 'Could not extract video ID from the provided URL',
                url: videoUrl
            });
        }
        
        // Redirect to the youtube-info endpoint with the extracted ID
        res.redirect(`/youtube-info?id=${videoId}`);
        
    } catch (error) {
        console.error('YouTube info by URL error:', error);
        res.status(500).json({
            success: false,
            error: `Failed to process URL: ${error.message}`
        });
    }
});

app.listen(PORT, () => {
    console.log(`Proxy server listening on port ${PORT}`);
}); 