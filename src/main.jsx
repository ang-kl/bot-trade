import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import ThemeProvider from './lib/theme.jsx'
import './index.css'
import { installPreloadRecovery } from './lib/preload-recovery.js'

// A deploy swaps every hashed chunk; an open tab's next lazy navigation then
// fails with "Importing a module script failed" and strands on a dead
// Suspense boundary. One guarded reload fixes what a stack trace cannot.
installPreloadRecovery()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
)
