# Viewing Image Metadata

The Unsplash Worker now includes detailed metadata in response headers that you can view in your browser!

## Metadata Included

Every response includes these custom headers:

| Header | Description | Example |
|--------|-------------|---------|
| `X-Cache-Status` | Whether image was cached | `HIT` or `MISS` |
| `X-Image-Width` | Image width in pixels | `1920` or `auto` |
| `X-Image-Height` | Image height in pixels | `1080` or `auto` |
| `X-Image-File-Size` | File size in bytes | `245678` |
| `X-Image-File-Size-KB` | File size in KB | `239.92` |
| `X-Image-File-Size-MB` | File size in MB | `0.23` |
| `X-Unsplash-Category` | Image category/filter | `topics: nature` or `random` |
| `X-Unsplash-Photographer` | Photographer name | `John Doe` |
| `X-Image-Source-URL` | Unsplash photo page | `https://unsplash.com/photos/abc123` |

## Method 1: Browser Developer Tools

### Chrome/Edge
1. Open Developer Tools (F12 or Right-click → Inspect)
2. Go to **Network** tab
3. Visit your worker URL: `https://unsplash-worker.connor-shinn.workers.dev/`
4. Click on the request in the Network tab
5. Click **Headers** section
6. Scroll down to **Response Headers**
7. Look for headers starting with `X-Image-` and `X-Unsplash-`

### Firefox
1. Open Developer Tools (F12)
2. Go to **Network** tab
3. Visit your worker URL
4. Click on the request
5. Click **Headers** tab
6. View **Response Headers**

### Safari
1. Enable Developer menu (Preferences → Advanced → Show Develop menu)
2. Open Web Inspector (Cmd+Option+I)
3. Go to **Network** tab
4. Visit your worker URL
5. Click on the request
6. View **Response** section

## Method 2: Using cURL

View headers directly from command line:

```bash
# View all headers
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?topics=nature&w=1920&h=1080"

# Filter for metadata headers only
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?topics=nature" | grep "X-"
```

Example output:
```
HTTP/2 200
content-type: image/jpeg
x-cache-status: HIT
x-unsplash-photographer: John Doe
x-image-width: 1920
x-image-height: 1080
x-image-source-url: https://unsplash.com/photos/abc123
x-image-file-size: 245678
x-image-file-size-kb: 239.92
x-image-file-size-mb: 0.23
x-unsplash-category: topics: nature
```

## Method 3: Interactive Metadata Viewer

Use the included `view-headers-example.html` file:

1. Open `view-headers-example.html` in your browser
2. The worker URL should already be filled in
3. (Optional) Select a filter type and value
4. (Optional) Enter dimensions or click "Auto-detect Viewport Size"
5. Click "Load Image & View Metadata"
6. View the image and all metadata in a nice interface!

**Features:**
- Visual display of all metadata
- Image preview
- Automatic viewport detection
- Easy testing of different parameters
- Metadata also logged to browser console

## Method 4: JavaScript Fetch API

Programmatically access headers in your code:

```javascript
async function getImageMetadata(url) {
  const response = await fetch(url);
  
  const metadata = {
    cacheStatus: response.headers.get('X-Cache-Status'),
    width: response.headers.get('X-Image-Width'),
    height: response.headers.get('X-Image-Height'),
    fileSize: response.headers.get('X-Image-File-Size'),
    fileSizeKB: response.headers.get('X-Image-File-Size-KB'),
    fileSizeMB: response.headers.get('X-Image-File-Size-MB'),
    category: response.headers.get('X-Unsplash-Category'),
    photographer: response.headers.get('X-Unsplash-Photographer'),
    sourceUrl: response.headers.get('X-Image-Source-URL')
  };
  
  console.log('Image Metadata:', metadata);
  return metadata;
}

// Usage
const url = 'https://unsplash-worker.connor-shinn.workers.dev/?topics=nature&w=1920&h=1080';
getImageMetadata(url);
```

## Method 5: React Hook

