import { createRoot } from 'react-dom/client'
import { App } from './App'
import './settings.css'

const root = document.getElementById('root')
if (!root) throw new Error('找不到设置页挂载点')
createRoot(root).render(<App />)
