# Getting Started - Step by Step

Follow this checklist to get your Unsplash Worker up and running.

## ☐ Step 1: Install Wrangler CLI

```bash
npm install -g wrangler
```

Verify installation:
```bash
wrangler --version
```

## ☐ Step 2: Authenticate with Cloudflare

```bash
wrangler login
```

This will open a browser window to authenticate.

## ☐ Step 3: Get Unsplash API Key

1. Go to https://unsplash.com/developers
2. Click "Register as a developer"
3. Create a new application:
   - **Application name**: Your choice (e.g., "My Background Images")
   - **Description**: Brief description of your use case
4. Copy the **Access Key** (you'll need this later)

## ☐ Step 4: Create R2 Bucket

```bash
wrangler r2 bucket create unsplash-cache
```

Expected output:
```
✅ Created bucket 'unsplash-cache'
```

## ☐ Step 5: Create KV Namespace

```bash
wrangler kv:namespace create "UNSPLASH_CACHE_METADATA"
```

Expected output:
```
✅ Created namespace with id "abc123def456..."
```

**IMPORTANT**: Copy the namespace ID from the output!

## ☐ Step 6: Update wrangler.toml

1. Open `wrangler.toml` in your editor
2. Find this line:
   ```toml
   id = "YOUR_KV_NAMESPACE_ID"
   ```
3. Replace `YOUR_KV_NAMESPACE_ID` with the actual ID from Step 5
4. Save the file

Example:
```toml
[[kv_namespaces]]
binding = "UNSPLASH_CACHE_METADATA"
id = "abc123def456789"
```

## ☐ Step 7: Set Unsplash API Secret

```bash
wrangler secret put UNSPLASH_ACCESS_KEY
```

When prompted, paste your Unsplash Access Key from Step 3 and press Enter.

Expected output:
```
✅ Successfully created secret for key: UNSPLASH_ACCESS_KEY
```

## ☐ Step 8: Install Dependencies

```bash
npm install
```

## ☐ Step 9: Deploy to Cloudflare

```bash
npm run deploy
```

Expected output:
```
✅ Uploaded unsplash-worker
✅ Published unsplash-worker
   https://unsplash-worker.your-subdomain.workers.dev
```

**Copy your worker URL!**

## ☐ Step 10: Test Your Worker

### Test 1: First Request (Cache Miss)

Open your worker URL in a browser or use curl:
```bash
curl -I https://unsplash-worker.your-subdomain.workers.dev/
```

Expected:
- Status: `302 Found`
- Header: `X-Cache-Status: MISS`
- You should be redirected to an Unsplash image

### Test 2: Wait for Cache Population

Wait 5-10 seconds for the background cache population to complete.

### Test 3: Second Request (Cache Hit)

Refresh the page or run curl again:
```bash
curl -I https://unsplash-worker.your-subdomain.workers.dev/
```

Expected:
- Status: `200 OK`
- Header: `X-Cache-Status: HIT`
- Image loads directly (no redirect)

### Test 4: Verify Different Images

Make several more requests. You should see different images each time (cycling through 10 cached images).

## ☐ Step 11: Verify Cache in Dashboard

1. Go to https://dash.cloudflare.com
2. Navigate to **R2** → **unsplash-cache**
3. You should see 10 objects (default_0 through default_9)

## ☐ Step 12: Test with Parameters

Try different query parameters:

```bash
# Nature images
curl -I https://your-worker.workers.dev/?topics=nature

# Mountain images
curl -I https://your-worker.workers.dev/?query=mountain

# Specific collection
curl -I https://your-worker.workers.dev/?collections=1065976
```

Each parameter set creates a separate cache.

## ☐ Step 13: Monitor Logs (Optional)

In a terminal, run:
```bash
wrangler tail
```

This shows real-time logs from your worker. Make some requests and watch the logs.

## Troubleshooting

### ❌ Error: "R2 bucket not configured"

**Solution**: 
- Verify bucket exists: `wrangler r2 bucket list`
- Check `wrangler.toml` has correct binding

### ❌ Error: "KV namespace not configured"

**Solution**:
- Verify namespace exists: `wrangler kv:namespace list`
- Check `wrangler.toml` has correct namespace ID

### ❌ Error: "Unsplash API key not configured"

**Solution**:
- Set the secret: `wrangler secret put UNSPLASH_ACCESS_KEY`
- Verify: `wrangler secret list`

### ❌ Worker returns 502 Bad Gateway

**Solution**:
- Check Unsplash API key is valid
- Check rate limits (50/hour for demo accounts)
- View logs: `wrangler tail`

### ❌ Cache not populating

**Solution**:
- Wait longer (10-15 seconds)
- Check logs: `wrangler tail`
- Verify R2 bucket: `wrangler r2 object list unsplash-cache`

### ❌ Images not rotating

**Solution**:
- Make more requests (need to cycle through all 10)
- Check metadata: `wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"`

## Next Steps

### ✅ You're Done! Your worker is live.

**What you can do now**:

1. **Use it as a background image source**:
   ```html
   <div style="background-image: url('https://your-worker.workers.dev/')">
   ```

2. **Add a custom domain** (optional):
   - Go to Cloudflare Dashboard → Workers & Pages → unsplash-worker
   - Click "Triggers" → "Add Custom Domain"

3. **Monitor usage**:
   - Cloudflare Dashboard → Workers & Pages → unsplash-worker → Metrics

4. **Explore different image sources**:
   - Browse Unsplash collections: https://unsplash.com/collections
   - Browse Unsplash topics: https://unsplash.com/t/

5. **Read the documentation**:
   - `README.md` - Project overview
   - `DEPLOYMENT.md` - Detailed deployment guide
   - `TESTING.md` - Testing scenarios
   - `QUICK_REFERENCE.md` - Common commands and tips

## Quick Reference

### Common URLs

```bash
# Random image
https://your-worker.workers.dev/

# Nature images
https://your-worker.workers.dev/?topics=nature

# Search query
https://your-worker.workers.dev/?query=mountain,sunset

# Collection
https://your-worker.workers.dev/?collections=1065976
```

### Common Commands

```bash
# Deploy changes
npm run deploy

# View logs
wrangler tail

# Check cache
wrangler kv:key get --binding=UNSPLASH_CACHE_METADATA "default"

# List cached images
wrangler r2 object list unsplash-cache
```

## Support

If you encounter issues:

1. Check the troubleshooting section above
2. Review `DEPLOYMENT.md` for detailed guidance
3. Check logs with `wrangler tail`
4. Review Cloudflare Workers docs: https://developers.cloudflare.com/workers/

## Congratulations! 🎉

Your Unsplash Worker is now serving beautiful random images with intelligent caching!

