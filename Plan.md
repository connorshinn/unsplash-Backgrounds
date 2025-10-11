# Unsplash Cloudflare Worker 

**Overview**: Cloudflare worker that queries the Unsplash API for random images and serves them to the client. The worker URL should always return an image, which will be used as the background for a TinyAuth instance. The worker implements a caching system that maintains 10 images in R2 storage to limit API requests and improve response times.

## 0. Prerequisites & Setup

### 0.1 Required Resources (Create Before Deployment)

These resources must be created before deploying the worker:

1. **Create R2 bucket** named "unsplash-cache":
   ```bash
   wrangler r2 bucket create unsplash-cache
   ```

2. **Create KV namespace** named "unsplash-cache-metadata":
   ```bash
   wrangler kv:namespace create "UNSPLASH_CACHE_METADATA"
   ```
   Note the namespace ID returned by this command for use in wrangler.toml.

3. **Obtain Unsplash API Access Key**:
   - Register at https://unsplash.com/developers
   - Create a new application
   - Copy the Access Key for use as a secret

### 0.2 Wrangler Configuration

Configure `wrangler.toml` with the following bindings:

```toml
name = "unsplash-worker"
main = "src/index.js"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "UNSPLASH_CACHE"
bucket_name = "unsplash-cache"

[[kv_namespaces]]
binding = "UNSPLASH_CACHE_METADATA"
id = "YOUR_KV_NAMESPACE_ID"
```

### 0.3 Secrets Configuration

Set the Unsplash API key as a secret:

```bash
wrangler secret put UNSPLASH_ACCESS_KEY
```

When prompted, paste your Unsplash Access Key.

### 0.4 Worker Initialization

On the first request, the worker should verify that all required bindings are available:
- If `env.UNSPLASH_CACHE` is undefined, return 500 error: "R2 bucket not configured"
- If `env.UNSPLASH_CACHE_METADATA` is undefined, return 500 error: "KV namespace not configured"
- If `env.UNSPLASH_ACCESS_KEY` is undefined, return 500 error: "Unsplash API key not configured"

## 0.5 Worker API Specification

### Request Format

**URL Pattern**: `https://your-worker.workers.dev/`

**Query Parameters** (all optional):
- `collections`: Comma-separated Unsplash collection IDs (e.g., `collections=1234567,7654321`)
- `topics`: Comma-separated Unsplash topic IDs (e.g., `topics=nature,landscape`)
- `query`: Search terms (e.g., `query=mountain,sunset`)

**Parameter Rules**:
- Collections or topics filtering cannot be used with query parameters in the same request
- If both are provided, return 400 error: "Cannot use collections/topics with query parameter"
- If no parameters provided, returns random images from entire Unsplash library

**Examples**:
- `https://your-worker.workers.dev/` - Random image
- `https://your-worker.workers.dev/?topics=nature` - Random nature image
- `https://your-worker.workers.dev/?query=mountain,sunset` - Random mountain sunset image

### Cache Key Generation

Cache keys are generated from query parameters to ensure consistent caching:

1. Extract all query parameters (collections, topics, query)
2. Sort parameter names alphabetically
3. For each parameter, sort values alphabetically if comma-separated
4. Format as: `param1=value1&param2=value2`

**Examples**:
- `?topics=nature,landscape` → cache key: `topics=landscape,nature`
- `?collections=123,456&topics=water` → cache key: `collections=123,456&topics=water`
- No parameters → cache key: `default`

### Response Format

**Cache Miss (No cache exists)**:
- **Status**: 302 Found
- **Location Header**: Optimized Unsplash image URL
- **Headers**:
  - `X-Cache-Status: MISS`
  - `X-Unsplash-Photographer: [photographer name]`
  - `Cache-Control: no-cache` (redirect should not be cached)

