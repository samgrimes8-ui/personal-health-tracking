import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      // Disable workbox caching during development — re-enable before App Store launch
      // The aggressive caching was preventing updates from reaching users
      injectRegister: 'script',
      workbox: {
        globPatterns: [],             // Cache nothing
        navigateFallback: null,        // No offline fallback
        runtimeCaching: [],            // No runtime caching
        cleanupOutdatedCaches: true,   // Clear old caches
        skipWaiting: true,             // New SW takes over immediately
        clientsClaim: true,            // Controls all open tabs immediately
      },
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'MacroLens',
        short_name: 'MacroLens',
        description: 'AI-powered nutrition tracker',
        theme_color: '#0f0e0d',
        background_color: '#0f0e0d',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
