# Changelog

## Latest Update - Cache Miss Fix & Parameter Debugging

### Fixed Issues

#### 1. Duplicate Image in Cache (FIXED ✅)

**Problem**: When there was a cache miss, the worker would:
- Fetch 10 images from Unsplash
- Serve the first image to the user (via redirect)
- Cache all 10 images (including the one just served)
- Result: User sees the same image twice when cycling through cached images

**Solution**: 
- Now fetches **11 images** from Unsplash on cache miss
- Serves the **first image** to the user immediately (via redirect)
- Caches only images **2-11** (the remaining 10 images)
- Result: User never sees the same image twice

**Code Changes**:
```javascript
// Before
const photos = await fetchUnsplashPhotos(env, params, 10);
ctx.waitUntil(populateCache(env, cacheKey, photos, ...));

// After
const photos = await fetchUnsplashPhotos(env, params, 11);
const photosToCache = photos.slice(1, 11); // Skip first image
ctx.waitUntil(populateCache(env, cacheKey, photosToCache, ...));
```

#### 2. Parameter Debugging (ENHANCED 🔍)

**Issue**: User suspected that filter parameters (topics, query, collections) weren't being passed to Unsplash API correctly.

**Investigation**: Added comprehensive logging to verify parameters are being passed correctly.

**Added Logging**:
- Logs all incoming parameters (collections, topics, query, width, height)
- Logs which parameters are being added to the API URL
- Logs the final Unsplash API URL (with API key redacted)
- Logs number of images fetched

**Example Log Output**:
```
fetchUnsplashPhotos called with params: {
  collections: null,
  topics: "nature",
  query: null,
  width: "1920",
  height: "1080",
  count: 11
}
Added topics parameter: nature
Final Unsplash API URL: https://api.unsplash.com/photos/random?client_id=REDACTED&orientation=landscape&count=11&topics=nature
=== CACHE MISS ===
File Dimensions: 1920x1080
Source URL: https://unsplash.com/photos/abc123
Unsplash Category: topics: nature
Photographer: Jane Smith
Fetched 11 images from Unsplash
================
```

### How to Verify the Fix

#### Test 1: No More Duplicate Images

1. Clear your cache (delete KV and R2 objects for a specific cache key)
2. Make a request: `https://unsplash-worker.connor-shinn.workers.dev/?topics=nature`
3. Note the photographer name from the first image
4. Make 10 more requests
5. **Expected**: You should NOT see the first photographer's image again in the next 10 requests

#### Test 2: Verify Parameters Are Being Sent

1. Run `wrangler tail` to view logs
2. Make a request: `https://unsplash-worker.connor-shinn.workers.dev/?topics=nature&w=1920&h=1080`
3. Check the logs - you should see:
   - "fetchUnsplashPhotos called with params" showing all your parameters
   - "Added topics parameter: nature"
   - "Final Unsplash API URL" showing the complete URL with topics parameter
   - All returned images should match the "nature" topic

### Testing Commands

```bash
# Deploy the updated worker
npm run deploy

# Watch logs in real-time
wrangler tail

# Test with topics
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?topics=nature&w=1920&h=1080"

# Test with query
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?query=mountain&w=1920&h=1080"

# Test with collections
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?collections=1065976&w=1920&h=1080"
```

### What to Look For in Logs

When you run `wrangler tail` and make a request, you should see:

```
fetchUnsplashPhotos called with params: { collections: null, topics: 'nature', query: null, width: '1920', height: '1080', count: 11 }
Added topics parameter: nature
Final Unsplash API URL: https://api.unsplash.com/photos/random?client_id=REDACTED&orientation=landscape&count=11&topics=nature
=== CACHE MISS ===
File Dimensions: 1920x1080
Source URL: https://unsplash.com/photos/abc123
File Size: Not available (redirect)
Unsplash Category: topics: nature
Photographer: Jane Smith
Fetched 11 images from Unsplash
================
```

### Important Notes

1. **Width/Height are NOT sent to Unsplash API** - This is correct! Unsplash's `/photos/random` endpoint doesn't accept width/height parameters. Instead, we use these dimensions when constructing the imgix URL (Unsplash's CDN) which handles the actual resizing.

2. **Topics must be valid Unsplash topic slugs** - If you're getting random images when using topics, it might be because:
   - The topic slug is invalid (check https://unsplash.com/t/)
   - You're using a Demo API key that doesn't have access to that topic (upgrade to Production)

3. **Cache Refresh Still Works** - The cache refresh logic (replacing 8 images after every 8 requests) is unchanged and still works correctly.

### Files Modified

- `src/index.js`:
  - `handleCacheMiss()`: Now fetches 11 images and caches only 10
  - `fetchUnsplashPhotos()`: Added comprehensive parameter logging
  - Added log output showing number of images fetched

### Next Steps

1. Deploy the updated worker: `npm run deploy`
2. Test with `wrangler tail` to verify parameters are being sent correctly
3. Make multiple requests to verify no duplicate images
4. If you're still seeing random images instead of filtered ones, check:
   - The topic/collection/query is valid
   - Your API key has access (Demo vs Production)
   - The logs show the parameter is being added to the URL

### Troubleshooting

**Still seeing random images?**

Check the logs for:
```
Added topics parameter: nature
```

If you DON'T see this line, the parameter isn't being passed from the URL to the function. If you DO see it, but still get random images, it's likely:
- Invalid topic slug
- Demo API key restrictions
- Unsplash API issue

**Still seeing duplicate images?**

- Make sure you've deployed the latest version
- Clear your cache (KV and R2) and test again
- Check logs to confirm "Fetched 11 images from Unsplash"