**Cache Hit (Cache exists)**:
- **Status**: 200 OK
- **Content-Type**: `image/jpeg` (or appropriate image type)
- **Body**: Image binary data streamed from R2
- **Headers**:
  - `X-Cache-Status: HIT`
  - `X-Unsplash-Photographer: [photographer name]`
  - `Cache-Control: public, max-age=3600`

## 1. Cache Setup

### 1.1 Cache Workflow Overview

The worker cache is designed to store images from Unsplash to improve loading times and reduce API calls.

**Cache Architecture**:

The caching system consists of two parts:

1. **R2 Store** (Image Data):
   - Bucket name: `unsplash-cache`
   - Stores actual image binary data
   - Key format: `{cache_key}_{index}` (e.g., `topics=nature_0`, `topics=nature_1`, etc.)
   - Maintains 10 images per cache key at all times

2. **KV Store** (Cache Metadata):
   - Namespace name: `unsplash-cache-metadata`
   - Stores metadata about cached images
   - Key format: `{cache_key}` (e.g., `topics=nature`)
   - Metadata structure:
     ```json
     {
       "cache_key": "topics=nature",
       "total_images": 10,
       "next_index": 0,
       "served_count": 0,
       "images": [
         {
           "r2_key": "topics=nature_0",
           "photographer": "John Doe",
           "photo_id": "abc123",
           "content_type": "image/jpeg"
         }
         // ... 9 more images
       ]
     }
     ```

**Cache Workflow**:

When a request is received:
1. Generate cache key from query parameters (see Section 0.5)
2. Check if cache metadata exists in KV store
3. If cache exists → Follow "Cache Hit" workflow (Section 1.3)
4. If cache does not exist → Follow "Cache Miss" workflow (Section 1.2)

### 1.2 Cache Miss (No Cache Exists)

When no cache exists for a given cache key, the worker should:

**Step 1: Fetch 10 Images from Unsplash**

Make a single API call to Unsplash with `count=10` parameter to retrieve 10 random images (see Section 2.1 for API details). The API will return an array of 10 image objects with the following structure:

```javascript
[
  {
    "id": "Dwu85P9SOIk",
    "created_at": "2016-05-03T11:00:28-04:00",
    "updated_at": "2016-07-10T11:00:01-05:00",
    "width": 2448,
    "height": 3264,
    "color": "#6E633A",
    "blur_hash": "LFC$yHwc8^$yIAS$%M%00KxukYIp",
    "downloads": 1345,
    "likes": 24,
    "liked_by_user": false,
    "description": "A man drinking a coffee.",
    "exif": {
      "make": "Canon",
      "model": "Canon EOS 40D",
      "exposure_time": "0.011111111111111112",
      "aperture": "4.970854",
      "focal_length": "37",
      "iso": 100
    },
    "location": {
      "name": "Montreal, Canada",
      "city": "Montreal",
      "country": "Canada",
      "position": {
        "latitude": 45.473298,
        "longitude": -73.638488
      }
    },
    "current_user_collections": [
      {
        "id": 206,
        "title": "Makers: Cat and Ben",
        "published_at": "2016-01-12T18:16:09-05:00",
        "last_collected_at": "2016-06-02T13:10:03-04:00",
        "updated_at": "2016-07-10T11:00:01-05:00",
        "cover_photo": null,
        "user": null
      }
      // ... more collections
    ],
    "urls": {
      "raw": "https://images.unsplash.com/photo-1417325384643-aac51acc9e5d",
      "full": "https://images.unsplash.com/photo-1417325384643-aac51acc9e5d?q=75&fm=jpg",
      "regular": "https://images.unsplash.com/photo-1417325384643-aac51acc9e5d?q=75&fm=jpg&w=1080&fit=max",
      "small": "https://images.unsplash.com/photo-1417325384643-aac51acc9e5d?q=75&fm=jpg&w=400&fit=max",
      "thumb": "https://images.unsplash.com/photo-1417325384643-aac51acc9e5d?q=75&fm=jpg&w=200&fit=max"
    },
    "links": {
      "self": "https://api.unsplash.com/photos/Dwu85P9SOIk",
      "html": "https://unsplash.com/photos/Dwu85P9SOIk",
      "download": "https://unsplash.com/photos/Dwu85P9SOIk/download",
      "download_location": "https://api.unsplash.com/photos/Dwu85P9SOIk/download"
    },
    "user": {
      "id": "QPxL2MGqfrw",
      "updated_at": "2016-07-10T11:00:01-05:00",
      "username": "exampleuser",
      "name": "Joe Example",
      "portfolio_url": "https://example.com/",
      "bio": "Just an everyday Joe",
      "location": "Montreal",
      "total_likes": 5,
      "total_photos": 10,
      "total_collections": 13,
      "instagram_username": "instantgrammer",
      "twitter_username": "crew",
      "links": {
        "self": "https://api.unsplash.com/users/exampleuser",
        "html": "https://unsplash.com/exampleuser",
        "photos": "https://api.unsplash.com/users/exampleuser/photos",
        "likes": "https://api.unsplash.com/users/exampleuser/likes",
        "portfolio": "https://api.unsplash.com/users/exampleuser/portfolio"
      }
    }
  }
  // ... 9 more photos
]
```

