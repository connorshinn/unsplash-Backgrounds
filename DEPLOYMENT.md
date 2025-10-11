# Deployment Guide

This guide walks you through deploying the Unsplash Cloudflare Worker.

## Prerequisites

1. **Cloudflare Account**: Sign up at https://cloudflare.com
2. **Wrangler CLI**: Install globally
   ```bash
   npm install -g wrangler
   ```
3. **Authenticate Wrangler**:
   ```bash
   wrangler login
   ```

## Step 1: Create Required Resources

### 1.1 Create R2 Bucket

```bash
wrangler r2 bucket create unsplash-cache
```

Expected output:
```
✅ Created bucket 'unsplash-cache'
```

### 1.2 Create KV Namespace

```bash
wrangler kv:namespace create "UNSPLASH_CACHE_METADATA"
```

Expected output:
```
✅ Created namespace with id "abc123def456..."
```

**Important**: Copy the namespace ID from the output.

### 1.3 Update wrangler.toml

Edit `wrangler.toml` and replace `YOUR_KV_NAMESPACE_ID` with the actual namespace ID:

```toml
[[kv_namespaces]]
binding = "UNSPLASH_CACHE_METADATA"
id = "abc123def456..."  # Replace with your actual ID
```

### 1.4 Get Unsplash API Access Key

1. Go to https://unsplash.com/developers
2. Click "Register as a developer"
3. Create a new application
4. Copy the "Access Key" (not the Secret Key)

### 1.5 Set Unsplash API Secret

```bash
wrangler secret put UNSPLASH_ACCESS_KEY
```

When prompted, paste your Unsplash Access Key and press Enter.

## Step 2: Install Dependencies

```bash
npm install
```

## Step 3: Test Locally (Optional)

```bash
npm run dev
```

This starts a local development server. You can test the worker at `http://localhost:8787`

**Note**: Local development requires the R2 and KV resources to be created first.

## Step 4: Deploy to Cloudflare

```bash
npm run deploy
```

Expected output:
```
✅ Uploaded unsplash-worker
✅ Published unsplash-worker
   https://unsplash-worker.your-subdomain.workers.dev
```

## Step 5: Verify Deployment

### 5.1 Test Basic Functionality

Visit your worker URL in a browser:
```
https://unsplash-worker.your-subdomain.workers.dev/
```

You should be redirected to an Unsplash image (first request = cache miss).

### 5.2 Test Cache Hit

Refresh the page. You should now see:
- Image loads directly (no redirect)
- Response is faster
- Check browser dev tools → Network tab → Headers:
  - `X-Cache-Status: HIT`
  - `X-Unsplash-Photographer: [name]`

### 5.3 Test Different Parameters

Try these URLs:
```
https://unsplash-worker.your-subdomain.workers.dev/?topics=nature
https://unsplash-worker.your-subdomain.workers.dev/?query=mountain
https://unsplash-worker.your-subdomain.workers.dev/?collections=1234567
```

### 5.4 Verify Cache in Cloudflare Dashboard

1. Go to Cloudflare Dashboard → R2
2. Click on `unsplash-cache` bucket
3. You should see 10 images stored (after first request completes)

## Step 6: Monitor

### Check Logs

```bash
wrangler tail
```

This shows real-time logs from your worker.

### Check Metrics

Go to Cloudflare Dashboard → Workers & Pages → unsplash-worker → Metrics

Monitor:
- Request count
- Error rate
- Execution time

## Troubleshooting

### Error: "R2 bucket not configured"

- Verify the R2 bucket exists: `wrangler r2 bucket list`
- Check `wrangler.toml` has correct binding

### Error: "KV namespace not configured"

- Verify the KV namespace exists: `wrangler kv:namespace list`
- Check `wrangler.toml` has correct namespace ID

### Error: "Unsplash API key not configured"

- Set the secret: `wrangler secret put UNSPLASH_ACCESS_KEY`
- Verify it's set: `wrangler secret list`

### Images not loading

- Check browser console for errors
- Check worker logs: `wrangler tail`
- Verify Unsplash API key is valid
- Check Unsplash API rate limits (50/hour for demo, 5000/hour for production)

### Cache not populating

- Wait a few seconds after first request (background processing)
- Check R2 bucket in dashboard
- Check worker logs for errors

## Updating the Worker

After making code changes:

```bash
npm run deploy
```

The worker will be updated immediately.

## Custom Domain (Optional)

To use a custom domain:

1. Go to Cloudflare Dashboard → Workers & Pages → unsplash-worker
2. Click "Triggers" tab
3. Click "Add Custom Domain"
4. Enter your domain (must be on Cloudflare)
5. Click "Add Custom Domain"

## Cost Estimation

Based on Cloudflare's pricing (as of 2024):

- **Workers**: 100,000 requests/day free, then $0.50/million requests
- **R2 Storage**: 10 GB free, then $0.015/GB/month
- **R2 Operations**: Class A (writes) 1M free/month, Class B (reads) 10M free/month
- **KV**: 100,000 reads/day free, 1,000 writes/day free

For typical usage (1000 requests/day):
- Workers: Free
- R2 Storage: ~1 MB (10 images) = Free
- R2 Operations: ~1000 reads/day = Free
- KV: ~1000 reads/day, ~125 writes/day = Free

**Total estimated cost: $0/month** for typical usage.

## Next Steps

- Set up monitoring and alerts
- Configure custom domain
- Adjust cache refresh threshold if needed
- Monitor Unsplash API usage
- Consider upgrading Unsplash API plan for higher rate limits

## Support

For issues:
- Check Cloudflare Workers documentation: https://developers.cloudflare.com/workers/
- Check Unsplash API documentation: https://unsplash.com/documentation
- Review worker logs: `wrangler tail`

