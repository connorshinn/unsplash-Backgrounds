# Responsive Image Sizing Guide

The Unsplash Worker now supports automatic image resizing based on viewport dimensions!

## How It Works

### Query Parameters

Add `w` (width) and `h` (height) parameters to request images sized for specific dimensions:

```
https://your-worker.workers.dev/?w=1920&h=1080
https://your-worker.workers.dev/?topics=nature&w=1366&h=768
https://your-worker.workers.dev/?query=mountain&w=2560&h=1440
```

### Caching Behavior

- **Different sizes are cached separately**: `?w=1920&h=1080` creates a different cache than `?w=1366&h=768`
- **Common viewport sizes get cached**: Popular resolutions (1920x1080, 1366x768, etc.) will be cached for fast delivery
- **Works for both cache hits and misses**: Images are resized whether served from R2 or redirected from Unsplash

## Usage Examples

### 1. Manual URL Construction

```html
<!-- Full HD background -->
<div style="background-image: url('https://your-worker.workers.dev/?w=1920&h=1080&topics=nature')">
</div>

<!-- Mobile-optimized -->
<img src="https://your-worker.workers.dev/?w=375&h=667&query=sunset" alt="Sunset">
```

### 2. Automatic Viewport Detection (Recommended)

Use the provided JavaScript snippet to automatically detect and send viewport dimensions:

```html
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            background-size: cover;
            background-position: center;
        }
    </style>
</head>
<body>
    <script>
        // Get viewport dimensions
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        // Build URL with dimensions
        const imageUrl = `https://your-worker.workers.dev/?w=${width}&h=${height}&topics=nature`;
        
        // Set as background
        document.body.style.backgroundImage = `url('${imageUrl}')`;
    </script>
</body>
</html>
```

### 3. Complete Responsive Example

See `client-example.html` for a full working example that:
- Automatically detects viewport size
- Updates background on window resize
- Shows current dimensions and image URL
- Includes debouncing to avoid excessive requests

### 4. React Example

```jsx
import { useEffect, useState } from 'react';

function BackgroundImage() {
  const [imageUrl, setImageUrl] = useState('');
  
  useEffect(() => {
    const updateImage = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const url = `https://your-worker.workers.dev/?w=${width}&h=${height}&topics=nature`;
      setImageUrl(url);
    };
    
    updateImage();
    
    // Update on resize (debounced)
    let timeout;
    const handleResize = () => {
      clearTimeout(timeout);
      timeout = setTimeout(updateImage, 1000);
    };
    
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      backgroundImage: `url('${imageUrl}')`,
      backgroundSize: 'cover',
      backgroundPosition: 'center'
    }} />
  );
}
```

### 5. CSS Background with JavaScript

```html
<style>
  .hero {
    width: 100%;
    height: 100vh;
    background-size: cover;
    background-position: center;
  }
</style>

<div class="hero" id="hero"></div>

<script>
  const hero = document.getElementById('hero');
  const w = window.innerWidth;
  const h = window.innerHeight;
  hero.style.backgroundImage = `url('https://your-worker.workers.dev/?w=${w}&h=${h}&topics=travel')`;
</script>
```

## Common Viewport Sizes

Here are common viewport sizes you might want to cache:

### Desktop
- **Full HD**: `?w=1920&h=1080`
- **HD**: `?w=1366&h=768`
- **WXGA**: `?w=1280&h=720`
- **4K**: `?w=3840&h=2160`
- **MacBook Pro 16"**: `?w=3072&h=1920`

### Tablet
- **iPad Pro 12.9"**: `?w=2048&h=2732`
- **iPad**: `?w=1536&h=2048`
- **iPad Mini**: `?w=1536&h=2048`

### Mobile
- **iPhone 14 Pro Max**: `?w=430&h=932`
- **iPhone 14**: `?w=390&h=844`
- **Samsung Galaxy S23**: `?w=360&h=780`

## Performance Considerations

### Cache Efficiency

**Problem**: Too many different sizes = too many cache variations

**Solution**: Round to common sizes

```javascript
// Round to nearest common width
function roundToCommonSize(width, height) {
  const commonWidths = [375, 768, 1024, 1366, 1920, 2560, 3840];
  const roundedWidth = commonWidths.reduce((prev, curr) => 
    Math.abs(curr - width) < Math.abs(prev - width) ? curr : prev
  );
  
  // Calculate proportional height
  const aspectRatio = height / width;
  const roundedHeight = Math.round(roundedWidth * aspectRatio);
  
  return { width: roundedWidth, height: roundedHeight };
}