**Step 2: Serve First Image (Immediate Response)**

1. Extract the first image from the array (index 0)
2. Construct optimized image URL from `urls.raw` (see Section 2.2 for URL construction)
3. Trigger the download tracking endpoint (see Section 2.4)
4. Return **302 redirect** to the optimized image URL with headers:
   - `Location: [optimized image URL]`
   - `X-Cache-Status: MISS`
   - `X-Unsplash-Photographer: [user.name]`
   - `Cache-Control: no-cache`

**Step 3: Background Cache Population (using ctx.waitUntil())**

After returning the redirect response, populate the cache in the background:

1. **For each of the 10 images**:
   a. Construct optimized image URL (see Section 2.2)
   b. Fetch image binary data from the URL (see Section 2.3)
   c. Store in R2 with key: `{cache_key}_{index}` (e.g., `topics=nature_0`)
   d. Trigger download tracking endpoint for attribution (see Section 2.4)
   e. Record metadata: photographer name, photo ID, content type

2. **Create cache metadata object**:
   ```json
   {
     "cache_key": "topics=nature",
     "total_images": 10,
     "next_index": 0,
     "served_count": 0,
     "images": [
       {
         "r2_key": "topics=nature_0",
         "photographer": "Joe Example",
         "photo_id": "Dwu85P9SOIk",
         "content_type": "image/jpeg"
       }
       // ... 9 more image metadata objects
     ]
   }
   ```

3. **Store metadata in KV**:
   - Key: `{cache_key}`
   - Value: JSON metadata object
   - This enables subsequent requests to use the cache

**Note**: Background processing uses `ctx.waitUntil()` to ensure cache population completes even after the response is sent to the client.

### 1.3 Cache Hit (Cache Exists)

When cache metadata exists for a given cache key, the worker should:

**Step 1: Retrieve Cache Metadata**

Fetch the cache metadata from KV store using the cache key.

**Step 2: Identify Next Image**

Use the `next_index` field to determine which image to serve.

**Step 3: Serve Image from R2**

1. Retrieve the image from R2 using `images[next_index].r2_key`
2. Stream the image binary data to the client with **200 OK** response
3. Set response headers:
   - `Content-Type: [content_type from metadata]`
   - `X-Cache-Status: HIT`
   - `X-Unsplash-Photographer: [photographer from metadata]`
   - `Cache-Control: public, max-age=3600`

**Step 4: Update Cache Index**

Increment `next_index` in the metadata (wraps to 0 after reaching 9).
Increment `served_count` to track total images served.

**Step 5: Check for Cache Refresh (80% Threshold)**

After serving the image, check if cache refresh is needed:

