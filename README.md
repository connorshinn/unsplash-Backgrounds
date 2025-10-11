# Unsplash Cloudflare Worker

A high-performance Cloudflare Worker that serves random Unsplash images with intelligent caching using R2 and KV storage. Perfect for dynamic backgrounds, hero images, and content placeholders.

## ✨ Features

- 🖼️ **Random landscape images** from Unsplash's vast library
- 🎯 **Smart filtering** by topics, collections, or search queries
- ⚡ **Intelligent caching** with R2 (images) and KV (metadata)
- 🔄 **Automatic rotation** through 10 cached images per parameter set
- 🔁 **Auto-refresh** replaces 80% of cache periodically
- 📊 **Rich metadata** in response headers (photographer, dimensions, file size)
- 🚫 **No client-side caching** - fresh images on every page refresh
- 🎨 **Topic slug conversion** - use friendly names like "nature" instead of IDs
- 📸 **Proper attribution** tracking for Unsplash photographers

## 🚀 Quick Start

### Prerequisites

- [Cloudflare account](https://cloudflare.com) (free tier works!)
- [Node.js](https://nodejs.org/) installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed globally

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Get Unsplash API Key

1. Go to [Unsplash Developers](https://unsplash.com/developers)
2. Click "Register as a developer"
3. Create a new application
4. Copy your **Access Key** (you'll need this later)

> **Note**: Demo accounts get 50 requests/hour. Apply for production access for 5,000 requests/hour.

### 3. Create Cloudflare Resources

```bash
# Create R2 bucket for image storage
wrangler r2 bucket create unsplash-cache

# Create KV namespace for metadata
wrangler kv:namespace create "UNSPLASH_CACHE_METADATA"
```

**Important**: Copy the KV namespace ID from the output!

### 4. Configure wrangler.toml

Edit `wrangler.toml` and replace the KV namespace ID:

```toml
[[kv_namespaces]]
binding = "UNSPLASH_CACHE_METADATA"
id = "YOUR_NAMESPACE_ID_HERE"  # Replace with actual ID from step 3
```

### 5. Set Unsplash API Secret

```bash
wrangler secret put UNSPLASH_ACCESS_KEY
```

Paste your Unsplash Access Key when prompted.

### 6. Install Dependencies & Deploy

```bash
npm install
npm run deploy
```

Your worker is now live! 🎉

## 📖 Usage

### Basic Examples

```bash
# Random image
https://your-worker.workers.dev/

# Nature images
https://your-worker.workers.dev/?topics=nature

# Search for mountains
https://your-worker.workers.dev/?query=mountain,sunset

# Specific collection
https://your-worker.workers.dev/?collections=1065976

# With custom dimensions
https://your-worker.workers.dev/?topics=wallpapers&w=1920&h=1080
```

### Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `topics` | Filter by topic slug or ID | `?topics=nature` or `?topics=6sMVjTLSkeQ` |
| `query` | Search term(s) | `?query=mountain,sunset` |
| `collections` | Collection ID(s) | `?collections=1065976` |
| `w` | Image width in pixels | `?w=1920` |
| `h` | Image height in pixels | `?h=1080` |

> **Note**: Cannot combine `topics`/`collections` with `query` in the same request.

### Supported Topic Slugs

The worker automatically converts friendly topic names to Unsplash topic IDs:

| Slug | Description |
|------|-------------|
| `wallpapers` | HD wallpapers for desktop and mobile |
| `nature` | Natural landscapes and scenery |
| `people` | Portraits and people photography |
| `architecture` | Buildings and architectural photography |
| `travel` | Travel and destination photography |
| `animals` | Wildlife and pet photography |
| `food-drink` | Culinary photography |
| `athletics` | Sports and athletic photography |
| `business-work` | Professional and workplace imagery |
| `fashion-beauty` | Fashion and beauty photography |
| `film` | Cinematic and film-related images |
| `health-wellness` | Health and wellness imagery |
| `spirituality` | Spiritual and contemplative images |
| `current-events` | Timely and newsworthy images |
| `arts-culture` | Art and cultural imagery |
| `3d-renders` | 3D rendered images |

You can also use topic IDs directly (e.g., `?topics=bo8jQKTaE0Y`).

### HTML Integration

```html
<!-- Simple background image -->
<div style="background-image: url('https://your-worker.workers.dev/?topics=nature&w=1920&h=1080');">
  Your content here
</div>

<!-- Responsive image -->
<img src="https://your-worker.workers.dev/?topics=wallpapers"
     alt="Random wallpaper"
     style="width: 100%; height: auto;">

<!-- Dynamic with JavaScript -->
<script>
  const workerUrl = 'https://your-worker.workers.dev/';
  const params = new URLSearchParams({
    topics: 'nature',
    w: window.innerWidth,
    h: window.innerHeight
  });

  document.body.style.backgroundImage = `url('${workerUrl}?${params}')`;
</script>
```

## 🔧 Configuration

### Environment Variables

Set via Wrangler secrets:

```bash
# Required: Unsplash API Access Key
wrangler secret put UNSPLASH_ACCESS_KEY
```

### wrangler.toml Settings

```toml
name = "unsplash-worker"              # Worker name
main = "src/index.js"                 # Entry point
compatibility_date = "2024-01-01"     # Cloudflare compatibility date

# R2 bucket for image storage
[[r2_buckets]]
binding = "UNSPLASH_CACHE"
bucket_name = "unsplash-cache"

# KV namespace for cache metadata
[[kv_namespaces]]
binding = "UNSPLASH_CACHE_METADATA"
id = "YOUR_NAMESPACE_ID"              # Replace with your KV namespace ID
```

## 📊 Response Headers

Every response includes rich metadata:

| Header | Description | Example |
|--------|-------------|---------|
| `X-Cache-Status` | Cache hit or miss | `HIT` or `MISS` |
| `X-Unsplash-Photographer` | Photographer name | `Jane Smith` |
| `X-Image-Width` | Image width | `1920` or `auto` |
| `X-Image-Height` | Image height | `1080` or `auto` |
| `X-Image-Source-URL` | Unsplash photo page | `https://unsplash.com/photos/abc123` |
| `X-Image-File-Size` | File size in bytes | `245678` (cache hits only) |
| `X-Image-File-Size-KB` | File size in KB | `239.92` (cache hits only) |
| `X-Image-File-Size-MB` | File size in MB | `0.23` (cache hits only) |
| `X-Unsplash-Category` | Filter used | `topics: nature` or `random` |

### Viewing Metadata

**Browser DevTools:**
1. Open DevTools (F12)
2. Go to Network tab
3. Click on the request
4. View Response Headers

**Command Line:**
```bash
curl -I "https://your-worker.workers.dev/?topics=nature"
```

**JavaScript:**
```javascript
const response = await fetch('https://your-worker.workers.dev/?topics=nature');
const photographer = response.headers.get('X-Unsplash-Photographer');
const sourceUrl = response.headers.get('X-Image-Source-URL');
console.log(`Photo by ${photographer}: ${sourceUrl}`);
```

## 🗄️ Cache Behavior

### Server-Side Cache (R2 + KV)

The worker maintains an intelligent cache system:

- **10 images per parameter set** (e.g., 10 nature images, 10 wallpapers, etc.)
- **Automatic rotation** - each request serves the next image in sequence
- **Background refresh** - replaces 8 oldest images after every 8 requests
- **Separate caches** - different parameters create separate caches

**Cache Lifecycle:**
1. **First request** → Cache miss → 302 redirect → Background: fetch & cache 10 images
2. **Requests 1-8** → Cache hits → Serve images 0-7 in rotation
3. **Request 8** → Trigger background refresh (replace images 0-7)
4. **Requests 9-16** → Continue rotation → Refresh again at request 16
5. **Repeat** → Continuous rotation with periodic refreshes

### Client-Side Cache (Browser)

**Disabled by default** to ensure image rotation works:

- Headers: `Cache-Control: no-store, no-cache, must-revalidate`
- Each page refresh requests a new image from the worker
- Worker serves the next image in its rotation
- Users see different images on every refresh

**Why?** If browsers cached images, users would see the same image for hours, defeating the rotation feature.

### Cache Keys

Cache keys are generated from parameters (sorted alphabetically):

| Request | Cache Key |
|---------|-----------|
| `/?topics=nature` | `topics=nature` |
| `/?topics=nature&w=1920&h=1080` | `height=1080&topics=nature&width=1920` |
| `/?query=mountain` | `query=mountain` |
| `/?collections=123&topics=nature` | `collections=123&topics=nature` |
| No parameters | `default` |

## 🛠️ Development

### Local Development

```bash
# Start local dev server
npm run dev

# Access at http://localhost:8787
```

### View Logs

```bash
# Real-time logs
wrangler tail

# Filter by status
wrangler tail --status error
wrangler tail --status ok
```

### Testing

```bash
# Test basic functionality
curl -I https://your-worker.workers.dev/

# Test with parameters
curl -I "https://your-worker.workers.dev/?topics=nature&w=1920&h=1080"

# Check cache status
wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "topics=nature"

# List cached images
wrangler r2 object list unsplash-cache
```

### Updating the Worker

After making code changes:

```bash
npm run deploy
```

Changes are live immediately!

## 🔍 Troubleshooting

### Error: "R2 bucket not configured"

**Solution:**
```bash
# Verify bucket exists
wrangler r2 bucket list

# Create if missing
wrangler r2 bucket create unsplash-cache

# Check wrangler.toml has correct binding
```

### Error: "KV namespace not configured"

**Solution:**
```bash
# Verify namespace exists
wrangler kv:namespace list

# Create if missing
wrangler kv:namespace create "UNSPLASH_CACHE_METADATA"

# Update wrangler.toml with the namespace ID
```

### Error: "Unsplash API key not configured"

**Solution:**
```bash
# Set the secret
wrangler secret put UNSPLASH_ACCESS_KEY

# Verify it's set
wrangler secret list
```

### Worker returns 502 Bad Gateway

**Possible causes:**
- Invalid Unsplash API key
- Rate limit exceeded (50/hour for demo accounts)
- Network issues

**Solution:**
```bash
# Check logs
wrangler tail

# Verify API key at https://unsplash.com/oauth/applications
# Consider upgrading to production API access
```

### Images not rotating

**Solution:**
- Make more requests (need to cycle through all 10 images)
- Clear browser cache or use Incognito mode
- Check that client-side caching is disabled (see headers)

### Cache not populating

**Solution:**
- Wait 10-15 seconds after first request (background processing)
- Check R2 bucket: `wrangler r2 object list unsplash-cache`
- Check logs: `wrangler tail`

### Topics not working correctly

**Issue:** Getting random images instead of filtered results

**Solution:**
- Use topic slugs from the supported list (e.g., `nature`, `wallpapers`)
- Or use topic IDs directly (e.g., `bo8jQKTaE0Y`)
- Check logs to see if slug is being converted: `wrangler tail`

## 💰 Cost Estimation

Based on Cloudflare's pricing (free tier is generous!):

| Service | Free Tier | Paid Pricing |
|---------|-----------|--------------|
| **Workers** | 100,000 requests/day | $0.50/million requests |
| **R2 Storage** | 10 GB | $0.015/GB/month |
| **R2 Reads** | 10 million/month | $0.36/million |
| **R2 Writes** | 1 million/month | $4.50/million |
| **KV Reads** | 100,000/day | $0.50/million |
| **KV Writes** | 1,000/day | $5.00/million |

**Typical usage (1,000 requests/day):**
- Workers: ✅ Free (well under 100k/day)
- R2 Storage: ✅ Free (~10 MB for 100 cached images)
- R2 Operations: ✅ Free (~1,000 reads/day, ~125 writes/day)
- KV Operations: ✅ Free (~1,000 reads/day, ~125 writes/day)

**Estimated monthly cost: $0** for typical usage! 🎉

## 🚀 Advanced Usage

### Custom Domain

Add a custom domain to your worker:

1. Go to Cloudflare Dashboard → Workers & Pages → unsplash-worker
2. Click "Triggers" tab
3. Click "Add Custom Domain"
4. Enter your domain (must be on Cloudflare)
5. Click "Add Custom Domain"

Now use: `https://images.yourdomain.com/?topics=nature`

### Rate Limiting

**Demo API (default):**
- 50 requests/hour to Unsplash API
- Perfect for testing and small projects

**Production API:**
- 5,000 requests/hour to Unsplash API
- Apply at https://unsplash.com/oauth/applications
- Required for production use

**Worker caching reduces API calls:**
- 1 API call fetches 10 images
- Cache refresh uses 8 API calls per 8 requests
- Typical ratio: ~1 API call per 8-10 worker requests

### Monitoring

**View metrics in Cloudflare Dashboard:**
- Workers & Pages → unsplash-worker → Metrics
- Track: Request count, error rate, execution time

**Key metrics to monitor:**
- **Cache hit rate**: Should be >80% after warmup
- **Response time**: Cache hits <200ms, misses <1000ms
- **Error rate**: Should be <1%
- **API usage**: Stay under your Unsplash rate limit

### Cache Management

```bash
# View cache metadata
wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"

# List all cache keys
wrangler kv:key list --binding=UNSPLASH_CACHE_METADATA

# Delete a specific cache
wrangler kv:key delete --binding=UNSPLASH_CACHE_METADATA "topics=nature"

# List cached images in R2
wrangler r2 object list unsplash-cache

# Download a cached image
wrangler r2 object get unsplash-cache default_0 --file=image.jpg
```

### Adding More Topics

To support additional topic slugs:

1. Find the topic on Unsplash (e.g., https://unsplash.com/t/minimal)
2. Get the topic ID via API:
   ```bash
   curl "https://api.unsplash.com/topics/minimal?client_id=YOUR_KEY"
   ```
3. Add to `TOPIC_SLUG_TO_ID` in `src/index.js`:
   ```javascript
   const TOPIC_SLUG_TO_ID = {
     // ... existing topics
     'minimal': 'THE_TOPIC_ID_HERE',
   };
   ```
4. Deploy: `npm run deploy`

## 📚 Popular Collections & Topics

### Recommended Collections

| Collection ID | Description |
|---------------|-------------|
| `1065976` | Nature |
| `3330445` | Landscapes |
| `1154337` | Architecture |
| `1065396` | Wallpapers |
| `3356584` | Minimal |

Usage: `?collections=1065976`

### Browse More

- **Collections**: https://unsplash.com/collections
- **Topics**: https://unsplash.com/t/

## 🤝 Contributing

Contributions are welcome! Areas for improvement:

- Add more topic slug mappings
- Improve error handling
- Add support for portrait orientation
- Implement dynamic topic resolution
- Add image format preferences (WebP, AVIF)

## 📄 License

MIT License - feel free to use in your projects!

## 🙏 Attribution

This worker uses the [Unsplash API](https://unsplash.com/developers). Please ensure you:

- ✅ Provide photographer attribution (available in `X-Unsplash-Photographer` header)
- ✅ Link back to Unsplash when possible (use `X-Image-Source-URL` header)
- ✅ Follow [Unsplash API Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines)

The worker automatically tracks photo downloads for proper attribution.

## 📖 Additional Documentation

- **GETTING_STARTED.md** - Detailed step-by-step setup guide
- **DEPLOYMENT.md** - Comprehensive deployment instructions
- **TOPIC_SLUG_FIX.md** - Technical details on topic slug conversion
- **VIEWING_METADATA.md** - How to access and use response metadata
- **QUICK_REFERENCE.md** - Common commands and quick tips

## 🆘 Support

**Having issues?**

1. Check the troubleshooting section above
2. Review logs: `wrangler tail`
3. Check [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
4. Check [Unsplash API docs](https://unsplash.com/documentation)

**Resources:**
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare KV](https://developers.cloudflare.com/workers/runtime-apis/kv/)
- [Unsplash API](https://unsplash.com/documentation)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

---

**Made with ❤️ using Cloudflare Workers and Unsplash**

