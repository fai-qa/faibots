import { useEffect } from 'react'
import { useData } from '../store/data'

/** Apply the theme setting (system / light / dark) as the `dark` class on <html>. */
export function useTheme(): void {
  const theme = useData((s) => s.settings?.theme ?? 'system')
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      document.documentElement.classList.toggle('dark', dark)
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}
