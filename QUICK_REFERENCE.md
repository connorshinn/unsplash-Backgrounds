# Quick Reference Guide

## Common Commands

### Development
```bash
# Install dependencies
npm install

# Run locally
npm run dev

# View logs
wrangler tail
```

### Deployment
```bash
# Deploy to Cloudflare
npm run deploy

# Set secret
wrangler secret put UNSPLASH_ACCESS_KEY

# List secrets
wrangler secret list
```

### R2 Management
```bash
# Create bucket
wrangler r2 bucket create unsplash-cache

# List buckets
wrangler r2 bucket list

# List objects in bucket
wrangler r2 object list unsplash-cache

# Delete object
wrangler r2 object delete unsplash-cache <key>

# Download object
wrangler r2 object get unsplash-cache <key> --file=output.jpg
```

### KV Management
```bash
# Create namespace
wrangler kv:namespace create "UNSPLASH_CACHE_METADATA"

# List namespaces
wrangler kv:namespace list

# List keys
wrangler kv:key list --binding=UNSPLASH_CACHE_METADATA

# Get value
wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"

# Delete key
wrangler kv:key delete --binding=UNSPLASH_CACHE_METADATA "default"

# Put value (for testing)
wrangler kv:key put --binding=UNSPLASH_CACHE_METADATA "test" "value"
```

## API Endpoints

### Basic Usage
```
# Random image
GET https://your-worker.workers.dev/

# With topics filter
GET https://your-worker.workers.dev/?topics=nature

# With multiple topics
GET https://your-worker.workers.dev/?topics=nature,landscape

# With query
GET https://your-worker.workers.dev/?query=mountain,sunset

# With collections
GET https://your-worker.workers.dev/?collections=1234567
```

### Response Headers

**Cache Miss (302 Redirect)**:
- `Location`: Optimized Unsplash image URL
- `X-Cache-Status: MISS`
- `X-Unsplash-Photographer`: Photographer name
- `Cache-Control: no-cache`

**Cache Hit (200 OK)**:
- `Content-Type`: image/jpeg or image/webp
- `X-Cache-Status: HIT`
- `X-Unsplash-Photographer`: Photographer name
- `Cache-Control: public, max-age=3600`

## Cache Behavior

### Cache Key Generation
- No parameters → `default`
- `?topics=nature` → `topics=nature`
- `?topics=nature,landscape` → `topics=landscape,nature` (sorted)
- `?collections=123&topics=nature` → `collections=123&topics=nature` (alphabetical)

### Cache Lifecycle
1. **First Request**: Cache miss → 302 redirect → Background cache population (10 images)
2. **Requests 1-8**: Cache hit → Serve images in rotation
3. **Request 8**: Trigger background refresh (replace 8 oldest images)
4. **Requests 9-10**: Continue serving from cache
5. **Request 16**: Trigger another refresh
6. **Repeat**: Continuous rotation with periodic refresh

### Cache Structure

**R2 Keys**:
```
default_0
default_1
...
default_9
topics=nature_0
topics=nature_1
...
```

**KV Metadata**:
```json
{
  "cache_key": "default",
  "total_images": 10,
  "next_index": 3,
  "served_count": 12,
  "images": [
    {
      "r2_key": "default_0",
      "photographer": "John Doe",
      "photo_id": "abc123",
      "content_type": "image/jpeg"
    }
    // ... 9 more
  ]
}
```

## Troubleshooting

### Worker not responding
```bash
# Check deployment status
wrangler deployments list

# View logs
wrangler tail

# Check bindings
cat wrangler.toml
```

### Cache not working
```bash
# Check KV metadata
wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"

# Check R2 objects
wrangler r2 object list unsplash-cache

# Clear cache and retry
wrangler kv:key delete --binding=UNSPLASH_CACHE_METADATA "default"
```

### Unsplash API errors
```bash
# Verify secret is set
wrangler secret list

# Check API key at Unsplash
# https://unsplash.com/oauth/applications

# Check rate limits
# Demo: 50 requests/hour
# Production: 5000 requests/hour
```

### Images not loading
```bash
# Test with curl
curl -I https://your-worker.workers.dev/

# Check response headers
curl -v https://your-worker.workers.dev/

# View detailed logs
wrangler tail
```

## Performance Tips

### Optimize Cache Hit Rate
- Use consistent parameter formats
- Avoid unnecessary cache keys
- Monitor cache hit rate in logs

### Reduce API Calls
- Cache is designed to minimize API calls
- 10 images cached per key
- Refresh only 8 images at a time
- Typical ratio: 1 API call per 8 requests

### Monitor Costs
```bash
# Check R2 usage
# Cloudflare Dashboard → R2 → unsplash-cache

# Check KV usage
# Cloudflare Dashboard → Workers → KV

# Check Worker usage
# Cloudflare Dashboard → Workers & Pages → unsplash-worker
```

## Useful Unsplash Collections

Popular collection IDs to try:
- `1065976` - Nature
- `3330445` - Landscapes
- `1154337` - Architecture
- `1065396` - Wallpapers
- `3356584` - Minimal

Popular topics:
- `nature`
- `landscape`
- `architecture`
- `travel`
- `minimal`
- `abstract`
- `animals`
- `food`

## Testing Checklist

- [ ] Cache miss returns 302
- [ ] Cache hit returns 200
- [ ] Different images rotate
- [ ] Cache refreshes after 8 requests
- [ ] Parameter validation works
- [ ] Different params create separate caches
- [ ] Error handling is graceful
- [ ] Performance is acceptable
- [ ] Logs show no errors
- [ ] Unsplash attribution is tracked

## Monitoring Metrics

Key metrics to track:
- **Cache Hit Rate**: Should be > 80% after warmup
- **Response Time**: Cache hits < 200ms, misses < 1000ms
- **Error Rate**: Should be < 1%
- **API Calls**: Should be ~1 per 8 requests
- **R2 Storage**: ~1-2 MB per cache key (10 images)

## Support Resources

- **Cloudflare Workers Docs**: https://developers.cloudflare.com/workers/
- **Cloudflare R2 Docs**: https://developers.cloudflare.com/r2/
- **Cloudflare KV Docs**: https://developers.cloudflare.com/workers/runtime-apis/kv/
- **Unsplash API Docs**: https://unsplash.com/documentation
- **Wrangler CLI Docs**: https://developers.cloudflare.com/workers/wrangler/

## Quick Fixes

### Reset Everything
```bash
# Delete KV keys
wrangler kv:key list --binding=UNSPLASH_CACHE_METADATA | while read key; do
  wrangler kv:key delete --binding=UNSPLASH_CACHE_METADATA "$key"
done

# Delete R2 objects (use dashboard or delete individually)

# Redeploy
npm run deploy
```

### Update API Key
```bash
wrangler secret put UNSPLASH_ACCESS_KEY
# Paste new key when prompted
```

### Update Bindings
1. Edit `wrangler.toml`
2. Run `npm run deploy`

### View Full Logs
```bash
# Real-time
wrangler tail

# With filters
wrangler tail --status error
wrangler tail --status ok
```

