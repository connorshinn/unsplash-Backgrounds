# Testing Guide

This guide provides test scenarios to validate the Unsplash Worker implementation.

## Prerequisites

Before testing, ensure:
- Worker is deployed or running locally (`npm run dev`)
- R2 bucket and KV namespace are created
- Unsplash API key is configured

## Manual Testing Scenarios

### Test 1: Cache Miss (First Request)

**Objective**: Verify that the first request returns a redirect and populates the cache.

**Steps**:
1. Clear cache (delete KV entries and R2 objects if testing repeatedly)
2. Make a request: `curl -I https://your-worker.workers.dev/`

**Expected Result**:
```
HTTP/2 302
location: https://images.unsplash.com/photo-...?auto=format&q=65&cs=origin&fit=clamp
x-cache-status: MISS
x-unsplash-photographer: [Photographer Name]
cache-control: no-cache
```

**Validation**:
- Status code is 302
- Location header contains Unsplash image URL with optimization parameters
- X-Cache-Status is MISS
- X-Unsplash-Photographer is present

**Wait 5-10 seconds for background cache population**

### Test 2: Cache Hit (Subsequent Request)

**Objective**: Verify that subsequent requests serve images from cache.

**Steps**:
1. Make another request: `curl -I https://your-worker.workers.dev/`

**Expected Result**:
```
HTTP/2 200
content-type: image/jpeg
x-cache-status: HIT
x-unsplash-photographer: [Photographer Name]
cache-control: public, max-age=3600
```

**Validation**:
- Status code is 200
- Content-Type is image/jpeg (or image/webp)
- X-Cache-Status is HIT
- Cache-Control allows caching

### Test 3: Different Images on Cache Hits

**Objective**: Verify that different images are served in round-robin fashion.

**Steps**:
1. Make 10 requests and save the photographer names:
   ```bash
   for i in {1..10}; do
     curl -I https://your-worker.workers.dev/ 2>&1 | grep -i "x-unsplash-photographer"
   done
   ```

**Expected Result**:
- All 10 requests return status 200 (cache hit)
- Different photographer names appear (cycling through the 10 cached images)

### Test 4: Cache Refresh After 8 Requests

**Objective**: Verify that cache refreshes after serving 8 images.

**Steps**:
1. Make 8 requests to trigger refresh
2. Wait 10 seconds for background refresh
3. Check R2 bucket - should still have 10 images
4. Make more requests - should see some new images

**Expected Result**:
- After 8 requests, cache refresh is triggered in background
- R2 bucket maintains 10 images
- New images appear in subsequent requests

### Test 5: Parameter Validation - Collections/Topics with Query

**Objective**: Verify that using collections/topics with query returns 400 error.

**Steps**:
1. Make request: `curl -I https://your-worker.workers.dev/?topics=nature&query=mountain`

**Expected Result**:
```
HTTP/2 400
```

**Validation**:
- Status code is 400
- Response body: "Cannot use collections/topics with query parameter"

### Test 6: Different Cache Keys

**Objective**: Verify that different parameters create separate caches.

**Steps**:
1. Request with topics: `curl -I https://your-worker.workers.dev/?topics=nature`
2. Request with query: `curl -I https://your-worker.workers.dev/?query=mountain`
3. Request with no params: `curl -I https://your-worker.workers.dev/`

**Expected Result**:
- First request for each parameter set returns 302 (cache miss)
- Subsequent requests return 200 (cache hit)
- Different images for different parameter sets

### Test 7: Cache Key Sorting

**Objective**: Verify that parameter order doesn't affect cache key.

**Steps**:
1. Request: `curl -I https://your-worker.workers.dev/?topics=nature,landscape`
2. Request: `curl -I https://your-worker.workers.dev/?topics=landscape,nature`

**Expected Result**:
- First request returns 302 (cache miss)
- Second request returns 200 (cache hit) - same cache key due to sorting

### Test 8: Binding Validation

**Objective**: Verify that missing bindings return appropriate errors.

**Steps**:
1. Temporarily remove a binding from wrangler.toml
2. Deploy and make a request

**Expected Result**:
- Status 500
- Error message indicates which binding is missing

### Test 9: Unsplash API Error Handling

**Objective**: Verify graceful handling of API errors.

**Steps**:
1. Use an invalid API key (temporarily)
2. Make a request

**Expected Result**:
- Status 502 (Bad Gateway)
- Error is logged

### Test 10: R2 Fallback