- **Condition**: `served_count % 8 === 0` (every 8 images served)
- **Action**: Trigger background cache refresh using `ctx.waitUntil()`

**Background Cache Refresh Process**:

1. **Fetch 8 new images** from Unsplash with `count=8` parameter
2. **Identify images to replace**: The 8 oldest images (those that have been served)
   - Calculate which indices to replace based on current `next_index`
   - Example: If `next_index` is 2, replace indices 2-9 (8 images)
3. **Delete old images from R2**: Remove the 8 R2 objects being replaced
4. **Upload new images to R2**:
   - For each new image:
     a. Construct optimized URL
     b. Fetch image binary data
     c. Store in R2 with appropriate key
     d. Trigger download tracking endpoint
5. **Update metadata in KV**:
   - Replace the 8 image metadata entries
   - Reset `served_count` to 0
   - Keep `next_index` unchanged (maintains position in queue)

**Result**: The cache always maintains 10 images, with 2 images that haven't been served yet, ensuring no delay when the cache is accessed.

## 2. Unsplash API Integration

### 2.1 API Call

The worker uses the Unsplash API to fetch random photos.

**Endpoint**: `https://api.unsplash.com/photos/random`

**Required Parameters** (added to all requests):
- `client_id=[YOUR_UNSPLASH_ACCESS_KEY]` - From environment secret
- `orientation=landscape` - Ensures landscape orientation for backgrounds
- `count=[number]` - Number of images to fetch (1, 8, or 10 depending on context)

**Optional Parameters** (based on user request):
- `collections`: Public collection ID(s) to filter selection. If multiple, comma-separated
- `topics`: Public topic ID(s) to filter selection. If multiple, comma-separated
- `query`: Search query to filter selection

**Important Constraint**: Collections or topics filtering cannot be used with query parameters in the same request. The worker should validate this and return a 400 error if violated.

**Example API Calls**:
```
https://api.unsplash.com/photos/random?client_id=YOUR_KEY&orientation=landscape&count=10
https://api.unsplash.com/photos/random?client_id=YOUR_KEY&orientation=landscape&count=10&topics=nature
https://api.unsplash.com/photos/random?client_id=YOUR_KEY&orientation=landscape&count=8&query=mountain
```

**Error Handling**:
- **429 Too Many Requests**: Rate limit exceeded. Return 503 Service Unavailable with `Retry-After` header
- **Network Errors**: Log error and return 502 Bad Gateway
- **Invalid Response**: Log error and return 502 Bad Gateway
- **4xx Errors**: Log error and return 400 Bad Request with error message

**Rate Limits**:
- Demo: 50 requests per hour
- Production: 5000 requests per hour
- The caching strategy significantly reduces API calls

### 2.2 Image URL Construction

When constructing the optimized image URL for serving or caching:

1. Extract the `urls.raw` field from the Unsplash API response
2. Append the following query parameters:
   - `auto=format` - Automatically select best format (WebP, JPEG, etc.)
   - `q=65` - JPEG quality at 65%
   - `cs=origin` - Use original color space
   - `fit=clamp` - Fit image within bounds without cropping

**Example**:
- Raw URL: `https://images.unsplash.com/photo-1417325384643-aac51acc9e5d`
- Optimized URL: `https://images.unsplash.com/photo-1417325384643-aac51acc9e5d?auto=format&q=65&cs=origin&fit=clamp`

**Usage**:
- **Cache Miss**: Return this URL in the 302 redirect Location header
- **Cache Population**: Fetch image data from this URL to store in R2

### 2.3 Image Fetching & Storage

When fetching images to store in R2 (during cache population or refresh):

**Fetching Image Data**:

1. Construct optimized URL using Section 2.2
2. Fetch the image:
   ```javascript
   const response = await fetch(optimizedImageUrl);
   ```
3. Validate response:
   - Check `response.ok` (status 200-299)
   - Verify `Content-Type` header starts with `image/`
