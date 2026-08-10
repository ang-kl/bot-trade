import { createContext } from 'react'

// A Card owns the chrome for its whole section: content-kind, expand,
// collapse and copy. Header helpers such as SectionTools can consume this
// context to avoid rendering a second copy/expand pair inside the same card.
export const CardChromeContext = createContext(false)
