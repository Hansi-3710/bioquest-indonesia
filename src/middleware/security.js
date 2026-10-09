import helmet from 'helmet';
import { config } from '../config.js';

// A strict Content-Security-Policy: no inline scripts, no inline <style> blocks,
// no third-party origins at all. Fonts are self-hosted.
export const securityHeaders = [
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        // Inline style="" attributes only (cannot run code). Scripts and <style> blocks stay locked to our own files.
        'style-src-attr': ["'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'media-src': ["'self'", 'blob:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'manifest-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        ...(config.isProd ? { 'upgrade-insecure-requests': [] } : {})
      }
    },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: config.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    xFrameOptions: { action: 'deny' }
  }),
  (req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(), payment=(), usb=(), interest-cohort=()');
    next();
  }
];

export const noStore = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
};
