import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import ThemeProvider from './lib/theme.jsx'
import StrategyProvider from './lib/strategy-store.jsx'
import './index.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <StrategyProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrategyProvider>
    </ThemeProvider>
  </StrictMode>,
)
