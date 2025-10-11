# Topic Slug to ID Conversion Fix

## Problem

The Unsplash API's `/photos/random` endpoint requires **topic IDs** (e.g., `bo8jQKTaE0Y`), not topic slugs (e.g., `wallpapers`). 

When users passed topic slugs like `?topics=wallpapers`, the Unsplash API would ignore the invalid topic parameter and return completely random photos instead of filtered results. This caused users to receive images that didn't match their requested topic.

### Example of the Issue

**Request:** `https://unsplash-worker.connor-shinn.workers.dev/?topics=wallpapers&w=1920&h=1080`

**Expected:** Wallpaper images from the "Wallpapers" topic

**Actual:** Random images (e.g., a motorcycle photo) because "wallpapers" slug was not recognized as a valid topic ID

## Root Cause

The Unsplash API documentation states:

> **GET /photos/random**
> 
> Parameters:
> - `topics`: Public topic ID('s) to filter selection. If multiple, comma-separated

However, the "Get a topic" endpoint (`GET /topics/:id_or_slug`) accepts **both** IDs and slugs, which created confusion. The `/photos/random` endpoint only accepts IDs.

## Solution

Added automatic conversion of common topic slugs to their corresponding topic IDs in the `fetchUnsplashPhotos` function.

### Implementation

1. **Created a mapping** of common topic slugs to their IDs:
   ```javascript
   const TOPIC_SLUG_TO_ID = {
     'wallpapers': 'bo8jQKTaE0Y',
     'nature': '6sMVjTLSkeQ',
     'people': 'towJZFskpGg',
     // ... more topics
   };
   ```

2. **Added conversion function** that:
   - Splits comma-separated topics
   - Converts known slugs to IDs
   - Passes through unknown values (in case user already provided an ID)

3. **Updated the API call** to use converted IDs:
   ```javascript
   if (params.topics) {
     const topicIds = convertTopicSlugsToIds(params.topics);
     apiUrl.searchParams.set('topics', topicIds);
     console.log('Added topics parameter (original):', params.topics);
     console.log('Added topics parameter (converted to IDs):', topicIds);
   }
   ```

### Supported Topic Slugs

The following topic slugs are now automatically converted:

- `wallpapers` → `bo8jQKTaE0Y`
- `nature` → `6sMVjTLSkeQ`
- `people` → `towJZFskpGg`
- `architecture` → `rnSKDHwwYUk`
- `current-events` → `hmenvQhUmxM`
- `business-work` → `aeu6rL-j6ew`
- `fashion-beauty` → `S4MKLAsBB74`
- `film` → `xjPR4hlkBGA`
- `food-drink` → `xHxYTMHLgOc`
- `health-wellness` → `_8zFHuhRhyo`
- `spirituality` → `_hb-dl4Q-4U`
- `travel` → `Fzo3zuOHN6w`
- `animals` → `Jpg6Kidl-Hk`
- `athletics` → `Bn-DjrcBrwo`
- `arts-culture` → `bDo48cUhwnY`
- `3d-renders` → `CDwuwXJAbEw`

## Testing

To verify the fix works:

1. **Deploy the updated worker:**
   ```bash
   npm run deploy
   ```

2. **Test with a topic slug:**
   ```bash
   curl -I "https://your-worker.workers.dev/?topics=wallpapers&w=1920&h=1080"
   ```

3. **Check the logs:**
   ```bash
   wrangler tail
   ```
   
   You should see:
   ```
   Added topics parameter (original): wallpapers
   Added topics parameter (converted to IDs): bo8jQKTaE0Y
   Final Unsplash API URL: https://api.unsplash.com/photos/random?client_id=REDACTED&orientation=landscape&count=11&topics=bo8jQKTaE0Y
   ```

4. **Verify the image** returned is actually from the wallpapers topic by checking the `X-Image-Source-URL` header or visiting the Unsplash photo page.

## Backward Compatibility

This change is **fully backward compatible**:

- Users passing topic slugs will now get correct filtered results
- Users already passing topic IDs will continue to work (IDs are passed through unchanged)
- The cache key generation still uses the original parameter values, so existing caches remain valid

## Future Enhancements

To support additional topics:

1. Find the topic on Unsplash (e.g., https://unsplash.com/t/wallpapers)
2. Use the Unsplash API to get the topic ID:
   ```bash
   curl "https://api.unsplash.com/topics/TOPIC_SLUG?client_id=YOUR_KEY"
   ```
3. Add the mapping to `TOPIC_SLUG_TO_ID` in `src/index.js`

Alternatively, implement dynamic topic resolution by calling the `/topics/:slug` endpoint, though this would add latency and consume additional API quota.

