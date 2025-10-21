# Unsplash Cloudflare Worker

Serve random Unsplash images with intelligent caching. Perfect for dynamic backgrounds, hero images, and placeholders.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/connorshinn/unsplash-Backgrounds)

## Features

- 🖼️ Random landscape images from Unsplash
- 🎯 Filter by topics, collections, or search terms
- ⚡ Fast caching with Cloudflare R2 and KV
- 🔄 Automatic image rotation (10 images per cache)
- 📊 Metadata in response headers (photographer, dimensions, file size)
- 🚫 No client-side caching - fresh images on every refresh

## Deploy

Click the **Deploy to Cloudflare Workers** button above. This will:

1. Fork the repository to your GitHub account
2. Guide you through Cloudflare authentication
3. Automatically create required resources (R2 bucket, KV namespace)
4. Deploy the worker to your Cloudflare account

**After deployment, set your Unsplash API key:**

1. Get your API key from [unsplash.com/developers](https://unsplash.com/developers)
   - Sign up or log in
   - Create a new application
   - Copy your **Access Key**

2. Add the API key to your worker:
   - Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
   - Navigate to **Workers & Pages**
   - Click on your **unsplash-worker**
   - Go to **Settings** → **Variables**
   - Click **Add variable**
   - Name: `UNSPLASH_ACCESS_KEY`
   - Value: Paste your Unsplash Access Key
   - Check **Encrypt** (to make it a secret)
   - Click **Save**

Your worker is now ready to use! 🎉

## Usage

### Basic Examples

```
# Random image
https://your-worker.workers.dev/

# Nature images
https://your-worker.workers.dev/?topics=nature

# Search query
https://your-worker.workers.dev/?query=mountain

# With dimensions
https://your-worker.workers.dev/?topics=wallpapers&w=1920&h=1080
```

### Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `topics` | Topic name or ID | `?topics=nature` |
| `query` | Search term | `?query=mountain` |
| `collections` | Collection ID | `?collections=1065976` |
| `w` | Width in pixels | `?w=1920` |
| `h` | Height in pixels | `?h=1080` |

### Supported Topics

`wallpapers`, `nature`, `people`, `architecture`, `travel`, `animals`, `food-drink`, `athletics`, `business-work`, `fashion-beauty`, `film`, `health-wellness`, `spirituality`, `current-events`, `arts-culture`, `3d-renders`

### HTML Examples

```html
<!-- Background image -->
<div style="background-image: url('https://your-worker.workers.dev/?topics=nature&w=1920&h=1080');"></div>

<!-- Image tag -->
<img src="https://your-worker.workers.dev/?topics=wallpapers" alt="Random wallpaper">

<!-- JavaScript -->
<script>
  const url = 'https://your-worker.workers.dev/?topics=nature';
  document.body.style.backgroundImage = `url('${url}')`;
</script>
```

## Response Headers

Every response includes metadata about the image:

| Header | Description |
|--------|-------------|
| `X-Cache-Status` | `HIT` or `MISS` |
| `X-Unsplash-Photographer` | Photographer name |
| `X-Image-Width` | Image width |
| `X-Image-Height` | Image height |
| `X-Image-Source-URL` | Link to photo on Unsplash |
| `X-Image-File-Size-MB` | File size (cache hits only) |

**View headers:**
```bash
curl -I "https://your-worker.workers.dev/?topics=nature"
```

## How It Works

**Caching:**
- Stores 10 images per parameter set in R2 + KV
- Rotates through images on each request
- Refreshes 8 oldest images after every 8 requests
- No client-side caching (fresh images on every page refresh)

**First Request:**
1. Cache miss → 302 redirect to Unsplash
2. Background: Fetch and cache 10 images

**Subsequent Requests:**
1. Cache hit → Serve next image in rotation
2. Every 8 requests → Refresh 8 oldest images

## Viewing Logs

To view your worker's logs:

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages**
3. Click on your **unsplash-worker**
4. Click **Logs** tab
5. Click **Begin log stream**

You'll see real-time logs of requests, cache hits/misses, and any errors.

## Troubleshooting

**Worker returns 502 or errors:**
1. Check that your Unsplash API key is set correctly:
   - Cloudflare Dashboard → Workers & Pages → unsplash-worker → Settings → Variables
   - Verify `UNSPLASH_ACCESS_KEY` is present and encrypted
2. Verify your API key is valid at [unsplash.com/oauth/applications](https://unsplash.com/oauth/applications)
3. Check the logs (see "Viewing Logs" section above)

**Images not rotating:**
- Clear browser cache or use Incognito mode
- Make more requests (cycles through 10 images)

**Topics not working:**
- Use supported topic slugs (see list above)
- Check the logs for error messages

## Cost

Cloudflare's free tier is generous and covers typical usage:

| Service | Free Tier |
|---------|-----------|
| Workers | 100,000 requests/day |
| R2 Storage | 10 GB |
| R2 Operations | 10M reads, 1M writes/month |
| KV Operations | 100,000 reads/day, 1,000 writes/day |

**Typical usage: $0/month** ✅

## Advanced

**Custom domain:**
1. Go to Cloudflare Dashboard → Workers & Pages → unsplash-worker
2. Click **Triggers** tab
3. Click **Add Custom Domain**
4. Enter your domain (must be on Cloudflare)
5. Click **Add Custom Domain**

**Rate limits:**
- Demo API: 50 requests/hour
- Production API: 5,000 requests/hour (apply at [unsplash.com/oauth/applications](https://unsplash.com/oauth/applications))

**Viewing cached data:**
1. Go to Cloudflare Dashboard
2. For R2 images: **R2** → **unsplash-cache** bucket
3. For KV metadata: **Workers & Pages** → **KV** → **UNSPLASH_CACHE_METADATA**

## Attribution

This worker uses the [Unsplash API](https://unsplash.com/developers). Please:
- Provide photographer attribution (see `X-Unsplash-Photographer` header)
- Link back to Unsplash when possible (see `X-Image-Source-URL` header)
- Follow [Unsplash API Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines)

## License

MIT License

