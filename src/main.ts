import { createApp } from 'vue'
import App from './ui/App.vue'
import { applyTheme, cachedTheme } from './application/appearance'
import { desktopApi } from './platform/api'
import './ui/theme.css'
import './ui/extra.css'

applyTheme(cachedTheme(), false)
createApp(App).mount('#app')

void desktopApi()?.appAppearanceGet()
  .then(settings => applyTheme(settings.theme))
  .catch(() => {})
