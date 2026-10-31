const NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - Not Found</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #111;
      color: #888;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .container { text-align: center; }
    h1 { font-size: 6rem; color: #333; margin-bottom: 1rem; }
    p { font-size: 1.2rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>404</h1>
    <p>The requested resource could not be found.</p>
  </div>
</body>
</html>`;
const AUTOSIZE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>body{margin:0;background:#111;min-height:100vh;}</style>
</head>
<body>
  <script>
    const url = new URL(location.href);
    url.searchParams.delete('autosize');
    url.searchParams.set('w', innerWidth);
    url.searchParams.set('h', innerHeight);
    url.searchParams.set('dpr', devicePixelRatio || 1);
    location.replace(url);
  </script>
</body>
</html>`;
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const blockedPaths = ["/favicon.ico", "/robots.txt", "/.well-known", "/apple-touch-icon.png"];
      if (blockedPaths.some((path) => url.pathname.startsWith(path)) || url.pathname !== "/") {
        return new Response(null, { status: 404 });
      }
      if (url.searchParams.get("auth") !== "true") {
        return new Response(NOT_FOUND_HTML, {
          status: 404,
          headers: { "Content-Type": "text/html" }
        });
      }
      if (url.searchParams.get("autosize") === "html") {
        return new Response(AUTOSIZE_HTML, {
          status: 200,
          headers: { "Content-Type": "text/html" }
        });
      }
      const viewportWidth = request.headers.get("Sec-CH-Viewport-Width");
      const viewportHeight = request.headers.get("Sec-CH-Viewport-Height");
      const viewportDPR = request.headers.get("Sec-CH-DPR");
      const bindingError = validateBindings(env);
      if (bindingError) {
        return bindingError;
      }
      const params = extractQueryParams(url);
      if (params.autosize === "headers" && viewportWidth && viewportHeight) {
        params.width = viewportWidth;
        params.height = viewportHeight;
        params.fit = "scale";
        if (viewportDPR) {
          params.dpr = viewportDPR;
        }
      }
      const validationError = validateParams(params);
      if (validationError) {
        return validationError;
      }
      const cacheKey = generateCacheKey(params);
      const cacheMetadata = await getCacheMetadata(env, cacheKey);
      if (cacheMetadata) {
        return await handleCacheHit(env, ctx, cacheMetadata, params);
      } else {
        return await handleCacheMiss(env, ctx, cacheKey, params);
      }
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    console.log("Scheduled cache cleanup triggered at:", new Date(event.scheduledTime).toISOString());
    ctx.waitUntil(cleanupOldCache(env));
  }
};
function validateBindings(env) {
  if (!env.UNSPLASH_CACHE) {
    return new Response("R2 bucket not configured", { status: 500 });
  }
  if (!env.UNSPLASH_CACHE_METADATA) {
    return new Response("KV namespace not configured", { status: 500 });
  }
  if (!env.UNSPLASH_ACCESS_KEY) {
    return new Response("Unsplash API key not configured", { status: 500 });
  }
  return null;
}
function extractQueryParams(url) {
  const enhanceParam = url.searchParams.get("enhance");
  const enhance = enhanceParam === "false" ? false : true;
  const fitParam = url.searchParams.get("fit");
  const validFitValues = ["clamp", "clip", "crop", "scale"];
  const fit = validFitValues.includes(fitParam) ? fitParam : "clip";
  const autosizeParam = url.searchParams.get("autosize");
  const autosize = ["headers", "html"].includes(autosizeParam) ? autosizeParam : null;
  const orientationParam = url.searchParams.get("orientation");
  const validOrientations = ["auto", "landscape", "portrait"];
  const orientation = validOrientations.includes(orientationParam) ? orientationParam : null;
  return {
    collections: url.searchParams.get("collections") || null,
    topics: url.searchParams.get("topics") || null,
    query: url.searchParams.get("query") || null,
    width: url.searchParams.get("w") || url.searchParams.get("width") || null,
    height: url.searchParams.get("h") || url.searchParams.get("height") || null,
    enhance,
    fit,
    autosize,
    orientation
  };
}
function validateParams(params) {
  if ((params.collections || params.topics) && params.query) {
    return new Response("Cannot use collections/topics with query parameter", { status: 400 });
  }
  return null;
}
function generateCacheKey(params) {
  const parts = [];
  const cacheParams = {
    collections: params.collections,
    topics: params.topics,
    query: params.query,
    width: params.width,
    height: params.height,
    orientation: params.orientation,
    enhance: params.enhance === false ? "false" : "true",
    fit: params.fit || "clip"
  };
  const sortedKeys = Object.keys(cacheParams).filter((key) => cacheParams[key]).sort();
  for (const key of sortedKeys) {
    const value = cacheParams[key];
    if (key === "collections" || key === "topics" || key === "query") {
      const sortedValue = String(value).split(",").sort().join(",");
      parts.push(`${key}=${sortedValue}`);
    } else {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.length > 0 ? parts.join("&") : "default";
}
async function getCacheMetadata(env, cacheKey) {
  try {
    const metadata = await env.UNSPLASH_CACHE_METADATA.get(cacheKey, "json");
    return metadata;
  } catch (error) {
    console.error("KV read error:", error);
    return null;
  }
}
async function handleCacheHit(env, ctx, metadata, params) {
  const currentIndex = metadata.next_index;
  const imageInfo = metadata.images[currentIndex];
  try {
    const r2Object = await env.UNSPLASH_CACHE.get(imageInfo.r2_key);
    if (!r2Object) {
      console.error("Image missing from R2:", imageInfo.r2_key);
      return await handleCacheMiss(env, ctx, metadata.cache_key, params);
    }
    const dimensions = parseDimensionsFromCacheKey(metadata.cache_key);
    const category = extractCategoryFromCacheKey(metadata.cache_key);
    const fileSize = r2Object.size || 0;
    const fileSizeKB = (fileSize / 1024).toFixed(2);
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(2);
    console.log(
      "CACHE HIT",
      JSON.stringify({
        dimensions: dimensions.width && dimensions.height ? `${dimensions.width}x${dimensions.height}` : "auto",
        sourceUrl: `https://unsplash.com/photos/${imageInfo.photo_id}`,
        fileSize: fileSize > 1024 * 1024 ? `${fileSizeMB} MB` : `${fileSizeKB} KB`,
        category: category || "random",
        photographer: imageInfo.photographer
      })
    );
    ctx.waitUntil(updateCacheMetadata(env, metadata));
    return new Response(r2Object.body, {
      status: 200,
      headers: {
        "Content-Type": imageInfo.content_type,
        "X-Cache-Status": "HIT",
        "X-Unsplash-Photographer": imageInfo.photographer,
        "X-Unsplash-Parameters": category || "random",
        "X-Image-Dimensions": `${dimensions.width}x${dimensions.height}` || "auto",
        "X-Image-Source-URL": `https://unsplash.com/photos/${imageInfo.photo_id}`,
        "X-Image-File-Size": `${fileSizeMB} MB`,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Accept-CH": "Sec-CH-Viewport-Width, Sec-CH-Viewport-Height, Sec-CH-DPR",
        "Critical-CH": "Sec-CH-Viewport-Width, Sec-CH-Viewport-Height"
      }
    });
  } catch (error) {
    console.error("R2 read error:", error);
    return await handleCacheMiss(env, ctx, metadata.cache_key, params);
  }
}
async function updateCacheMetadata(env, metadata) {
  metadata.next_index = (metadata.next_index + 1) % 29;
  metadata.served_count += 1;
  metadata.last_accessed = Date.now();
  await env.UNSPLASH_CACHE_METADATA.put(metadata.cache_key, JSON.stringify(metadata));
  if (metadata.served_count % 27 === 0) {
    await refreshCache(env, metadata);
  }
}
async function handleCacheMiss(env, ctx, cacheKey, params) {
  try {
    const photos = await fetchUnsplashPhotos(env, params, 30);
    if (!photos || photos.length === 0) {
      return new Response("No images available", { status: 502 });
    }
    const firstPhoto = photos[0];
    const optimizedUrl = constructOptimizedUrl(firstPhoto.urls.raw, params);
    const category = extractCategoryFromParams(params);
    console.log(
      "CACHE MISS",
      JSON.stringify({
        dimensions: params.width && params.height ? `${params.width}x${params.height}` : "auto",
        sourceUrl: `https://unsplash.com/photos/${firstPhoto.id}`,
        category: category || "random",
        photographer: firstPhoto.user.name,
        fetchedCount: photos.length
      })
    );
    const photosToCache = photos.slice(1);
    ctx.waitUntil(populateCache(env, cacheKey, photosToCache, params));
    return new Response(null, {
      status: 302,
      headers: {
        Location: optimizedUrl,
        "X-Cache-Status": "MISS",
        "X-Unsplash-Photographer": firstPhoto.user.name,
        "X-Unsplash-Parameters": category || "random",
        "X-Image-Dimensions": `${params.width}x${params.height}` || "auto",
        "X-Image-Source-URL": `https://unsplash.com/photos/${firstPhoto.id}`,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Accept-CH": "Sec-CH-Viewport-Width, Sec-CH-Viewport-Height, Sec-CH-DPR",
        "Critical-CH": "Sec-CH-Viewport-Width, Sec-CH-Viewport-Height"
      }
    });
  } catch (error) {
    console.error("Cache miss error:", error);
    if (error.message.includes("forbidden") || error.message.includes("403")) {
      return new Response("Access forbidden. Check status of Unsplash API key", { status: 403 });
    }
    if (error.message.includes("Rate limited")) {
      return new Response("Rate limit exceeded. Please try again later.", { status: 503, headers: { "Retry-After": "3600" } });
    }
    return new Response("Bad Gateway: " + error.message, { status: 502 });
  }
}
const TOPIC_SLUG_TO_ID = {
  "3d": "whIY33yKE84",
  "3d-renders": "CDwuwXJAbEw",
  animals: "Jpg6Kidl-Hk",
  "architecture-interior": "M8jVbLbTRws",
  experimental: "qPYsDzvJOYc",
  "fashion-beauty": "S4MKLAsBB74",
  film: "hmenvQhUmxM",
  flat: "pIF7l5_hgxg",
  "hand-drawn": "tthdwfNPCcw",
  icons: "FkTvWj0W5bo",
  "illustration-wallpapers": "If65AuNOOxQ",
  "line-art": "rNbj3NBAY_w",
  nature: "6sMVjTLSkeQ",
  patterns: "upmleWZC83Y",
  people: "towJZFskpGg",
  "street-photography": "xHxYTMHLgOc",
  "textures-patterns": "iUIsnVtjB0Y",
  travel: "Fzo3zuOHN6w",
  wallpapers: "bo8jQKTaE0Y"
};
function convertTopicSlugsToIds(topicsParam) {
  if (!topicsParam) return null;
  const topics = topicsParam.split(",").map((t) => t.trim());
  const topicIds = topics.map((topic) => {
    const lowercaseTopic = topic.toLowerCase();
    return TOPIC_SLUG_TO_ID[lowercaseTopic] || topic;
  });
  return topicIds.join(",");
}
async function fetchUnsplashPhotos(env, params, count) {
  const apiUrl = new URL("https://api.unsplash.com/photos/random");
  apiUrl.searchParams.set("client_id", env.UNSPLASH_ACCESS_KEY);
  apiUrl.searchParams.set("count", count.toString());
  if (params.orientation === "auto" && params.width && params.height) {
    const w = parseInt(params.width, 10);
    const h = parseInt(params.height, 10);
    if (w > h) {
      apiUrl.searchParams.set("orientation", "landscape");
    } else if (w < h) {
      apiUrl.searchParams.set("orientation", "portrait");
    } else {
      apiUrl.searchParams.set("orientation", "squarish");
    }
  } else if (params.orientation === "landscape" || params.orientation === "portrait") {
    apiUrl.searchParams.set("orientation", params.orientation);
  }
  let topicIds = null;
  if (params.collections) {
    apiUrl.searchParams.set("collections", params.collections);
  }
  if (params.topics) {
    topicIds = convertTopicSlugsToIds(params.topics);
    apiUrl.searchParams.set("topics", topicIds);
  }
  if (params.query) {
    apiUrl.searchParams.set("query", params.query);
  }
  console.log(
    "UNSPLASH API REQUEST",
    JSON.stringify({
      collections: params.collections,
      topics: params.topics,
      topicIds,
      query: params.query,
      orientation: apiUrl.searchParams.get("orientation") || "not set",
      count,
      url: apiUrl.toString().replace(env.UNSPLASH_ACCESS_KEY, "REDACTED")
    })
  );
  const response = await fetch(apiUrl.toString());
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After") || "3600";
    throw new Error(`Rate limited. Retry after ${retryAfter} seconds`);
  }
  if (response.status === 403) {
    throw new Error(`Access forbidden.`);
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(`Unsplash API error: ${response.status} ${response.statusText} - ${errorBody}`);
  }
  return await response.json();
}
function constructOptimizedUrl(rawUrl, params = {}) {
  const url = new URL(rawUrl);
  const autoValue = params.enhance !== false ? "format,enhance" : "format";
  url.searchParams.set("auto", autoValue);
  url.searchParams.set("q", "65");
  url.searchParams.set("cs", "srgb");
  url.searchParams.set("dpr", params.dpr || "2");
  url.searchParams.set("fit", params.fit || "clip");
  if (params.width) {
    url.searchParams.set("w", params.width);
  }
  if (params.height) {
    url.searchParams.set("h", params.height);
  }
  return url.toString();
}
async function populateCache(env, cacheKey, photos, params = {}) {
  const fetchPromises = photos.map((photo, i) => {
    const optimizedUrl = constructOptimizedUrl(photo.urls.raw, params);
    return fetch(optimizedUrl).then((response) => ({ index: i, photo, response, error: null })).catch((error) => ({ index: i, photo, response: null, error }));
  });
  const fetchResults = await Promise.all(fetchPromises);
  const validResults = [];
  for (const result of fetchResults) {
    if (result.error) {
      console.error(`Error fetching image ${result.index}:`, result.error);
      continue;
    }
    if (!result.response.ok) {
      console.error(`Failed to fetch image ${result.index}:`, result.response.status);
      continue;
    }
    const contentType = result.response.headers.get("Content-Type");
    if (!contentType || !contentType.startsWith("image/")) {
      console.error(`Invalid content type for image ${result.index}:`, contentType);
      continue;
    }
    validResults.push({ ...result, contentType });
  }
  const storePromises = validResults.map(async (result) => {
    const r2Key = `${cacheKey}_${result.index}`;
    try {
      await env.UNSPLASH_CACHE.put(r2Key, result.response.body, {
        httpMetadata: {
          contentType: result.contentType
        }
      });
      return {
        r2_key: r2Key,
        photographer: result.photo.user.name,
        photo_id: result.photo.id,
        content_type: result.contentType
      };
    } catch (error) {
      console.error(`Error storing image ${result.index} in R2:`, error);
      return null;
    }
  });
  const storeResults = await Promise.all(storePromises);
  const images = storeResults.filter((img) => img !== null);
  for (const result of validResults) {
    triggerDownloadTracking(env, result.photo).catch((err) => {
      console.error(`Download tracking failed for photo ${result.photo.id}:`, err);
    });
  }
  const metadata = {
    cache_key: cacheKey,
    total_images: images.length,
    next_index: 0,
    served_count: 0,
    last_accessed: Date.now(),
    images
  };
  await env.UNSPLASH_CACHE_METADATA.put(cacheKey, JSON.stringify(metadata));
}
async function refreshCache(env, metadata) {
  try {
    const params = parseCacheKey(metadata.cache_key);
    const photos = await fetchUnsplashPhotos(env, params, 27);
    if (!photos || photos.length === 0) {
      console.error("Failed to fetch images for cache refresh");
      return;
    }
    const startIndex = metadata.next_index;
    const indicesToReplace = [];
    for (let i = 0; i < 27; i++) {
      indicesToReplace.push((startIndex + i) % 29);
    }
    const dimensions = parseDimensionsFromCacheKey(metadata.cache_key);
    const fetchPromises = photos.slice(0, 27).map((photo, i) => {
      const optimizedUrl = constructOptimizedUrl(photo.urls.raw, { width: dimensions.width, height: dimensions.height });
      return fetch(optimizedUrl).then((response) => ({ index: i, photo, response, error: null })).catch((error) => ({ index: i, photo, response: null, error }));
    });
    const fetchResults = await Promise.all(fetchPromises);
    const deletePromises = indicesToReplace.map((indexToReplace) => {
      if (metadata.images[indexToReplace]) {
        const oldR2Key = metadata.images[indexToReplace].r2_key;
        return env.UNSPLASH_CACHE.delete(oldR2Key).catch((err) => {
          console.error(`Error deleting old image at index ${indexToReplace}:`, err);
        });
      }
      return Promise.resolve();
    });
    await Promise.all(deletePromises);
    const storePromises = fetchResults.map(async (result) => {
      if (result.error) {
        console.error(`Error fetching refresh image ${result.index}:`, result.error);
        return null;
      }
      if (!result.response.ok) {
        console.error(`Failed to fetch refresh image ${result.index}:`, result.response.status);
        return null;
      }
      const contentType = result.response.headers.get("Content-Type");
      if (!contentType || !contentType.startsWith("image/")) {
        console.error(`Invalid content type for refresh image ${result.index}:`, contentType);
        return null;
      }
      const indexToReplace = indicesToReplace[result.index];
      const newR2Key = `${metadata.cache_key}_${indexToReplace}`;
      try {
        await env.UNSPLASH_CACHE.put(newR2Key, result.response.body, {
          httpMetadata: {
            contentType
          }
        });
        return {
          indexToReplace,
          imageData: {
            r2_key: newR2Key,
            photographer: result.photo.user.name,
            photo_id: result.photo.id,
            content_type: contentType
          },
          photo: result.photo
        };
      } catch (error) {
        console.error(`Error storing refresh image ${result.index} in R2:`, error);
        return null;
      }
    });
    const storeResults = await Promise.all(storePromises);
    for (const result of storeResults) {
      if (result) {
        metadata.images[result.indexToReplace] = result.imageData;
      }
    }
    for (const result of storeResults) {
      if (result) {
        triggerDownloadTracking(env, result.photo).catch((err) => {
          console.error(`Download tracking failed for photo ${result.photo.id}:`, err);
        });
      }
    }
    metadata.served_count = 0;
    await env.UNSPLASH_CACHE_METADATA.put(metadata.cache_key, JSON.stringify(metadata));
  } catch (error) {
    console.error("Cache refresh error:", error);
  }
}
function parseCacheKey(cacheKey) {
  if (cacheKey === "default") {
    return { collections: null, topics: null, query: null, width: null, height: null };
  }
  const params = { collections: null, topics: null, query: null, width: null, height: null };
  const parts = cacheKey.split("&");
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key && value) {
      params[key] = value;
    }
  }
  return params;
}
function parseDimensionsFromCacheKey(cacheKey) {
  const params = parseCacheKey(cacheKey);
  return {
    width: params.width || null,
    height: params.height || null
  };
}
function extractCategoryFromCacheKey(cacheKey) {
  const params = parseCacheKey(cacheKey);
  return extractCategoryFromParams(params);
}
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
  return "random";
}
async function triggerDownloadTracking(env, photo) {
  try {
    if (photo.links && photo.links.download_location) {
      fetch(photo.links.download_location, {
        headers: {
          Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`
        }
      }).catch((error) => {
        console.error("Download tracking error:", error);
      });
    }
  } catch (error) {
    console.error("Download tracking error:", error);
  }
}
async function cleanupOldCache(env) {
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let totalKeysChecked = 0;
  let totalKeysDeleted = 0;
  let totalR2ObjectsDeleted = 0;
  let legacyKeysUpdated = 0;
  const errors = [];
  console.log("CACHE CLEANUP STARTED");
  try {
    let cursor = void 0;
    let hasMore = true;
    while (hasMore) {
      const listResult = await env.UNSPLASH_CACHE_METADATA.list({ cursor });
      for (const key of listResult.keys) {
        totalKeysChecked++;
        try {
          const metadata = await env.UNSPLASH_CACHE_METADATA.get(key.name, "json");
          if (!metadata) {
            continue;
          }
          if (metadata.last_accessed) {
            const age = now - metadata.last_accessed;
            if (age > TWO_WEEKS_MS) {
              if (metadata.images && Array.isArray(metadata.images)) {
                for (const image of metadata.images) {
                  try {
                    await env.UNSPLASH_CACHE.delete(image.r2_key);
                    totalR2ObjectsDeleted++;
                  } catch (error) {
                    errors.push(`R2 delete error: ${image.r2_key}`);
                  }
                }
              }
              await env.UNSPLASH_CACHE_METADATA.delete(key.name);
              totalKeysDeleted++;
            }
          } else {
            metadata.last_accessed = now;
            await env.UNSPLASH_CACHE_METADATA.put(key.name, JSON.stringify(metadata));
            legacyKeysUpdated++;
          }
        } catch (error) {
          errors.push(`Key processing error: ${key.name}`);
        }
      }
      hasMore = !listResult.list_complete;
      cursor = listResult.cursor;
    }
    console.log(
      "CACHE CLEANUP COMPLETED",
      JSON.stringify({
        success: true,
        keysChecked: totalKeysChecked,
        keysDeleted: totalKeysDeleted,
        r2ObjectsDeleted: totalR2ObjectsDeleted,
        legacyKeysUpdated,
        errors: errors.length > 0 ? errors : void 0
      })
    );
  } catch (error) {
    console.log(
      "CACHE CLEANUP FAILED",
      JSON.stringify({
        success: false,
        error: error.message,
        keysChecked: totalKeysChecked,
        keysDeleted: totalKeysDeleted,
        r2ObjectsDeleted: totalR2ObjectsDeleted
      })
    );
  }
}
