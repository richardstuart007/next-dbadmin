import './globals.css'

import { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'DB Admin',
  description: 'Local database admin tool',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang='en'>
      <body className='bg-gray-50 min-h-screen'>
        {children}
      </body>
    </html>
  )
}