```javascript
import { useState, useEffect } from 'react';

function useImageMetadata(imageUrl) {
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    async function fetchMetadata() {
      try {
        const response = await fetch(imageUrl);
        const meta = {
          cacheStatus: response.headers.get('X-Cache-Status'),
          width: response.headers.get('X-Image-Width'),
          height: response.headers.get('X-Image-Height'),
          fileSize: response.headers.get('X-Image-File-Size-MB') + ' MB',
          category: response.headers.get('X-Unsplash-Category'),
          photographer: response.headers.get('X-Unsplash-Photographer'),
          sourceUrl: response.headers.get('X-Image-Source-URL')
        };
        setMetadata(meta);
      } catch (error) {
        console.error('Error fetching metadata:', error);
      } finally {
        setLoading(false);
      }
    }
    
    fetchMetadata();
  }, [imageUrl]);
  
  return { metadata, loading };
}

// Usage in component
function ImageWithMetadata() {
  const imageUrl = 'https://unsplash-worker.connor-shinn.workers.dev/?topics=nature';
  const { metadata, loading } = useImageMetadata(imageUrl);
  
  if (loading) return <div>Loading...</div>;
  
  return (
    <div>
      <img src={imageUrl} alt="Random" />
      <div>
        <p>Photographer: {metadata.photographer}</p>
        <p>Size: {metadata.width}x{metadata.height}</p>
        <p>File Size: {metadata.fileSize}</p>
        <p>Category: {metadata.category}</p>
        <a href={metadata.sourceUrl}>View on Unsplash</a>
      </div>
    </div>
  );
}
```

## Example Metadata

### Cache Hit (Image from R2)
```
X-Cache-Status: HIT
X-Image-Width: 1920
X-Image-Height: 1080
X-Image-File-Size: 245678
X-Image-File-Size-KB: 239.92
X-Image-File-Size-MB: 0.23
X-Unsplash-Category: topics: nature
X-Unsplash-Photographer: Jane Smith
X-Image-Source-URL: https://unsplash.com/photos/abc123xyz
```

### Cache Miss (Redirect to Unsplash)
```
X-Cache-Status: MISS
X-Image-Width: 1920
X-Image-Height: 1080
X-Image-File-Size: unknown
X-Unsplash-Category: query: mountain
X-Unsplash-Photographer: John Doe
X-Image-Source-URL: https://unsplash.com/photos/def456uvw
```

## Testing Different Scenarios

### Random Image
```bash
curl -I "https://unsplash-worker.connor-shinn.workers.dev/"
```

### With Topics
```bash
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?topics=nature"
```

### With Query
```bash
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?query=mountain"
```

### With Dimensions
```bash
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?topics=nature&w=1920&h=1080"
```

### With Collections
```bash
curl -I "https://unsplash-worker.connor-shinn.workers.dev/?collections=1065976"
```

## Cloudflare Console Logs

The worker also logs metadata to the Cloudflare console. View with:

```bash
wrangler tail
```

Then make a request and you'll see:
```
=== CACHE HIT ===
File Dimensions: 1920x1080
Source URL: https://unsplash.com/photos/abc123
File Size: 0.23 MB (245678 bytes)
Unsplash Category: topics: nature
Photographer: Jane Smith
================
```

## Notes

- **File size is only available for cache hits** - When redirecting (cache miss), the file hasn't been downloaded yet
- **Dimensions show "auto"** if not specified in the request
- **Category shows "random"** if no filter parameters are used
- **All headers are CORS-enabled** so you can access them from any domain

## Privacy

The metadata headers are:
- ✅ Safe to expose publicly
- ✅ Don't contain sensitive information
- ✅ Help with debugging and monitoring
- ✅ Provide proper attribution to photographers

## Troubleshooting

### Headers not showing up

**Problem**: Can't see the custom headers

**Solutions**:
- Make sure you're looking at **Response Headers**, not Request Headers
- Check that you've deployed the latest version: `npm run deploy`
- Try a hard refresh (Ctrl+Shift+R or Cmd+Shift+R)
- Use cURL to verify: `curl -I https://your-worker.workers.dev/`

### File size shows "unknown"

**Problem**: `X-Image-File-Size: unknown`

**Explanation**: This happens on cache miss (redirect). The worker doesn't download the image on cache miss, so file size isn't available. Make a second request (cache hit) to see the file size.

### Metadata shows old values

**Problem**: Metadata doesn't match current request

**Solution**: Clear your browser cache or use Incognito/Private mode

## Best Practices

1. **Use the metadata for debugging** - Check cache status, file sizes, etc.
2. **Display photographer attribution** - Use `X-Unsplash-Photographer` to credit photographers
3. **Link to source** - Use `X-Image-Source-URL` to link back to Unsplash
4. **Monitor cache hit rate** - Track `X-Cache-Status` to optimize caching
5. **Log metadata for analytics** - Track popular categories, average file sizes, etc.

## Questions?

If you have questions about the metadata or need help accessing it, check the main README.md or deployment guide.