**Objective**: Verify fallback to cache miss if R2 image is missing.

**Steps**:
1. Manually delete an image from R2 bucket
2. Make a request that would serve that image

**Expected Result**:
- Falls back to cache miss workflow
- Returns 302 redirect
- Repopulates cache in background

## Automated Testing with cURL

Save this script as `test.sh`:

```bash
#!/bin/bash

WORKER_URL="https://your-worker.workers.dev"

echo "Test 1: Cache Miss (First Request)"
curl -I "$WORKER_URL/" 2>&1 | grep -E "HTTP|x-cache-status|location"
echo ""

sleep 5

echo "Test 2: Cache Hit (Second Request)"
curl -I "$WORKER_URL/" 2>&1 | grep -E "HTTP|x-cache-status|content-type"
echo ""

echo "Test 3: Parameter Validation Error"
curl -I "$WORKER_URL/?topics=nature&query=mountain" 2>&1 | grep -E "HTTP"
echo ""

echo "Test 4: Topics Filter"
curl -I "$WORKER_URL/?topics=nature" 2>&1 | grep -E "HTTP|x-cache-status"
echo ""

sleep 5

echo "Test 5: Topics Filter Cache Hit"
curl -I "$WORKER_URL/?topics=nature" 2>&1 | grep -E "HTTP|x-cache-status"
echo ""

echo "Test 6: Query Filter"
curl -I "$WORKER_URL/?query=mountain" 2>&1 | grep -E "HTTP|x-cache-status"
echo ""

echo "All tests completed!"
```

Run with:
```bash
chmod +x test.sh
./test.sh
```

## Checking Cache State

### View KV Metadata

```bash
# List all keys
wrangler kv:key list --binding=UNSPLASH_CACHE_METADATA

# Get specific cache metadata
wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"
```

### View R2 Objects

```bash
# List all objects in bucket
wrangler r2 object list unsplash-cache
```

### Clear Cache (for testing)

```bash
# Delete KV key
wrangler kv:key delete --binding=UNSPLASH_CACHE_METADATA "default"

# Delete R2 objects
wrangler r2 object delete unsplash-cache default_0
wrangler r2 object delete unsplash-cache default_1
# ... repeat for all 10 images
```

## Performance Testing

### Test Response Times

```bash
# Cache miss
time curl -I https://your-worker.workers.dev/

# Cache hit (run after cache is populated)
time curl -I https://your-worker.workers.dev/
```

**Expected**:
- Cache miss: ~500-1000ms (includes Unsplash API call)
- Cache hit: ~50-200ms (serves from R2)

### Load Testing

Use a tool like `ab` (Apache Bench) or `wrk`:

```bash
# 100 requests, 10 concurrent
ab -n 100 -c 10 https://your-worker.workers.dev/
```

**Expected**:
- First request: 302 redirect
- Remaining 99 requests: 200 OK (cache hits)
- No errors

## Monitoring

### Real-time Logs

```bash
wrangler tail
```

Watch for:
- Cache hits and misses
- API calls to Unsplash
- Cache refresh operations
- Any errors

### Cloudflare Dashboard

1. Go to Workers & Pages → unsplash-worker → Metrics
2. Monitor:
   - Request count
   - Error rate
   - CPU time
   - Duration

## Troubleshooting Tests

### Test fails with "R2 bucket not configured"
- Verify R2 bucket exists: `wrangler r2 bucket list`
- Check wrangler.toml binding

### Test fails with "Unsplash API error"
- Verify API key is set: `wrangler secret list`
- Check Unsplash API rate limits
- Verify API key is valid at https://unsplash.com/oauth/applications

### Cache not populating
- Wait longer (background processing takes 5-10 seconds)
- Check worker logs: `wrangler tail`
- Verify R2 bucket: `wrangler r2 object list unsplash-cache`

### Images not rotating
- Make more requests (need to cycle through all 10)
- Check metadata: `wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"`
- Verify next_index is incrementing

## Success Criteria

All tests pass if:
- ✅ First request returns 302 with cache miss
- ✅ Subsequent requests return 200 with cache hit
- ✅ Different images are served in rotation
- ✅ Cache refreshes after 8 requests
- ✅ Parameter validation works correctly
- ✅ Different parameters create separate caches
- ✅ Cache key sorting works correctly
- ✅ Error handling is graceful
- ✅ Performance is acceptable (cache hits < 200ms)
- ✅ No errors in logs during normal operation