4. If validation fails, log error and skip this image

**Storing in R2**:

1. Store the image with appropriate key:
   ```javascript
   await env.UNSPLASH_CACHE.put(r2Key, response.body, {
     httpMetadata: {
       contentType: response.headers.get('Content-Type')
     }
   });
   ```
2. The `r2Key` should follow the format: `{cache_key}_{index}`
3. Store the content type for later retrieval

**Error Handling**:
- If fetch fails, log error and continue with remaining images
- If R2 put fails, log error and continue
- Partial cache population is acceptable (better than no cache)

### 2.4 Download Tracking (Attribution)

Unsplash API requires triggering the download endpoint for attribution tracking.

**When to Trigger**:
- Every time an image is served to a client (both cache hit and cache miss)
- During cache population (when fetching images to store in R2)

**Endpoint**: Use the `links.download_location` field from the API response

**How to Trigger**:
```javascript
await fetch(photo.links.download_location, {
  headers: {
    'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`
  }
});
```

**Important**:
- This is a fire-and-forget request (don't wait for response)
- Use `ctx.waitUntil()` to ensure it completes
- Required by Unsplash API Terms of Service
- Failure to trigger this endpoint may result in API access revocation

## 3. Error Handling

### 3.1 Unsplash API Errors

**Rate Limit (429 Too Many Requests)**:
- Check for `Retry-After` header in response
- Return 503 Service Unavailable to client
- Include `Retry-After` header in response
- Log the rate limit event

**Network Errors**:
- Catch fetch exceptions
- Log error with details
- Return 502 Bad Gateway to client
- Consider fallback to cached images if available

**Invalid Response (4xx, 5xx)**:
- Log the error with status code and response body
- Return appropriate error to client:
  - 400 for client errors (invalid parameters)
  - 502 for server errors

### 3.2 R2/KV Errors

**R2 Unavailable**:
- If R2 operations fail during cache hit, fall back to fetching directly from Unsplash
- Return 302 redirect to Unsplash URL
- Log the error for monitoring

**KV Unavailable**:
- If KV read fails, treat as cache miss
- Proceed with normal cache miss workflow
- Log the error for monitoring

**Binding Not Configured**:
- Check bindings on first request (Section 0.4)
- Return 500 Internal Server Error with clear message
- This indicates deployment configuration issue

### 3.3 Concurrent Request Handling

**Multiple Simultaneous Cache Misses**:
- Multiple requests for the same cache key may arrive before cache is populated
- This may result in duplicate API calls and cache population attempts
- This is an acceptable trade-off for simplicity
- KV eventual consistency means last write wins

**Cache Refresh Conflicts**:
- Multiple requests may trigger cache refresh simultaneously
- Use `served_count % 8 === 0` check to minimize this
- Duplicate refresh attempts are acceptable (idempotent operation)

## 4. Testing Strategy

### 4.1 Unit Tests

Test the following functions in isolation:

1. **Cache Key Generation**:
   - Test with various query parameter combinations
   - Verify alphabetical sorting
   - Test with no parameters (should return "default")

2. **URL Construction**:
   - Verify correct parameters are appended
   - Test with various raw URLs

3. **Metadata Update Logic**:
   - Test index increment and wrapping
   - Test served_count increment
   - Test 80% threshold detection

### 4.2 Integration Tests

Test the complete workflow:

1. **First Request (Cache Miss)**:
   - Make request to worker
   - Verify 302 redirect response
   - Verify `X-Cache-Status: MISS` header
   - Verify photographer attribution header
   - Wait for cache population
   - Verify R2 contains 10 images
   - Verify KV contains metadata

2. **Subsequent Requests (Cache Hit)**:
   - Make request with same parameters
   - Verify 200 OK response with image data
   - Verify `X-Cache-Status: HIT` header
   - Verify different images are served
   - Make 8 requests total
   - Verify cache refresh is triggered

3. **Cache Refresh**:
   - After 8 requests, verify new images are fetched
   - Verify old images are deleted from R2
   - Verify metadata is updated
   - Verify cache still contains 10 images

4. **Error Scenarios**:
   - Test with invalid parameters (collections + query)
   - Test with missing bindings
   - Test with Unsplash API errors (mock)

### 4.3 Manual Testing

1. **Deploy to Cloudflare Workers**:
   ```bash
   wrangler deploy
   ```

2. **Test Basic Functionality**:
   - Visit worker URL in browser
   - Verify image is displayed
   - Check response headers in browser dev tools

3. **Test Different Parameters**:
   - Test with `?topics=nature`
   - Test with `?query=mountain`
   - Test with `?collections=123456`

4. **Verify Cache Behavior**:
   - Make multiple requests
   - Check `X-Cache-Status` header (should change from MISS to HIT)
   - Verify different images are served

5. **Check R2 and KV**:
   - Use Cloudflare dashboard to inspect R2 bucket
   - Verify 10 images are stored
   - Use wrangler to inspect KV:
     ```bash
     wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"
     ```

6. **Verify Unsplash Attribution**:
   - Check Unsplash dashboard for download tracking
   - Verify downloads are being recorded

## 5. Deployment

### 5.1 Prerequisites Checklist

Before deploying, ensure:
- [ ] R2 bucket "unsplash-cache" is created
- [ ] KV namespace "unsplash-cache-metadata" is created
- [ ] Unsplash API Access Key is obtained
- [ ] `wrangler.toml` is configured with correct bindings
- [ ] Secret `UNSPLASH_ACCESS_KEY` is set

### 5.2 Deployment Steps

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Test Locally** (optional):
   ```bash
   wrangler dev
   ```

3. **Deploy to Cloudflare**:
   ```bash
   wrangler deploy
   ```

4. **Verify Deployment**:
   - Visit the worker URL
   - Check that image is served
   - Verify headers are correct

5. **Monitor**:
   - Check Cloudflare Workers dashboard for errors
   - Monitor R2 and KV usage
   - Check Unsplash API usage

### 5.3 Post-Deployment Validation

1. **Functional Testing**:
   - Test cache miss scenario
   - Test cache hit scenario
   - Test cache refresh after 8 requests
   - Test error handling

2. **Performance Monitoring**:
   - Check worker execution time
   - Monitor R2 read/write operations
   - Monitor KV read/write operations
   - Track Unsplash API call frequency

3. **Cost Monitoring**:
   - R2 storage costs (minimal for images)
   - R2 operation costs (reads/writes)
   - KV operation costs (reads/writes)
   - Worker execution costs

## 6. Maintenance & Monitoring

### 6.1 Logging

Implement logging for:
- Cache hits and misses
- API calls to Unsplash
- Errors (R2, KV, API)
- Cache refresh operations

### 6.2 Metrics to Track

- Cache hit rate (hits / total requests)
- Average response time
- Unsplash API call frequency
- Error rate
- R2 storage usage

### 6.3 Troubleshooting

**Images not loading**:
- Check R2 bucket exists and has images
- Check KV metadata is correct
- Verify bindings in wrangler.toml

**High API usage**:
- Check cache hit rate
- Verify cache is being populated correctly
- Check for errors preventing cache population

**Stale images**:
- Verify cache refresh is triggering at 80% threshold
- Check served_count in metadata
- Manually trigger refresh if needed

---

## Summary

This plan outlines a complete Cloudflare Worker implementation that:
- Serves random Unsplash images via API
- Implements efficient caching with R2 and KV
- Maintains 10 images per cache key
- Refreshes 8 images after every 8 requests (80% threshold)
- Returns 302 redirects for cache misses
- Streams images from R2 for cache hits
- Includes proper error handling and attribution tracking
- Provides comprehensive testing and deployment guidance

