/// <reference types="vite/client" />

// Minimal typing for the preload bridge (expanded in Session 2).
interface Window {
  api: {
    ready: boolean
  }
}