// Usage
const viewport = getViewportDimensions();
const { width, height } = roundToCommonSize(viewport.width, viewport.height);
const imageUrl = `https://your-worker.workers.dev/?w=${width}&h=${height}`;
```

### Debouncing Resize Events

Always debounce resize events to avoid excessive requests:

```javascript
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

window.addEventListener('resize', debounce(() => {
  updateBackground();
}, 1000)); // Wait 1 second after resize stops
```

### Preloading

Preload images for faster display:

```javascript
function preloadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(url);
    img.onerror = reject;
    img.src = url;
  });
}

// Usage
const imageUrl = buildImageUrl();
preloadImage(imageUrl).then(url => {
  document.body.style.backgroundImage = `url('${url}')`;
});
```

## API Reference

### Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `w` | integer | Image width in pixels | `w=1920` |
| `h` | integer | Image height in pixels | `h=1080` |
| `topics` | string | Unsplash topic slug(s) | `topics=nature` |
| `query` | string | Search query | `query=mountain` |
| `collections` | string | Collection ID(s) | `collections=1065976` |

### Combining Parameters

```
# Nature images at 1920x1080
?topics=nature&w=1920&h=1080

# Mountain search at 1366x768
?query=mountain&w=1366&h=768

# Collection at 4K resolution
?collections=1065976&w=3840&h=2160
```

## Cache Key Examples

Different parameter combinations create different caches:

```
# Different caches (different sizes)
?topics=nature&w=1920&h=1080  → cache key: height=1080&topics=nature&width=1920
?topics=nature&w=1366&h=768   → cache key: height=768&topics=nature&width=1366

# Same cache (same parameters)
?topics=nature&w=1920&h=1080  → cache key: height=1080&topics=nature&width=1920
?w=1920&h=1080&topics=nature  → cache key: height=1080&topics=nature&width=1920 (same!)
```

## Testing

### Test Different Sizes

```bash
# Full HD
curl -I "https://your-worker.workers.dev/?w=1920&h=1080"

# HD
curl -I "https://your-worker.workers.dev/?w=1366&h=768"

# Mobile
curl -I "https://your-worker.workers.dev/?w=375&h=667"
```

### Verify Image Dimensions

Check the `Location` header in cache miss responses to see the Unsplash URL with dimensions:

```bash
curl -I "https://your-worker.workers.dev/?w=1920&h=1080&topics=nature"
```

Look for: `location: https://images.unsplash.com/...?w=1920&h=1080&...`

## Troubleshooting

### Images appear stretched or cropped

The worker uses `fit=crop` to ensure images fill the specified dimensions. This may crop some images.

**Solution**: Use aspect ratios that match common photo ratios (16:9, 4:3, etc.)

### Too many cache variations

If you're getting too many cache misses, you're probably requesting too many different sizes.

**Solution**: Round viewport dimensions to common sizes (see Performance Considerations above)

### Images not updating on resize

Make sure you're using debouncing and actually updating the background image.

**Solution**: See the complete example in `client-example.html`

## Best Practices

1. **Round to common sizes** to improve cache hit rate
2. **Debounce resize events** to avoid excessive requests
3. **Use aspect ratios** that match common photo ratios
4. **Preload images** for smoother transitions
5. **Test on multiple devices** to ensure good performance
6. **Monitor cache hit rate** in Cloudflare dashboard

## Examples in the Wild

Check out `client-example.html` for a complete working example you can use as a starting point!

## Questions?

If you have questions or need help implementing responsive images, check the main README.md or open an issue.

