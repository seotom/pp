// tailwind.config.ts
import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // Здесь можно будет добавлять свои стили в будущем
    },
  },
  plugins: [
    require('@tailwindcss/typography'), // ✅ Плагин уже здесь
  ],
}
export default config
