/**
 * Unsplash Cloudflare Worker
 * Serves random Unsplash images with intelligent caching
 */

export default {
  async fetch(request, env, ctx) {
    try {
      // Validate required bindings
      const bindingError = validateBindings(env);
      if (bindingError) {
        return bindingError;
      }

      // Parse request URL and validate parameters
      const url = new URL(request.url);
      const params = extractQueryParams(url);

      // Validate parameter combinations
      const validationError = validateParams(params);
      if (validationError) {
        return validationError;
      }

      // Generate cache key from parameters
      const cacheKey = generateCacheKey(params);

      // Check if cache exists
      const cacheMetadata = await getCacheMetadata(env, cacheKey);

      if (cacheMetadata) {
        // Cache hit - serve from R2
        return await handleCacheHit(env, ctx, cacheMetadata, params);
      } else {
        // Cache miss - fetch from Unsplash and populate cache
        return await handleCacheMiss(env, ctx, cacheKey, params);
      }
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    // Run cache cleanup on scheduled cron trigger
    console.log('Scheduled cache cleanup triggered at:', new Date(event.scheduledTime).toISOString());
    ctx.waitUntil(cleanupOldCache(env));
  }
};

/**
 * Validate that all required bindings are configured
 */
function validateBindings(env) {
  if (!env.UNSPLASH_CACHE) {
    return new Response('R2 bucket not configured', { status: 500 });
  }
  if (!env.UNSPLASH_CACHE_METADATA) {
    return new Response('KV namespace not configured', { status: 500 });
  }
  if (!env.UNSPLASH_ACCESS_KEY) {
    return new Response('Unsplash API key not configured', { status: 500 });
  }
  return null;
}

/**
 * Extract query parameters from URL
 */
function extractQueryParams(url) {
  return {
    collections: url.searchParams.get('collections') || null,
    topics: url.searchParams.get('topics') || null,
    query: url.searchParams.get('query') || null,
    width: url.searchParams.get('w') || null,
    height: url.searchParams.get('h') || null
  };
}

/**
 * Validate parameter combinations
 */
function validateParams(params) {
  // Collections or topics cannot be used with query parameter
  if ((params.collections || params.topics) && params.query) {
    return new Response('Cannot use collections/topics with query parameter', { status: 400 });
  }
  return null;
}

/**
 * Generate cache key from query parameters
 * Sorts parameters and values alphabetically for consistency
 * Includes dimensions to cache different sizes separately
 */
function generateCacheKey(params) {
  const parts = [];

  // Sort parameter names alphabetically (including width and height)
  const sortedKeys = ['collections', 'height', 'query', 'topics', 'width'].filter(key => params[key]);

  for (const key of sortedKeys) {
    const value = params[key];
    // Sort comma-separated values alphabetically (for collections, topics, query)
    if (key === 'collections' || key === 'topics' || key === 'query') {
      const sortedValue = value.split(',').sort().join(',');
      parts.push(`${key}=${sortedValue}`);
    } else {
      // For width and height, use as-is
      parts.push(`${key}=${value}`);
    }
  }

  return parts.length > 0 ? parts.join('&') : 'default';
}

/**
 * Get cache metadata from KV
 */
async function getCacheMetadata(env, cacheKey) {
  try {
    const metadata = await env.UNSPLASH_CACHE_METADATA.get(cacheKey, 'json');
    return metadata;
  } catch (error) {
    console.error('KV read error:', error);
    return null; // Treat as cache miss
  }
}

/**
 * Handle cache hit - serve image from R2
 */
async function handleCacheHit(env, ctx, metadata, params) {
  const currentIndex = metadata.next_index;
  const imageInfo = metadata.images[currentIndex];

  try {
    // Retrieve image from R2
    const r2Object = await env.UNSPLASH_CACHE.get(imageInfo.r2_key);

    if (!r2Object) {
      // Image missing from R2, fall back to cache miss
      console.error('Image missing from R2:', imageInfo.r2_key);
      return await handleCacheMiss(env, ctx, metadata.cache_key, params);
    }

    // Parse dimensions from cache key
    const dimensions = parseDimensionsFromCacheKey(metadata.cache_key);
    const category = extractCategoryFromCacheKey(metadata.cache_key);

    // Get file size
    const fileSize = r2Object.size || 0;
    const fileSizeKB = (fileSize / 1024).toFixed(2);
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);

    // Log information to Cloudflare console
    console.log('=== CACHE HIT ===');
    console.log('File Dimensions:', dimensions.width && dimensions.height ? `${dimensions.width}x${dimensions.height}` : 'auto');
    console.log('Source URL:', `https://unsplash.com/photos/${imageInfo.photo_id}`);
    console.log('File Size:', fileSize > 1024 * 1024 ? `${fileSizeMB} MB` : `${fileSizeKB} KB`, `(${fileSize} bytes)`);
    console.log('Unsplash Category:', category || '`random`');
    console.log('Photographer:', imageInfo.photographer);
    console.log('================');

    // Update metadata in background
    ctx.waitUntil(updateCacheMetadata(env, metadata));

    // Return image with metadata headers (visible in browser dev tools)
    return new Response(r2Object.body, {
      status: 200,
      headers: {
        'Content-Type': imageInfo.content_type,
        'X-Cache-Status': 'HIT',
        'X-Unsplash-Photographer': imageInfo.photographer,
        'X-Image-Width': dimensions.width || 'auto',
        'X-Image-Height': dimensions.height || 'auto',
        'X-Image-Source-URL': `https://unsplash.com/photos/${imageInfo.photo_id}`,
        'X-Image-File-Size': fileSize.toString(),
        'X-Image-File-Size-KB': fileSizeKB,
        'X-Image-File-Size-MB': fileSizeMB,
        'X-Unsplash-Category': category || 'random',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
  } catch (error) {
    console.error('R2 read error:', error);
    // Fall back to cache miss
    return await handleCacheMiss(env, ctx, metadata.cache_key, params);
  }
}

/**
 * Update cache metadata after serving an image
 */
async function updateCacheMetadata(env, metadata) {
  // Increment next_index (wrap to 0 after 9)
  metadata.next_index = (metadata.next_index + 1) % 10;
  metadata.served_count += 1;

  // Update last accessed timestamp
  metadata.last_accessed = Date.now();

  // Save updated metadata
  await env.UNSPLASH_CACHE_METADATA.put(metadata.cache_key, JSON.stringify(metadata));

  // Check if cache refresh is needed (every 8 images)
  if (metadata.served_count % 8 === 0) {
    await refreshCache(env, metadata);
  }
}

/**
 * Handle cache miss - fetch from Unsplash and populate cache
 */
async function handleCacheMiss(env, ctx, cacheKey, params) {
  try {
    // Fetch 11 images from Unsplash (1 to serve immediately + 10 to cache)
    const photos = await fetchUnsplashPhotos(env, params, 11);

    if (!photos || photos.length === 0) {
      return new Response('No images available', { status: 502 });
    }

    // Get first image for immediate response
    const firstPhoto = photos[0];
    const optimizedUrl = constructOptimizedUrl(firstPhoto.urls.raw, params.width, params.height);

    // Determine category
    const category = extractCategoryFromParams(params);

    // Log information to Cloudflare console
    console.log('=== CACHE MISS ===');
    console.log('File Dimensions:', params.width && params.height ? `${params.width}x${params.height}` : 'auto');
    console.log('Source URL:', `https://unsplash.com/photos/${firstPhoto.id}`);
    console.log('File Size:', 'Not available (redirect)');
    console.log('Unsplash Category:', category || 'random');
    console.log('Photographer:', firstPhoto.user.name);
    console.log('Fetched', photos.length, 'images from Unsplash');
    console.log('================');

    // Populate cache in background with images 1-10 (skip the first one we're serving)
    const photosToCache = photos.slice(1, 11); // Get images at indices 1-10
    ctx.waitUntil(populateCache(env, cacheKey, photosToCache, params.width, params.height));

    // Return 302 redirect to first image with metadata headers
    return new Response(null, {
      status: 302,
      headers: {
        'Location': optimizedUrl,
        'X-Cache-Status': 'MISS',
        'X-Unsplash-Photographer': firstPhoto.user.name,
        'X-Image-Width': params.width || 'auto',
        'X-Image-Height': params.height || 'auto',
        'X-Image-Source-URL': `https://unsplash.com/photos/${firstPhoto.id}`,
        'X-Image-File-Size': 'unknown',
        'X-Unsplash-Category': category || 'random',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
  } catch (error) {
    console.error('Cache miss error:', error);

    // Provide more helpful error messages
    if (error.message.includes('forbidden') || error.message.includes('403')) {
      return new Response(
        'Access forbidden. Your Unsplash API key may be a Demo key with limited access. ' +
        'Try using ?query=wallpaper instead of ?topics=wallpapers, or apply for Production API access at https://unsplash.com/oauth/applications',
        { status: 403 }
      );
    }

    if (error.message.includes('Rate limited')) {
      return new Response(
        'Rate limit exceeded. Please try again later.',
        { status: 503, headers: { 'Retry-After': '3600' } }
      );
    }

    return new Response('Bad Gateway: ' + error.message, { status: 502 });
  }
}

/**
 * Common topic slug to ID mappings
 * The Unsplash /photos/random endpoint requires topic IDs, not slugs
 */
const TOPIC_SLUG_TO_ID = {
  '3d': 'whIY33yKE84',
  '3d-renders': 'CDwuwXJAbEw',
  'animals': 'Jpg6Kidl-Hk',
  'architecture-interior': 'M8jVbLbTRws',
  'experimental': 'qPYsDzvJOYc',
  'fashion-beauty': 'S4MKLAsBB74',
  'film': 'hmenvQhUmxM',
  'flat': 'pIF7l5_hgxg',
  'hand-drawn': 'tthdwfNPCcw',
  'icons': 'FkTvWj0W5bo',
  'illustration-wallpapers': 'If65AuNOOxQ',
  'line-art': 'rNbj3NBAY_w',
  'nature': '6sMVjTLSkeQ',
  'patterns': 'upmleWZC83Y',
  'people': 'towJZFskpGg',
  'street-photography': 'xHxYTMHLgOc',
  'textures-patterns': 'iUIsnVtjB0Y',
  'travel': 'Fzo3zuOHN6w',
  'wallpapers': 'bo8jQKTaE0Y'
};

/**
 * Convert topic slugs to IDs
 * The Unsplash API /photos/random endpoint requires topic IDs, not slugs
 */
function convertTopicSlugsToIds(topicsParam) {
  if (!topicsParam) return null;

  // Split by comma in case multiple topics are provided
  const topics = topicsParam.split(',').map(t => t.trim());

  // Convert each topic slug to ID if it exists in our mapping
  // If not in mapping, assume it's already an ID and use as-is
  const topicIds = topics.map(topic => {
    const lowercaseTopic = topic.toLowerCase();
    return TOPIC_SLUG_TO_ID[lowercaseTopic] || topic;
  });

  return topicIds.join(',');
}

/**
 * Fetch random photos from Unsplash API
 */
async function fetchUnsplashPhotos(env, params, count) {
  const apiUrl = new URL('https://api.unsplash.com/photos/random');
  apiUrl.searchParams.set('client_id', env.UNSPLASH_ACCESS_KEY);
  apiUrl.searchParams.set('orientation', 'landscape');
  apiUrl.searchParams.set('count', count.toString());

  // Log incoming parameters for debugging
  console.log('fetchUnsplashPhotos called with params:', {
    collections: params.collections,
    topics: params.topics,
    query: params.query,
    width: params.width,
    height: params.height,
    count: count
  });

  // Add optional filter parameters
  if (params.collections) {
    apiUrl.searchParams.set('collections', params.collections);
    console.log('Added collections parameter:', params.collections);
  }
  if (params.topics) {
    // Convert topic slugs to IDs since the API requires IDs
    const topicIds = convertTopicSlugsToIds(params.topics);
    apiUrl.searchParams.set('topics', topicIds);
    console.log('Added topics parameter (original):', params.topics);
    console.log('Added topics parameter (converted to IDs):', topicIds);
  }
  if (params.query) {
    apiUrl.searchParams.set('query', params.query);
    console.log('Added query parameter:', params.query);
  }

  // Log the final API URL (with redacted key)
  const logUrl = apiUrl.toString().replace(env.UNSPLASH_ACCESS_KEY, 'REDACTED');
  console.log('Final Unsplash API URL:', logUrl);

  const response = await fetch(apiUrl.toString());

  // Handle rate limiting
  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') || '3600';
    throw new Error(`Rate limited. Retry after ${retryAfter} seconds`);
  }

  // Handle forbidden (usually Demo API key restrictions)
  if (response.status === 403) {
    throw new Error(`Access forbidden.`);
  }

  // Handle other errors
  if (!response.ok) {
    const errorBody = await response.text().catch(() => 'Unknown error');
    throw new Error(`Unsplash API error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  return await response.json();
}

/**
 * Construct optimized image URL with optional dimensions
 */
function constructOptimizedUrl(rawUrl, width, height) {
  const url = new URL(rawUrl);
  url.searchParams.set('auto', 'format');
  url.searchParams.set('q', '65');
  url.searchParams.set('cs', 'origin');
  url.searchParams.set('dpr', '3');

  // Add dimensions if provided
  if (width) {
    url.searchParams.set('w', width);
  }
  if (height) {
    url.searchParams.set('h', height);
  }

  return url.toString();
}

/**
 * Populate cache with images in background
 */
async function populateCache(env, cacheKey, photos, width = null, height = null) {
  const images = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    const r2Key = `${cacheKey}_${i}`;

    try {
      // Construct optimized URL with dimensions and fetch image
      const optimizedUrl = constructOptimizedUrl(photo.urls.raw, width, height);
      const imageResponse = await fetch(optimizedUrl);

      if (!imageResponse.ok) {
        console.error(`Failed to fetch image ${i}:`, imageResponse.status);
        continue;
      }

      // Verify content type
      const contentType = imageResponse.headers.get('Content-Type');
      if (!contentType || !contentType.startsWith('image/')) {
        console.error(`Invalid content type for image ${i}:`, contentType);
        continue;
      }

      // Store in R2
      await env.UNSPLASH_CACHE.put(r2Key, imageResponse.body, {
        httpMetadata: {
          contentType: contentType
        }
      });

      // Trigger download tracking for attribution
      await triggerDownloadTracking(env, photo);

      // Record metadata
      images.push({
        r2_key: r2Key,
        photographer: photo.user.name,
        photo_id: photo.id,
        content_type: contentType
      });
    } catch (error) {
      console.error(`Error caching image ${i}:`, error);
      // Continue with remaining images
    }
  }

  // Create and store cache metadata
  const metadata = {
    cache_key: cacheKey,
    total_images: images.length,
    next_index: 0,
    served_count: 0,
    last_accessed: Date.now(),
    images: images
  };

  await env.UNSPLASH_CACHE_METADATA.put(cacheKey, JSON.stringify(metadata));
}

/**
 * Refresh cache by replacing 8 oldest images
 */
async function refreshCache(env, metadata) {
  try {
    // Fetch 8 new images
    const params = parseCacheKey(metadata.cache_key);
    const photos = await fetchUnsplashPhotos(env, params, 8);

    if (!photos || photos.length === 0) {
      console.error('Failed to fetch images for cache refresh');
      return;
    }

    // Determine which indices to replace (the next 8 to be served)
    const startIndex = metadata.next_index;
    const indicesToReplace = [];
    for (let i = 0; i < 8; i++) {
      indicesToReplace.push((startIndex + i) % 10);
    }

    // Replace images
    for (let i = 0; i < Math.min(photos.length, 8); i++) {
      const photo = photos[i];
      const indexToReplace = indicesToReplace[i];
      const oldR2Key = metadata.images[indexToReplace].r2_key;
      const newR2Key = `${metadata.cache_key}_${indexToReplace}`;

      try {
        // Delete old image from R2
        await env.UNSPLASH_CACHE.delete(oldR2Key);

        // Parse dimensions from cache key if present
        const dimensions = parseDimensionsFromCacheKey(metadata.cache_key);

        // Fetch and store new image with same dimensions
        const optimizedUrl = constructOptimizedUrl(photo.urls.raw, dimensions.width, dimensions.height);
        const imageResponse = await fetch(optimizedUrl);

        if (!imageResponse.ok) {
          console.error(`Failed to fetch refresh image ${i}:`, imageResponse.status);
          continue;
        }

        const contentType = imageResponse.headers.get('Content-Type');
        if (!contentType || !contentType.startsWith('image/')) {
          console.error(`Invalid content type for refresh image ${i}:`, contentType);
          continue;
        }

        // Store in R2
        await env.UNSPLASH_CACHE.put(newR2Key, imageResponse.body, {
          httpMetadata: {
            contentType: contentType
          }
        });

        // Trigger download tracking
        await triggerDownloadTracking(env, photo);

        // Update metadata for this image
        metadata.images[indexToReplace] = {
          r2_key: newR2Key,
          photographer: photo.user.name,
          photo_id: photo.id,
          content_type: contentType
        };
      } catch (error) {
        console.error(`Error refreshing image ${i}:`, error);
        // Continue with remaining images
      }
    }

    // Reset served_count, keep next_index unchanged
    metadata.served_count = 0;

    // Save updated metadata
    await env.UNSPLASH_CACHE_METADATA.put(metadata.cache_key, JSON.stringify(metadata));
  } catch (error) {
    console.error('Cache refresh error:', error);
  }
}

/**
 * Parse cache key back into parameters
 */
function parseCacheKey(cacheKey) {
  if (cacheKey === 'default') {
    return { collections: null, topics: null, query: null, width: null, height: null };
  }

  const params = { collections: null, topics: null, query: null, width: null, height: null };
  const parts = cacheKey.split('&');

  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key && value) {
      params[key] = value;
    }
  }

  return params;
}

/**
 * Parse dimensions from cache key
 */
function parseDimensionsFromCacheKey(cacheKey) {
  const params = parseCacheKey(cacheKey);
  return {
    width: params.width || null,
    height: params.height || null
  };
}

/**
 * Extract category from cache key
 */
function extractCategoryFromCacheKey(cacheKey) {
  const params = parseCacheKey(cacheKey);
  return extractCategoryFromParams(params);
}

/**
 * Extract category from params
 */
function extractCategoryFromParams(params) {
  if (params.topics) {
    return `topics: ${params.topics}`;
  }
  if (params.query) {
    return `query: ${params.query}`;
  }
  if (params.collections) {
    return `collections: ${params.collections}`;
  }
  return 'random';
}

/**
 * Trigger Unsplash download tracking for attribution
 */
async function triggerDownloadTracking(env, photo) {
  try {
    if (photo.links && photo.links.download_location) {
      // Fire and forget - don't wait for response
      fetch(photo.links.download_location, {
        headers: {
          'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`
        }
      }).catch(error => {
        console.error('Download tracking error:', error);
      });
    }
  } catch (error) {
    console.error('Download tracking error:', error);
  }
}

/**
 * Clean up old cache entries that haven't been accessed in more than 2 weeks
 */
async function cleanupOldCache(env) {
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks in milliseconds
  const now = Date.now();

  let totalKeysChecked = 0;
  let totalKeysDeleted = 0;
  let totalR2ObjectsDeleted = 0;

  console.log('=== CACHE CLEANUP STARTED ===');
  console.log('Checking for cache entries older than 2 weeks...');

  try {
    // List all keys in KV namespace
    let cursor = undefined;
    let hasMore = true;

    while (hasMore) {
      const listResult = await env.UNSPLASH_CACHE_METADATA.list({ cursor });

      for (const key of listResult.keys) {
        totalKeysChecked++;

        try {
          // Get metadata for this key
          const metadata = await env.UNSPLASH_CACHE_METADATA.get(key.name, 'json');

          if (!metadata) {
            console.log(`Skipping key ${key.name} - no metadata found`);
            continue;
          }

          // Check if last_accessed exists and is older than 2 weeks
          if (metadata.last_accessed) {
            const age = now - metadata.last_accessed;

            if (age > TWO_WEEKS_MS) {
              console.log(`Deleting old cache entry: ${key.name} (last accessed ${Math.floor(age / (24 * 60 * 60 * 1000))} days ago)`);

              // Delete all R2 objects associated with this cache key
              if (metadata.images && Array.isArray(metadata.images)) {
                for (const image of metadata.images) {
                  try {
                    await env.UNSPLASH_CACHE.delete(image.r2_key);
                    totalR2ObjectsDeleted++;
                  } catch (error) {
                    console.error(`Error deleting R2 object ${image.r2_key}:`, error);
                  }
                }
              }

              // Delete the KV entry
              await env.UNSPLASH_CACHE_METADATA.delete(key.name);
              totalKeysDeleted++;
            }
          } else {
            // If no last_accessed timestamp, this is an old entry from before we added timestamps
            // We can either delete it or add a timestamp. Let's add a timestamp to give it a grace period
            console.log(`Adding last_accessed timestamp to legacy entry: ${key.name}`);
            metadata.last_accessed = now;
            await env.UNSPLASH_CACHE_METADATA.put(key.name, JSON.stringify(metadata));
          }
        } catch (error) {
          console.error(`Error processing key ${key.name}:`, error);
        }
      }

      hasMore = !listResult.list_complete;
      cursor = listResult.cursor;
    }

    console.log('=== CACHE CLEANUP COMPLETED ===');
    console.log(`Total keys checked: ${totalKeysChecked}`);
    console.log(`Total keys deleted: ${totalKeysDeleted}`);
    console.log(`Total R2 objects deleted: ${totalR2ObjectsDeleted}`);
    console.log('================================');
  } catch (error) {
    console.error('Cache cleanup error:', error);
  }
}

